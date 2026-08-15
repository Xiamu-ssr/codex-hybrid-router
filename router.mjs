#!/usr/bin/env node

import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import os from "node:os";
import fs from "node:fs";
import zlib from "node:zlib";
import { StringDecoder } from "node:string_decoder";
import {
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { spawnSync } from "node:child_process";
import WebSocket, { WebSocketServer } from "ws";
import { AnthropicResponsesBridge } from "./lib/anthropic-responses-bridge.mjs";
import { appendFinalizerHandoff } from "./lib/finalizer-handoff.mjs";
import {
  AsyncLruCache,
  compactionCacheKey,
  latestNativeCompactionPrefix,
} from "./lib/native-compaction-cache.mjs";

const HOST = process.env.CODEX_ROUTER_HOST || "127.0.0.1";
const PORT = Number(process.env.CODEX_ROUTER_PORT || 10100);
const PROXY_HOST = process.env.CODEX_ROUTER_PROXY_HOST || "";
const PROXY_PORT = Number(process.env.CODEX_ROUTER_PROXY_PORT || 0);
const CODEX_HOME = process.env.CODEX_HOME || `${os.homedir()}/.codex`;
const CONFIG_PATH =
  process.env.CODEX_ROUTER_CONFIG || `${CODEX_HOME}/hybrid-router.json`;
const MODEL_CATALOG =
  process.env.CODEX_ROUTER_MODEL_CATALOG || `${CODEX_HOME}/model-catalog.json`;
const COMPACT_MODEL = process.env.CODEX_ROUTER_COMPACT_MODEL || "gpt-5.6-luna";
const COMPACT_EFFORT = process.env.CODEX_ROUTER_COMPACT_EFFORT || "max";
const configuredHybridKeepaliveMs = Number(
  process.env.CODEX_ROUTER_HYBRID_KEEPALIVE_MS || 30_000,
);
const HYBRID_KEEPALIVE_MS = Number.isFinite(configuredHybridKeepaliveMs)
  ? Math.max(1_000, configuredHybridKeepaliveMs)
  : 30_000;
const LOCAL_COMPACTION_PREFIX = "codex-hybrid-summary-v1:";
const COMPACT_SECRET_PATH = `${CODEX_HOME}/zenmux-router/compact-secret`;
const EXPECTED_UPSTREAM_CLOSE = Symbol("expected-upstream-close");
const nativeCompactionBridgeCache = new AsyncLruCache(64);

const DEFAULT_ROUTER_CONFIG = {
  external_provider: {
    name: "ZenMux",
    base_url: "https://zenmux.ai/api/v1",
    anthropic_base_url: "https://zenmux.ai/api/anthropic",
    api_key_env: "ZENMUX_API_KEY",
    keychain_service: "dev.codex-hybrid-router.zenmux",
    keychain_account: os.userInfo().username,
    send_authorization: true,
    send_x_api_key: true,
    headers: {},
  },
  external_models: {
    "zenmux/claude-opus-5": {
      upstream_model: "claude-opus-5",
      compatibility: "claude",
      api_protocol: "anthropic_messages",
      prompt_cache: { enabled: true, ttl: "5m" },
    },
    "zenmux/kimi-k3": {
      upstream_model: "kimi-k3",
      compatibility: "kimi",
    },
    "zenmux/grok-4.6": {
      upstream_model: "grok-4.6",
      compatibility: "grok",
    },
  },
  hybrid_final_models: {
    "hybrid/gpt-5.6-sol-claude-final": {
      agent_model: "gpt-5.6-sol",
      agent_service_tier: "priority",
      finalizer_model: "claude-opus-5",
      finalizer_compatibility: "claude",
    },
  },
};

function loadRouterConfig() {
  let configured = {};
  try {
    configured = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw new Error(`Could not read router config ${CONFIG_PATH}: ${error.message}`);
    }
  }
  const provider = {
    ...DEFAULT_ROUTER_CONFIG.external_provider,
    ...(configured.external_provider || {}),
  };
  provider.headers = {
    ...DEFAULT_ROUTER_CONFIG.external_provider.headers,
    ...(configured.external_provider?.headers || {}),
  };
  return {
    external_provider: provider,
    external_models:
      configured.external_models || DEFAULT_ROUTER_CONFIG.external_models,
    hybrid_final_models:
      configured.hybrid_final_models || DEFAULT_ROUTER_CONFIG.hybrid_final_models,
  };
}

const ROUTER_CONFIG = loadRouterConfig();
const EXTERNAL_PROVIDER = ROUTER_CONFIG.external_provider;
const EXTERNAL_BASE_URL = new URL(EXTERNAL_PROVIDER.base_url);
if (EXTERNAL_BASE_URL.protocol !== "https:") {
  throw new Error("external_provider.base_url must use https://");
}
const EXTERNAL_ANTHROPIC_BASE_URL = EXTERNAL_PROVIDER.anthropic_base_url
  ? new URL(EXTERNAL_PROVIDER.anthropic_base_url)
  : null;
if (
  EXTERNAL_ANTHROPIC_BASE_URL &&
  EXTERNAL_ANTHROPIC_BASE_URL.protocol !== "https:"
) {
  throw new Error("external_provider.anthropic_base_url must use https://");
}
const KEYCHAIN_SERVICE = EXTERNAL_PROVIDER.keychain_service;
const KEYCHAIN_ACCOUNT =
  EXTERNAL_PROVIDER.keychain_account || os.userInfo().username;
const EXTERNAL_MODELS = new Map(
  Object.entries(ROUTER_CONFIG.external_models).map(([slug, definition]) => [
    slug,
    typeof definition === "string"
      ? { upstream_model: definition, compatibility: "generic" }
      : definition,
  ]),
);
const HYBRID_FINAL_MODELS = new Map(
  Object.entries(ROUTER_CONFIG.hybrid_final_models),
);
for (const [slug, definition] of EXTERNAL_MODELS) {
  if (!slug || typeof definition?.upstream_model !== "string") {
    throw new Error(`external model ${slug || "<empty>"} has no upstream_model`);
  }
}
for (const [slug, definition] of HYBRID_FINAL_MODELS) {
  if (
    !slug ||
    typeof definition?.agent_model !== "string" ||
    typeof definition?.finalizer_model !== "string"
  ) {
    throw new Error(
      `hybrid model ${slug || "<empty>"} requires agent_model and finalizer_model`,
    );
  }
}

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

let cachedExternalKey = null;
let cachedCompactSecret = null;

function now() {
  return new Date().toISOString();
}

function log(message) {
  process.stderr.write(`${now()} ${message}\n`);
}

function sendJson(res, statusCode, value) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(statusCode, {
    "content-type": "application/json",
    "content-length": String(body.length),
  });
  res.end(body);
}

function errorBody(message, code = "codex_router_error") {
  return { error: { message, type: "invalid_request_error", code } };
}

function readExternalKey() {
  if (cachedExternalKey) return cachedExternalKey;
  const envName = EXTERNAL_PROVIDER.api_key_env;
  if (envName && process.env[envName]?.trim()) {
    cachedExternalKey = process.env[envName].trim();
    return cachedExternalKey;
  }

  if (!KEYCHAIN_SERVICE || process.platform !== "darwin") {
    throw new Error(
      `External provider key is unavailable; set ${envName || "the configured API key environment variable"}`,
    );
  }
  const result = spawnSync(
    "/usr/bin/security",
    [
      "find-generic-password",
      "-a",
      KEYCHAIN_ACCOUNT,
      "-s",
      KEYCHAIN_SERVICE,
      "-w",
    ],
    { encoding: "utf8", timeout: 5000 },
  );
  if (result.status !== 0 || !result.stdout?.trim()) {
    throw new Error(
      `External provider key is unavailable; set ${envName || "the configured API key environment variable"} ` +
        `or install it in Keychain service ${KEYCHAIN_SERVICE}`,
    );
  }
  cachedExternalKey = result.stdout.trim();
  return cachedExternalKey;
}

function loadCatalog() {
  const parsed = JSON.parse(fs.readFileSync(MODEL_CATALOG, "utf8"));
  if (!Array.isArray(parsed.models)) throw new Error("model catalog has no models array");
  return parsed.models;
}

function readCompactSecret() {
  if (cachedCompactSecret) return cachedCompactSecret;
  try {
    cachedCompactSecret = fs.readFileSync(COMPACT_SECRET_PATH);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    const secret = randomBytes(32);
    fs.writeFileSync(COMPACT_SECRET_PATH, secret, { mode: 0o600, flag: "wx" });
    cachedCompactSecret = secret;
  }
  return cachedCompactSecret;
}

function classifyModel(model) {
  if (HYBRID_FINAL_MODELS.has(model)) {
    const hybrid = HYBRID_FINAL_MODELS.get(model);
    return {
      route: "hybrid_final",
      upstreamModel: hybrid.agent_model,
      agentServiceTier: hybrid.agent_service_tier,
      finalizerModel: hybrid.finalizer_model,
      finalizerCompatibility:
        hybrid.finalizer_compatibility || "generic",
    };
  }
  if (EXTERNAL_MODELS.has(model)) {
    const external = EXTERNAL_MODELS.get(model);
    return {
      route: "external",
      upstreamModel: external.upstream_model,
      compatibility: external.compatibility || "generic",
      apiProtocol: external.api_protocol || "responses",
      promptCache: external.prompt_cache || null,
    };
  }
  if (
    typeof model === "string" &&
    (model.startsWith("gpt-") || model === "codex-auto-review")
  ) {
    return { route: "chatgpt", upstreamModel: model };
  }
  return null;
}

function requestPath(url) {
  const parsed = new URL(url || "/", `http://${HOST}:${PORT}`);
  return `${parsed.pathname}${parsed.search}`;
}

function isExternalRoute(route) {
  return route === "external" || route === "external_anthropic";
}

function targetFor(route, incomingPath) {
  const parsed = new URL(incomingPath, `http://${HOST}:${PORT}`);
  const suffix = parsed.pathname.replace(/^\/v1/, "");
  if (route === "external_anthropic") {
    if (!EXTERNAL_ANTHROPIC_BASE_URL) {
      throw new Error(
        "external_provider.anthropic_base_url is required for anthropic_messages models",
      );
    }
    const basePath = EXTERNAL_ANTHROPIC_BASE_URL.pathname.replace(/\/$/, "");
    return {
      hostname: EXTERNAL_ANTHROPIC_BASE_URL.hostname,
      port: Number(EXTERNAL_ANTHROPIC_BASE_URL.port || 443),
      path: `${basePath}${parsed.pathname}${parsed.search}`,
    };
  }
  if (route === "external") {
    const basePath = EXTERNAL_BASE_URL.pathname.replace(/\/$/, "");
    return {
      hostname: EXTERNAL_BASE_URL.hostname,
      port: Number(EXTERNAL_BASE_URL.port || 443),
      path: `${basePath}${suffix}${parsed.search}`,
    };
  }
  return {
    hostname: "chatgpt.com",
    port: 443,
    path: `/backend-api/codex${suffix}${parsed.search}`,
  };
}

function upstreamHeaders(req, route, hostname, bodyLength) {
  const headers = {};
  for (const [rawName, rawValue] of Object.entries(req.headers)) {
    const name = rawName.toLowerCase();
    if (
      HOP_BY_HOP.has(name) ||
      name === "host" ||
      name === "content-length" ||
      name === "content-encoding" ||
      name.startsWith("sec-websocket-") ||
      rawValue == null
    ) {
      continue;
    }
    if (
      isExternalRoute(route) &&
      (name === "authorization" ||
        name === "x-api-key" ||
        name === "chatgpt-account-id" ||
        name === "openai-organization" ||
        name === "openai-project")
    ) {
      continue;
    }
    headers[rawName] = rawValue;
  }

  headers.host = hostname;
  headers["content-length"] = String(bodyLength);
  if (isExternalRoute(route)) {
    const apiKey = readExternalKey();
    if (EXTERNAL_PROVIDER.send_authorization !== false) {
      headers.authorization = `Bearer ${apiKey}`;
    }
    if (EXTERNAL_PROVIDER.send_x_api_key === true) {
      headers["x-api-key"] = apiKey;
    }
    for (const [name, value] of Object.entries(EXTERNAL_PROVIDER.headers || {})) {
      headers[name] = String(value);
    }
  }
  return headers;
}

class ClashHttpsAgent extends https.Agent {
  createConnection(options, callback) {
    const hostname = options.servername || options.hostname || options.host;
    const port = Number(options.port || 443);
    const connect = http.request({
      host: PROXY_HOST,
      port: PROXY_PORT,
      method: "CONNECT",
      path: `${hostname}:${port}`,
      headers: { host: `${hostname}:${port}` },
    });

    connect.once("connect", (response, socket, head) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        callback(new Error(`proxy CONNECT returned ${response.statusCode}`));
        return;
      }
      if (head.length) socket.unshift(head);
      const secureSocket = tls.connect({
        socket,
        servername: hostname,
        ALPNProtocols: ["http/1.1"],
      });
      secureSocket.once("secureConnect", () => callback(null, secureSocket));
      secureSocket.once("error", callback);
    });
    connect.once("error", callback);
    connect.setTimeout(10_000, () => connect.destroy(new Error("proxy CONNECT timed out")));
    connect.end();
    return undefined;
  }
}

const upstreamHttpsAgent = PROXY_HOST && PROXY_PORT
  ? new ClashHttpsAgent({ keepAlive: true, maxSockets: 16 })
  : new https.Agent({ keepAlive: true, maxSockets: 16 });

async function forward(req, res, route, body, model, upstreamModel) {
  const started = Date.now();
  const incomingPath = requestPath(req.url);
  const target = targetFor(route, incomingPath);

  let headers;
  try {
    headers = upstreamHeaders(req, route, target.hostname, body.length);
  } catch (error) {
    log(`${req.method} ${incomingPath} model=${model} route=${route} auth_error=${error.message}`);
    sendJson(res, 503, errorBody(error.message, "external_key_unavailable"));
    return;
  }

  const upstream = https.request(
    {
      hostname: target.hostname,
      port: target.port,
      method: req.method,
      path: target.path,
      headers,
      agent: upstreamHttpsAgent,
    },
    (upstreamRes) => {
      const responseHeaders = {};
      for (const [name, value] of Object.entries(upstreamRes.headers)) {
        if (!HOP_BY_HOP.has(name.toLowerCase()) && value != null) {
          responseHeaders[name] = value;
        }
      }
      res.writeHead(upstreamRes.statusCode || 502, responseHeaders);
      upstreamRes.pipe(res);
      upstreamRes.once("end", () => {
        log(
          `${req.method} ${incomingPath} model=${model} upstream_model=${upstreamModel} route=${route} status=${upstreamRes.statusCode || 502} duration_ms=${Date.now() - started}`,
        );
      });
    },
  );

  upstream.setTimeout(360_000, () => upstream.destroy(new Error("upstream timed out")));
  upstream.once("error", (error) => {
    log(`${req.method} ${incomingPath} model=${model} route=${route} upstream_error=${error.message}`);
    if (!res.headersSent) {
      sendJson(res, 502, errorBody("Upstream request failed", "upstream_request_error"));
    } else {
      res.destroy(error);
    }
  });
  req.once("aborted", () => upstream.destroy());
  upstream.end(body);
}

function collectBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 64 * 1024 * 1024) {
        reject(new Error("request body exceeds 64 MiB"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.once("end", () => resolve(Buffer.concat(chunks)));
    req.once("error", reject);
  });
}

function decodeRequestBody(req, body) {
  const encoding = String(req.headers["content-encoding"] || "identity").toLowerCase();
  if (encoding === "identity" || encoding === "") return body;
  if (encoding === "gzip") return zlib.gunzipSync(body);
  if (encoding === "deflate") return zlib.inflateSync(body);
  if (encoding === "br") return zlib.brotliDecompressSync(body);
  if (encoding === "zstd") return zlib.zstdDecompressSync(body);
  throw new Error(`unsupported content encoding: ${encoding}`);
}

function normalizeExternalInput(payload) {
  if (!Array.isArray(payload.input)) return;
  payload.input = payload.input.map((item) => {
    if (
      item?.type !== "reasoning" ||
      typeof item.encrypted_content !== "string"
    ) {
      return item;
    }
    const normalized = { ...item, status: item.status || "completed" };
    delete normalized.content;
    delete normalized.internal_chat_message_metadata_passthrough;
    return normalized;
  });
}

function isToolCallItem(item) {
  const type = item?.type;
  return typeof type === "string" && (
    type === "function_call" ||
    type === "custom_tool_call" ||
    type === "computer_call" ||
    type === "local_shell_call" ||
    (type.endsWith("_call") && !type.endsWith("_call_output"))
  );
}

function isToolResultItem(item) {
  const type = item?.type;
  return typeof type === "string" && (
    type === "function_call_output" ||
    type === "custom_tool_call_output" ||
    type === "computer_call_output" ||
    type === "local_shell_call_output" ||
    type.endsWith("_call_output")
  );
}

function dropAssistantProgressMessagesInActiveToolLoop(payload) {
  if (!Array.isArray(payload.input)) return 0;

  let latestUserIndex = -1;
  for (let index = payload.input.length - 1; index >= 0; index -= 1) {
    const item = payload.input[index];
    if (item?.type === "message" && item?.role === "user") {
      latestUserIndex = index;
      break;
    }
  }
  if (latestUserIndex < 0) return 0;

  const activeTurn = payload.input.slice(latestUserIndex + 1);
  const firstToolCallOffset = activeTurn.findIndex(isToolCallItem);
  if (firstToolCallOffset < 0 || !activeTurn.some(isToolResultItem)) return 0;

  const firstToolCallIndex = latestUserIndex + 1 + firstToolCallOffset;
  let removed = 0;
  payload.input = payload.input.filter((item, index) => {
    const isProgressMessage =
      index > firstToolCallIndex &&
      item?.type === "message" &&
      item?.role === "assistant";
    if (isProgressMessage) removed += 1;
    return !isProgressMessage;
  });
  return removed;
}

function encodeLocalCompaction(summary, sourceModel) {
  const payload = Buffer.from(
    JSON.stringify({
      version: 1,
      summary,
      source_model: sourceModel,
      compact_model: COMPACT_MODEL,
    }),
  ).toString("base64url");
  const signature = createHmac("sha256", readCompactSecret())
    .update(payload)
    .digest("base64url");
  return `${LOCAL_COMPACTION_PREFIX}${payload}.${signature}`;
}

function decodeLocalCompaction(value) {
  if (typeof value !== "string" || !value.startsWith(LOCAL_COMPACTION_PREFIX)) {
    return null;
  }
  try {
    const packed = value.slice(LOCAL_COMPACTION_PREFIX.length);
    const separator = packed.lastIndexOf(".");
    if (separator < 1) return null;
    const encoded = packed.slice(0, separator);
    const signature = packed.slice(separator + 1);
    const expected = createHmac("sha256", readCompactSecret())
      .update(encoded)
      .digest();
    const received = Buffer.from(signature, "base64url");
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
      return null;
    }
    const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (parsed?.version !== 1 || typeof parsed.summary !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

function localSummaryMessage(summary) {
  return {
    type: "message",
    role: "developer",
    content: [
      {
        type: "input_text",
        text:
          "<context_checkpoint_summary>\n" +
          summary +
          "\n</context_checkpoint_summary>",
      },
    ],
  };
}

function restoreLocalCompactions(payload) {
  if (!Array.isArray(payload.input)) return;
  payload.input = payload.input.map((item) => {
    if (item?.type !== "compaction" && item?.type !== "compaction_summary") {
      return item;
    }
    const decoded = decodeLocalCompaction(item.encrypted_content);
    return decoded ? localSummaryMessage(decoded.summary) : item;
  });
}

function dropUnreplayableReasoning(payload) {
  if (payload?.store !== false || !Array.isArray(payload.input)) return 0;
  let removed = 0;
  payload.input = payload.input.filter((item) => {
    const unreplayable =
      item?.type === "reasoning" &&
      !(typeof item.encrypted_content === "string" && item.encrypted_content.length > 0);
    if (unreplayable) removed += 1;
    return !unreplayable;
  });
  return removed;
}

function isRemoteCompactionV2(payload) {
  return Array.isArray(payload.input) &&
    payload.input.some((item) => item?.type === "compaction_trigger");
}

function hasLocalCompaction(payload) {
  return Array.isArray(payload.input) && payload.input.some((item) =>
    (item?.type === "compaction" || item?.type === "compaction_summary") &&
    decodeLocalCompaction(item.encrypted_content),
  );
}

function isCompactionItem(item) {
  return item?.type === "compaction" || item?.type === "compaction_summary";
}

function hasNativeCompaction(payload) {
  return Array.isArray(payload.input) && payload.input.some((item) =>
    isCompactionItem(item) &&
    typeof item.encrypted_content === "string" &&
    !decodeLocalCompaction(item.encrypted_content),
  );
}

function isNativeCompactionItem(item) {
  return isCompactionItem(item) &&
    typeof item.encrypted_content === "string" &&
    !decodeLocalCompaction(item.encrypted_content);
}

function preparePayloadForRoute(
  payload,
  selection,
  originalModel,
  { preserveAssistantProgress = false } = {},
) {
  const requestedEffort = payload.reasoning?.effort ?? null;
  payload.model = selection.upstreamModel;
  restoreLocalCompactions(payload);
  const removedReasoning = dropUnreplayableReasoning(payload);
  if (removedReasoning > 0) {
    log(
      `model=${originalModel} route=${selection.route} ` +
        `dropped_unreplayable_reasoning=${removedReasoning}`,
    );
  }
  if (selection.route !== "external") return;

  normalizeExternalInput(payload);
  if (selection.compatibility === "claude" && !preserveAssistantProgress) {
    const removedProgressMessages =
      dropAssistantProgressMessagesInActiveToolLoop(payload);
    if (removedProgressMessages > 0) {
      log(
        `model=${originalModel} removed_assistant_tool_progress=${removedProgressMessages}`,
      );
    }
  }
  delete payload.service_tier;
  if (!Array.isArray(payload.tools) || payload.tools.length === 0) {
    delete payload.tool_choice;
  }
  if (selection.compatibility === "grok" && Array.isArray(payload.tools)) {
    payload.tools = payload.tools.filter((tool) => tool?.type !== "namespace");
  }
  if (
    selection.compatibility === "claude" &&
    ["max", "ultra"].includes(payload.reasoning?.effort)
  ) {
      // Some OpenAI-compatible gateways map reasoning.effort=max to Anthropic's
    // retired thinking.type=enabled shape. Express Opus 5's supported adaptive
    // thinking fields explicitly so max survives the compatibility layer.
    payload.thinking = { type: "adaptive" };
    payload.output_config = {
      ...(payload.output_config && typeof payload.output_config === "object"
        ? payload.output_config
        : {}),
      effort: "max",
    };
    delete payload.reasoning.effort;
    log(
      `model=${originalModel} requested_effort=${requestedEffort} ` +
        "effective_effort=max effort_transport=anthropic_adaptive",
    );
  } else if (
    selection.compatibility === "kimi" &&
    payload.reasoning?.effort === "ultra"
  ) {
    payload.reasoning.effort = "max";
  } else if (
    selection.compatibility === "grok" &&
    ["xhigh", "max", "ultra"].includes(payload.reasoning?.effort)
  ) {
    payload.reasoning.effort = "high";
  }
  const effectiveEffort =
    payload.reasoning?.effort ?? payload.output_config?.effort ?? null;
  if (requestedEffort && requestedEffort !== effectiveEffort) {
    log(
      `model=${originalModel} requested_effort=${requestedEffort} effective_effort=${effectiveEffort}`,
    );
  }
}

function compactionInputForGpt(input) {
  const normalized = [];
  for (const rawItem of Array.isArray(input) ? input : []) {
    if (!rawItem || typeof rawItem !== "object") continue;
    if (rawItem.type === "compaction_trigger" || rawItem.type === "reasoning") {
      continue;
    }
    if (rawItem.type === "compaction" || rawItem.type === "compaction_summary") {
      const decoded = decodeLocalCompaction(rawItem.encrypted_content);
      normalized.push(decoded ? localSummaryMessage(decoded.summary) : rawItem);
      continue;
    }
    const item = { ...rawItem };
    delete item.id;
    delete item.internal_chat_message_metadata_passthrough;
    normalized.push(item);
  }
  normalized.push({
    type: "message",
    role: "user",
    content: [
      {
        type: "input_text",
        text:
          "You are performing a CONTEXT CHECKPOINT COMPACTION. Create a " +
          "self-contained handoff summary for another model that will resume the task. " +
          "Preserve current progress, decisions, constraints, user preferences, exact paths, " +
          "commands, errors, and clear next steps. Return only the summary; do not call tools.",
      },
    ],
  });
  return normalized;
}

function decodeResponseBody(headers, body) {
  const encoding = String(headers["content-encoding"] || "identity").toLowerCase();
  if (encoding === "identity" || encoding === "") return body;
  if (encoding === "gzip") return zlib.gunzipSync(body);
  if (encoding === "deflate") return zlib.inflateSync(body);
  if (encoding === "br") return zlib.brotliDecompressSync(body);
  if (encoding === "zstd") return zlib.zstdDecompressSync(body);
  throw new Error(`unsupported upstream content encoding: ${encoding}`);
}

function abortError(message) {
  const error = new Error(message);
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  return error;
}

function isAbortError(error) {
  return error?.name === "AbortError" || error?.code === "ABORT_ERR";
}

function bufferedForward(req, route, body, options = {}) {
  return new Promise((resolve, reject) => {
    const signal = options.signal;
    if (signal?.aborted) {
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : abortError("upstream request aborted before start"),
      );
      return;
    }
    const incomingPath = options.incomingPath || requestPath(req.url);
    const method = options.method || req.method;
    const target = targetFor(route, incomingPath);
    let headers;
    try {
      headers = upstreamHeaders(req, route, target.hostname, body.length);
    } catch (error) {
      reject(error);
      return;
    }
    headers.accept = "text/event-stream";
    headers["content-type"] = "application/json";
    headers["accept-encoding"] = "identity";
    if (route === "chatgpt") {
      const routingModel = options.routingModel || COMPACT_MODEL;
      const tier = req.headers["x-codex-routing-hint"]
        ?.toString()
        .match(/(?:^|;)tier=([^;]+)/)?.[1];
      headers["x-codex-routing-hint"] = tier
        ? `model=${routingModel};tier=${tier}`
        : `model=${routingModel}`;
    }

    let upstream;
    let settled = false;
    const onRequestAborted = () => {
      upstream?.destroy(abortError("local request aborted"));
    };
    const onSignalAborted = () => {
      upstream?.destroy(
        signal.reason instanceof Error
          ? signal.reason
          : abortError("local websocket closed"),
      );
    };
    const cleanup = () => {
      req.off("aborted", onRequestAborted);
      signal?.removeEventListener("abort", onSignalAborted);
    };
    const finishResolve = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const finishReject = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    upstream = https.request(
      {
        hostname: target.hostname,
        port: target.port,
        method,
        path: target.path,
        headers,
        agent: upstreamHttpsAgent,
      },
      (upstreamRes) => {
        const chunks = [];
        let size = 0;
        upstreamRes.on("data", (chunk) => {
          size += chunk.length;
          if (size > 32 * 1024 * 1024) {
            upstream.destroy(new Error("buffered upstream response exceeds 32 MiB"));
            return;
          }
          chunks.push(chunk);
        });
        upstreamRes.once("end", () => {
          try {
            const responseBody = decodeResponseBody(
              upstreamRes.headers,
              Buffer.concat(chunks),
            );
            finishResolve({
              statusCode: upstreamRes.statusCode || 502,
              headers: upstreamRes.headers,
              body: responseBody,
            });
          } catch (error) {
            finishReject(error);
          }
        });
        upstreamRes.once("error", finishReject);
        upstreamRes.once("aborted", () => {
          finishReject(new Error("upstream response aborted"));
        });
      },
    );
    upstream.setTimeout(360_000, () => upstream.destroy(new Error("upstream timed out")));
    upstream.once("error", finishReject);
    req.once("aborted", onRequestAborted);
    signal?.addEventListener("abort", onSignalAborted, { once: true });
    upstream.end(body);
  });
}

function parseSummaryFromSse(body) {
  let deltas = "";
  let completedText = "";
  let responseId = null;
  let usage = null;
  let upstreamError = null;
  const blocks = body.toString("utf8").split(/\r?\n\r?\n/);
  for (const block of blocks) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") continue;
    let event;
    try {
      event = JSON.parse(data);
    } catch {
      continue;
    }
    if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
      deltas += event.delta;
    } else if (event.type === "response.output_item.done") {
      const item = event.item;
      if (item?.type === "message" && Array.isArray(item.content)) {
        const text = item.content
          .filter((part) => part?.type === "output_text" && typeof part.text === "string")
          .map((part) => part.text)
          .join("");
        if (text) completedText = text;
      }
    } else if (event.type === "response.completed") {
      responseId = event.response?.id || responseId;
      usage = event.response?.usage || usage;
    } else if (event.type === "error" || event.error) {
      upstreamError = event.error?.message || event.message || JSON.stringify(event);
    }
  }
  if (upstreamError) throw new Error(upstreamError);
  const summary = (completedText || deltas).trim();
  if (!summary) throw new Error("GPT compaction fallback returned no text summary");
  return { summary, responseId, usage };
}

function sendCompactionSse(res, summary, sourceModel, responseId, usage) {
  const events = compactionEvents(summary, sourceModel, responseId, usage);
  const body = Buffer.from(
    `event: response.output_item.done\ndata: ${JSON.stringify(events.outputDone)}\n\n` +
      `event: response.completed\ndata: ${JSON.stringify(events.completed)}\n\n`,
  );
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    "content-length": String(body.length),
  });
  res.end(body);
}

function compactionEvents(summary, sourceModel, _responseId, usage) {
  const compactId = `cmp_hybrid_${randomUUID().replaceAll("-", "")}`;
  // Keep this empty so Codex does not attempt a WebSocket incremental request
  // against a response id created by a different upstream.
  const finalResponseId = "";
  const item = {
    id: compactId,
    type: "compaction",
    encrypted_content: encodeLocalCompaction(summary, sourceModel),
  };
  const outputDone = {
    type: "response.output_item.done",
    output_index: 0,
    item,
  };
  const completedResponse = {
    id: finalResponseId,
    status: "completed",
    output: [item],
  };
  if (usage) completedResponse.usage = usage;
  const completed = { type: "response.completed", response: completedResponse };
  return { item, outputDone, completed };
}

async function generateExternalCompactionFallback(req, payload, input = payload.input) {
  const compactPayload = {
    ...payload,
    model: COMPACT_MODEL,
    instructions:
      "Act only as a context compaction engine. Return one concise, self-contained " +
      "handoff summary. Do not call tools and do not continue the user's task.",
    input: compactionInputForGpt(input),
    tools: [],
    tool_choice: "none",
    parallel_tool_calls: false,
    reasoning: { effort: COMPACT_EFFORT, summary: "auto" },
    store: false,
    stream: true,
    include: [],
  };
  delete compactPayload.previous_response_id;
  delete compactPayload.type;
  delete compactPayload.generate;
  delete compactPayload.prompt_cache_key;
  delete compactPayload.context_management;

  const body = Buffer.from(JSON.stringify(compactPayload));
  const upstream = await bufferedForward(req, "chatgpt", body, {
    method: "POST",
    incomingPath: "/v1/responses",
  });
  if (upstream.statusCode < 200 || upstream.statusCode >= 300) {
    const detail = upstream.body.toString("utf8").slice(0, 1000);
    throw new Error(`GPT compaction fallback returned ${upstream.statusCode}: ${detail}`);
  }
  return parseSummaryFromSse(upstream.body);
}

async function bridgeNativeCompactionForExternal(req, payload, sourceModel) {
  if (!hasNativeCompaction(payload)) return;
  const bridgePrefix = latestNativeCompactionPrefix(
    payload.input,
    isNativeCompactionItem,
  );
  if (!bridgePrefix) return;

  // A native GPT compaction item and everything before it form a stable,
  // canonical prefix. Summarizing later turns here would both duplicate them
  // and produce a different checkpoint on every request, invalidating
  // Anthropic's cumulative prompt-cache hash.
  const cacheKey = compactionCacheKey(compactionInputForGpt(bridgePrefix));
  const { value, hit } = await nativeCompactionBridgeCache.getOrCreate(
    cacheKey,
    () => generateExternalCompactionFallback(req, payload, bridgePrefix),
  );
  const { summary } = value;

  let inserted = false;
  const bridged = [];
  for (const item of payload.input) {
    if (
      isCompactionItem(item) &&
      typeof item.encrypted_content === "string" &&
      !decodeLocalCompaction(item.encrypted_content)
    ) {
      if (!inserted) {
        bridged.push(localSummaryMessage(summary));
        inserted = true;
      }
      continue;
    }
    bridged.push(item);
  }
  payload.input = bridged;
  log(
    `model=${sourceModel} route=native_compaction_bridge compact_model=${COMPACT_MODEL} ` +
      `summary_cache=${hit ? "hit" : "miss"} cache_key=${cacheKey.slice(0, 12)} status=200`,
  );
}

function parseSseRecords(body) {
  const records = [];
  const blocks = body.toString("utf8").split(/\r?\n\r?\n/);
  for (const block of blocks) {
    if (!block.trim()) continue;
    const eventName = block
      .split(/\r?\n/)
      .find((line) => line.startsWith("event:"))
      ?.slice(6)
      .trim() || null;
    const data = sseData(block);
    if (!data) continue;
    let event = null;
    if (data !== "[DONE]") {
      try {
        event = JSON.parse(data);
      } catch {
        event = null;
      }
    }
    records.push({ eventName, data, event });
  }
  return records;
}

function completedResponseFromRecords(records) {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const event = records[index].event;
    if (event?.type === "response.completed" && event.response) {
      return event.response;
    }
  }
  return null;
}

function responseForClassification(records) {
  const completed = completedResponseFromRecords(records);
  if (!completed) return null;
  const completedItems = records
    .filter((record) => record.event?.type === "response.output_item.done")
    .map((record) => record.event.item)
    .filter(Boolean);
  return {
    ...completed,
    output: completedItems.length ? completedItems : completed.output,
  };
}

function messageHasPlainOutputText(item) {
  if (item?.type !== "message" || !Array.isArray(item.content)) return false;
  if (item.content.some((part) => part?.type === "refusal")) return false;
  return item.content.some(
    (part) => part?.type === "output_text" && typeof part.text === "string" && part.text.trim(),
  );
}

function isCompletedHostedCall(item) {
  return item?.type === "web_search_call" && item.status === "completed";
}

function isTerminalMessageResponse(response) {
  if (response?.status !== "completed" || !Array.isArray(response.output)) return false;
  let hasMessage = false;
  for (const item of response.output) {
    if (item?.type === "reasoning") continue;
    if (isCompletedHostedCall(item)) continue;
    if (messageHasPlainOutputText(item)) {
      hasMessage = true;
      continue;
    }
    // Function/custom/shell/MCP calls still require Codex to continue the
    // agent loop. A completed hosted web search does not: its answer is the
    // message item in this same response.
    return false;
  }
  return hasMessage;
}

function isReasoningSseEvent(event) {
  return event?.item?.type === "reasoning" ||
    (typeof event?.type === "string" && event.type.startsWith("response.reasoning"));
}

function rewriteHybridSseRecords(
  records,
  displayedModel,
  { stripReasoning = false } = {},
) {
  const rewritten = [];
  for (const record of records) {
    if (!record.event) {
      rewritten.push({ ...record });
      continue;
    }
    if (stripReasoning && isReasoningSseEvent(record.event)) continue;
    const event = structuredClone(record.event);
    if (event.response && typeof event.response === "object") {
      if (typeof event.response.model === "string") {
        event.response.model = displayedModel;
      }
      if (stripReasoning && Array.isArray(event.response.output)) {
        event.response.output = event.response.output.filter(
          (item) => item?.type !== "reasoning",
        );
      }
      if (event.type === "response.completed") {
        // The visible final message may come from a different upstream than the
        // hidden GPT completion. Force the next turn to replay local context.
        event.response.id = "";
      }
    }
    rewritten.push({ eventName: record.eventName, data: JSON.stringify(event), event });
  }
  return rewritten;
}

function encodeSseRecords(records) {
  const text = records.map((record) => {
    const eventName = record.eventName || record.event?.type;
    return `${eventName ? `event: ${eventName}\n` : ""}data: ${record.data}\n\n`;
  }).join("");
  return Buffer.from(text);
}

function sendSseRecordsToWebSocket(socket, records) {
  for (const record of records) {
    if (!record.event || socket.readyState !== WebSocket.OPEN) continue;
    socket.send(JSON.stringify(record.event));
  }
}

function sendSseRecordsToHttp(res, records) {
  const body = encodeSseRecords(records);
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    "content-length": String(body.length),
  });
  res.end(body);
}

function hybridAgentPayload(payload, selection, originalModel) {
  const agentPayload = structuredClone(payload);
  restoreLocalCompactions(agentPayload);
  const removedReasoning = dropUnreplayableReasoning(agentPayload);
  if (removedReasoning > 0) {
    log(
      `model=${originalModel} route=hybrid_agent ` +
        `dropped_unreplayable_reasoning=${removedReasoning}`,
    );
  }
  agentPayload.model = selection.upstreamModel;
  if (agentPayload.service_tier == null && selection.agentServiceTier) {
    agentPayload.service_tier = selection.agentServiceTier;
  }
  agentPayload.stream = true;
  delete agentPayload.type;
  delete agentPayload.generate;
  delete agentPayload.previous_response_id;
  return agentPayload;
}

function claudeFinalizerPayload(payload, selection, originalModel, agentResponse) {
  const finalizerPayload = structuredClone(payload);
  if (Array.isArray(finalizerPayload.input)) {
    // GPT reasoning blobs are provider-specific and are not evidence required
    // for the independent final answer. Messages and tool results are retained.
    finalizerPayload.input = finalizerPayload.input.filter(
      (item) => item?.type !== "reasoning" && item?.type !== "compaction_trigger",
    );
  }
  finalizerPayload.include = [];
  finalizerPayload.store = false;
  finalizerPayload.stream = true;
  delete finalizerPayload.type;
  delete finalizerPayload.generate;
  delete finalizerPayload.previous_response_id;
  delete finalizerPayload.context_management;

  preparePayloadForRoute(
    finalizerPayload,
    {
      route: "external",
      upstreamModel: selection.finalizerModel,
      compatibility: selection.finalizerCompatibility,
    },
    originalModel,
    { preserveAssistantProgress: true },
  );

  const { draftMessages, toolEvidenceItems } = appendFinalizerHandoff(
    finalizerPayload,
    agentResponse,
  );
  log(
    `model=${originalModel} route=hybrid_finalizer_handoff ` +
      `draft_messages=${draftMessages} tool_evidence_items=${toolEvidenceItems} ` +
      `tools=disabled ` +
      "assistant_progress=preserved",
  );
  return finalizerPayload;
}

async function runHybridFinalResponse(
  req,
  payload,
  originalModel,
  selection,
  { signal } = {},
) {
  const started = Date.now();
  const agentPayload = hybridAgentPayload(payload, selection, originalModel);
  const agentBody = Buffer.from(JSON.stringify(agentPayload));
  const agentUpstream = await bufferedForward(req, "chatgpt", agentBody, {
    method: "POST",
    incomingPath: "/v1/responses",
    routingModel: selection.upstreamModel,
    signal,
  });
  if (agentUpstream.statusCode < 200 || agentUpstream.statusCode >= 300) {
    const detail = agentUpstream.body.toString("utf8").slice(0, 1000);
    throw new Error(`GPT agent returned ${agentUpstream.statusCode}: ${detail}`);
  }

  const agentRecords = parseSseRecords(agentUpstream.body);
  const agentResponse = responseForClassification(agentRecords);
  const rewrittenAgentRecords = rewriteHybridSseRecords(agentRecords, originalModel);
  if (!isTerminalMessageResponse(agentResponse)) {
    log(
      `model=${originalModel} route=hybrid_agent upstream_model=${selection.upstreamModel} ` +
        `service_tier=${agentPayload.service_tier ?? "default"} decision=continue ` +
        `status=200 duration_ms=${Date.now() - started}`,
    );
    return { records: rewrittenAgentRecords, source: "gpt_continue" };
  }

  try {
    const finalizerSourcePayload = structuredClone(payload);
    if (hasNativeCompaction(finalizerSourcePayload)) {
      await bridgeNativeCompactionForExternal(
        req,
        finalizerSourcePayload,
        originalModel,
      );
    }
    const finalizerPayload = claudeFinalizerPayload(
      finalizerSourcePayload,
      selection,
      originalModel,
      agentResponse,
    );
    const finalizerBody = Buffer.from(JSON.stringify(finalizerPayload));
    const finalizerUpstream = await bufferedForward(req, "external", finalizerBody, {
      method: "POST",
      incomingPath: "/v1/responses",
      signal,
    });
    if (finalizerUpstream.statusCode < 200 || finalizerUpstream.statusCode >= 300) {
      const detail = finalizerUpstream.body.toString("utf8").slice(0, 1000);
      throw new Error(`Claude finalizer returned ${finalizerUpstream.statusCode}: ${detail}`);
    }
    const finalizerRecords = parseSseRecords(finalizerUpstream.body);
    const finalizerResponse = responseForClassification(finalizerRecords);
    if (!isTerminalMessageResponse(finalizerResponse)) {
      throw new Error("Claude finalizer did not return a completed final message");
    }
    log(
      `model=${originalModel} route=hybrid_finalizer agent_model=${selection.upstreamModel} ` +
      `service_tier=${agentPayload.service_tier ?? "default"} ` +
        "finalizer_tools=disabled " +
        `finalizer_model=${selection.finalizerModel} status=200 ` +
        `duration_ms=${Date.now() - started}`,
    );
    return {
      // External-provider reasoning IDs are not OpenAI-persisted items. Returning them to
      // Codex would make the next store:false GPT turn replay an unresolvable
      // rs_* reference. The final message and hosted-search records remain.
      records: rewriteHybridSseRecords(finalizerRecords, originalModel, {
        stripReasoning: true,
      }),
      source: "claude_final",
    };
  } catch (error) {
    if (isAbortError(error)) throw error;
    log(
      `model=${originalModel} route=hybrid_finalizer fallback=gpt ` +
        `error=${error.message} duration_ms=${Date.now() - started}`,
    );
    return { records: rewrittenAgentRecords, source: "gpt_fallback" };
  }
}

async function runExternalCompactionFallback(req, res, payload, sourceModel) {
  const started = Date.now();
  try {
    const { summary, responseId, usage } = await generateExternalCompactionFallback(req, payload);
    sendCompactionSse(res, summary, sourceModel, responseId, usage);
    log(
      `POST ${requestPath(req.url)} model=${sourceModel} route=chatgpt_compact ` +
        `compact_model=${COMPACT_MODEL} status=200 duration_ms=${Date.now() - started}`,
    );
  } catch (error) {
    log(
      `POST ${requestPath(req.url)} model=${sourceModel} route=chatgpt_compact ` +
        `error=${error.message}`,
    );
    if (!res.headersSent) {
      sendJson(
        res,
        502,
        errorBody(`Third-party compaction fallback failed: ${error.message}`, "compact_fallback_failed"),
      );
    } else {
      res.destroy(error);
    }
  }
}

async function runHybridNativeCompaction(req, res, payload, sourceModel, selection) {
  const started = Date.now();
  try {
    const compactPayload = hybridAgentPayload(payload, selection, sourceModel);
    const body = Buffer.from(JSON.stringify(compactPayload));
    const upstream = await bufferedForward(req, "chatgpt", body, {
      method: "POST",
      incomingPath: "/v1/responses",
      routingModel: selection.upstreamModel,
    });
    if (upstream.statusCode < 200 || upstream.statusCode >= 300) {
      const detail = upstream.body.toString("utf8").slice(0, 1000);
      throw new Error(`GPT native compaction returned ${upstream.statusCode}: ${detail}`);
    }
    const records = parseSseRecords(upstream.body);
    sendSseRecordsToHttp(res, records);
    log(
      `POST ${requestPath(req.url)} model=${sourceModel} ` +
        `route=chatgpt_native_compact compact_model=${selection.upstreamModel} ` +
        `status=200 duration_ms=${Date.now() - started}`,
    );
  } catch (error) {
    log(
      `POST ${requestPath(req.url)} model=${sourceModel} ` +
        `route=chatgpt_native_compact error=${error.message}`,
    );
    if (!res.headersSent) {
      sendJson(
        res,
        502,
        errorBody(
          `Hybrid native compaction failed: ${error.message}`,
          "hybrid_native_compact_failed",
        ),
      );
    } else {
      res.destroy(error);
    }
  }
}

function sendWebSocketJson(socket, value) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(value));
  }
}

function sendWebSocketError(socket, status, message, code = "hybrid_router_error") {
  sendWebSocketJson(socket, {
    type: "error",
    status,
    error: { code, message },
  });
}

function startHybridKeepalive(socket) {
  let pingCount = 0;
  const timer = setInterval(() => {
    if (socket.readyState !== WebSocket.OPEN) return;
    try {
      socket.ping(undefined, false, () => {});
      pingCount += 1;
    } catch {
      // The close handler owns cancellation. A racing ping must not turn a
      // normal local disconnect into a router process error.
    }
  }, HYBRID_KEEPALIVE_MS);
  timer.unref?.();
  return () => {
    clearInterval(timer);
    return pingCount;
  };
}

function websocketHeaders(req, route, model = null) {
  const headers = {};
  for (const [rawName, rawValue] of Object.entries(req.headers)) {
    const name = rawName.toLowerCase();
    if (
      HOP_BY_HOP.has(name) ||
      name === "host" ||
      name === "content-length" ||
      name === "content-encoding" ||
      name.startsWith("sec-websocket-") ||
      rawValue == null
    ) {
      continue;
    }
    if (
      isExternalRoute(route) &&
      (name === "authorization" ||
        name === "x-api-key" ||
        name === "chatgpt-account-id" ||
        name === "openai-organization" ||
        name === "openai-project")
    ) {
      continue;
    }
    headers[rawName] = rawValue;
  }
  if (isExternalRoute(route)) {
    const apiKey = readExternalKey();
    if (EXTERNAL_PROVIDER.send_authorization !== false) {
      headers.authorization = `Bearer ${apiKey}`;
    }
    if (EXTERNAL_PROVIDER.send_x_api_key === true) {
      headers["x-api-key"] = apiKey;
    }
    for (const [name, value] of Object.entries(EXTERNAL_PROVIDER.headers || {})) {
      headers[name] = String(value);
    }
  } else if (route === "chatgpt" && model) {
    const tier = req.headers["x-codex-routing-hint"]
      ?.toString()
      .match(/(?:^|;)tier=([^;]+)/)?.[1];
    headers["x-codex-routing-hint"] = tier
      ? `model=${model};tier=${tier}`
      : `model=${model}`;
  }
  return headers;
}

function connectChatgptWebSocket(req, localSocket, model) {
  return new Promise((resolve, reject) => {
    const target = targetFor("chatgpt", "/v1/responses");
    const upstream = new WebSocket(`wss://${target.hostname}${target.path}`, {
      agent: upstreamHttpsAgent,
      headers: websocketHeaders(req, "chatgpt", model),
      handshakeTimeout: 30_000,
      perMessageDeflate: true,
    });
    let settled = false;
    upstream.once("open", () => {
      settled = true;
      log("WS /v1/responses route=chatgpt connected");
      resolve(upstream);
    });
    upstream.once("unexpected-response", (_request, response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.once("end", () => {
        const detail = Buffer.concat(chunks).toString("utf8").slice(0, 1000);
        reject(new Error(`ChatGPT websocket returned ${response.statusCode}: ${detail}`));
      });
    });
    upstream.once("error", (error) => {
      if (!settled) reject(error);
      else if (localSocket.readyState === WebSocket.OPEN) {
        sendWebSocketError(localSocket, 502, `ChatGPT websocket failed: ${error.message}`);
        localSocket.close(1011, "ChatGPT upstream websocket failed");
      }
    });
    upstream.on("message", (data, isBinary) => {
      if (localSocket.readyState === WebSocket.OPEN) {
        localSocket.send(data, { binary: isBinary });
      }
    });
    upstream.on("close", (code, reason) => {
      log(`WS /v1/responses route=chatgpt closed code=${code} reason=${reason.toString()}`);
      if (
        !upstream[EXPECTED_UPSTREAM_CLOSE] &&
        localSocket.readyState === WebSocket.OPEN
      ) {
        const forwardableCode =
          code >= 1000 && code <= 4999 && ![1004, 1005, 1006, 1015].includes(code)
            ? code
            : 1011;
        const forwardedReason = reason.length
          ? reason.toString().slice(0, 120)
          : `ChatGPT upstream closed (${code})`;
        localSocket.close(forwardableCode, forwardedReason);
      }
    });
  });
}

function sseData(block) {
  return block
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
}

function rewriteExternalWebSocketEvent(data) {
  if (!data || data === "[DONE]") return null;
  try {
    const event = JSON.parse(data);
    if (event.type === "response.completed" && event.response) {
      // External HTTP response ids cannot back Codex's websocket incremental
      // protocol. An empty id makes the next turn send a complete request.
      event.response.id = "";
    }
    return JSON.stringify(event);
  } catch {
    return data;
  }
}

function anthropicRequestForRoute(payload, selection, originalModel) {
  preparePayloadForRoute(payload, selection, originalModel);
  delete payload.type;
  delete payload.previous_response_id;
  delete payload.generate;
  payload.stream = true;

  const promptCacheEnabled = selection.promptCache?.enabled === true;
  const bridge = new AnthropicResponsesBridge(payload, {
    promptCache: promptCacheEnabled,
    cacheTtl: selection.promptCache?.ttl || "5m",
  });
  bridge.request.stream = true;
  log(
    `model=${originalModel} route=external_anthropic ` +
      `prompt_cache=${promptCacheEnabled ? "automatic+stable-prefix" : "disabled"} ` +
      `cache_breakpoints=${bridge.cacheBreakpoints} ` +
      `openai_cache_key=${typeof payload.prompt_cache_key === "string" ? "present" : "absent"}`,
  );
  return bridge;
}

function parseSseJson(block) {
  const data = sseData(block);
  if (!data || data === "[DONE]") return null;
  return JSON.parse(data);
}

function streamAnthropicMessagesToWebSocket(
  req,
  socket,
  payload,
  originalModel,
  selection,
) {
  return new Promise((resolve) => {
    let bridge;
    let body;
    let target;
    let headers;
    try {
      bridge = anthropicRequestForRoute(payload, selection, originalModel);
      body = Buffer.from(JSON.stringify(bridge.request));
      target = targetFor("external_anthropic", "/v1/messages");
      headers = upstreamHeaders(
        req,
        "external_anthropic",
        target.hostname,
        body.length,
      );
    } catch (error) {
      sendWebSocketError(socket, 503, error.message, "external_request_setup_failed");
      resolve();
      return;
    }

    headers.accept = "text/event-stream";
    headers["accept-encoding"] = "identity";
    headers["content-type"] = "application/json";
    headers["anthropic-version"] ||= "2023-06-01";
    const started = Date.now();
    let upstream;
    let finished = false;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    const finish = () => {
      if (finished) return;
      finished = true;
      socket.off("close", closeHandler);
      resolve();
    };
    const fail = (error, code = "external_request_failed") => {
      if (finished) return;
      log(
        `WS /v1/responses model=${originalModel} ` +
          `route=external_anthropic error=${error.message} ` +
          `duration_ms=${Date.now() - started}`,
      );
      if (socket.readyState === WebSocket.OPEN) {
        sendWebSocketError(socket, 502, error.message, code);
      }
      upstream?.destroy();
      finish();
    };
    const closeHandler = () => {
      upstream?.destroy();
      finish();
    };

    upstream = https.request(
      {
        hostname: target.hostname,
        port: target.port,
        method: "POST",
        path: target.path,
        headers,
        agent: upstreamHttpsAgent,
      },
      (upstreamRes) => {
        const statusCode = upstreamRes.statusCode || 502;
        if (statusCode < 200 || statusCode >= 300) {
          const chunks = [];
          upstreamRes.on("data", (chunk) => chunks.push(chunk));
          upstreamRes.once("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            let parsed;
            try {
              parsed = JSON.parse(raw);
            } catch {
              parsed = null;
            }
            const message =
              parsed?.error?.message ||
              raw.slice(0, 1000) ||
              `Anthropic endpoint returned ${statusCode}`;
            if (socket.readyState === WebSocket.OPEN) {
              sendWebSocketError(
                socket,
                statusCode,
                message,
                parsed?.error?.type || "external_request_failed",
              );
            }
            log(
              `WS /v1/responses model=${originalModel} ` +
                `route=external_anthropic status=${statusCode} ` +
                `duration_ms=${Date.now() - started}`,
            );
            finish();
          });
          return;
        }

        const decoder = new StringDecoder("utf8");
        let pending = "";
        const emitBlock = (block) => {
          const event = parseSseJson(block);
          if (!event) return;
          if (event.type === "message_start") {
            cacheReadTokens = event.message?.usage?.cache_read_input_tokens || 0;
            cacheWriteTokens = event.message?.usage?.cache_creation_input_tokens || 0;
          }
          for (const converted of bridge.convertEvent(event)) {
            if (socket.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify(converted));
            }
          }
        };
        const flush = (final = false) => {
          while (true) {
            const separator = pending.match(/\r?\n\r?\n/);
            if (!separator || separator.index == null) break;
            const block = pending.slice(0, separator.index);
            pending = pending.slice(separator.index + separator[0].length);
            emitBlock(block);
          }
          if (final && pending.trim()) {
            emitBlock(pending);
            pending = "";
          }
        };
        upstreamRes.on("data", (chunk) => {
          if (finished) return;
          try {
            pending += decoder.write(chunk);
            flush();
          } catch (error) {
            fail(error, "anthropic_stream_conversion_failed");
          }
        });
        upstreamRes.once("end", () => {
          if (finished) return;
          try {
            pending += decoder.end();
            flush(true);
          } catch (error) {
            fail(error, "anthropic_stream_conversion_failed");
            return;
          }
          log(
            `WS /v1/responses model=${originalModel} ` +
              `upstream_model=${selection.upstreamModel} ` +
              `route=external_anthropic status=${statusCode} ` +
              `cache_read_tokens=${cacheReadTokens} ` +
              `cache_write_tokens=${cacheWriteTokens} ` +
              `duration_ms=${Date.now() - started}`,
          );
          finish();
        });
      },
    );
    socket.once("close", closeHandler);
    upstream.setTimeout(360_000, () => upstream.destroy(new Error("upstream timed out")));
    upstream.once("error", (error) => fail(error));
    upstream.end(body);
  });
}

function streamAnthropicMessagesToHttp(
  req,
  res,
  payload,
  originalModel,
  selection,
) {
  return new Promise((resolve) => {
    let bridge;
    let body;
    let target;
    let headers;
    try {
      bridge = anthropicRequestForRoute(payload, selection, originalModel);
      body = Buffer.from(JSON.stringify(bridge.request));
      target = targetFor("external_anthropic", "/v1/messages");
      headers = upstreamHeaders(
        req,
        "external_anthropic",
        target.hostname,
        body.length,
      );
    } catch (error) {
      sendJson(res, 503, errorBody(error.message, "external_request_setup_failed"));
      resolve();
      return;
    }

    headers.accept = "text/event-stream";
    headers["accept-encoding"] = "identity";
    headers["content-type"] = "application/json";
    headers["anthropic-version"] ||= "2023-06-01";
    const started = Date.now();
    let upstream;
    let finished = false;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    const finish = () => {
      if (finished) return;
      finished = true;
      res.off("close", closeHandler);
      resolve();
    };
    const fail = (error, code = "external_request_failed") => {
      if (finished) return;
      log(
        `POST /v1/responses model=${originalModel} ` +
          `route=external_anthropic error=${error.message} ` +
          `duration_ms=${Date.now() - started}`,
      );
      upstream?.destroy();
      if (!res.headersSent) {
        sendJson(res, 502, errorBody(error.message, code));
      } else {
        res.destroy(error);
      }
      finish();
    };
    const closeHandler = () => {
      upstream?.destroy();
      finish();
    };

    upstream = https.request(
      {
        hostname: target.hostname,
        port: target.port,
        method: "POST",
        path: target.path,
        headers,
        agent: upstreamHttpsAgent,
      },
      (upstreamRes) => {
        const statusCode = upstreamRes.statusCode || 502;
        if (statusCode < 200 || statusCode >= 300) {
          const chunks = [];
          upstreamRes.on("data", (chunk) => chunks.push(chunk));
          upstreamRes.once("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            let parsed;
            try {
              parsed = JSON.parse(raw);
            } catch {
              parsed = null;
            }
            const message =
              parsed?.error?.message ||
              raw.slice(0, 1000) ||
              `Anthropic endpoint returned ${statusCode}`;
            if (!res.headersSent) {
              sendJson(
                res,
                statusCode,
                errorBody(
                  message,
                  parsed?.error?.type || "external_request_failed",
                ),
              );
            }
            log(
              `POST /v1/responses model=${originalModel} ` +
                `route=external_anthropic status=${statusCode} ` +
                `duration_ms=${Date.now() - started}`,
            );
            finish();
          });
          return;
        }

        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
        });
        const decoder = new StringDecoder("utf8");
        let pending = "";
        const emitBlock = (block) => {
          const event = parseSseJson(block);
          if (!event) return;
          if (event.type === "message_start") {
            cacheReadTokens = event.message?.usage?.cache_read_input_tokens || 0;
            cacheWriteTokens = event.message?.usage?.cache_creation_input_tokens || 0;
          }
          for (const converted of bridge.convertEvent(event)) {
            const eventName = converted.type || "message";
            res.write(`event: ${eventName}\ndata: ${JSON.stringify(converted)}\n\n`);
          }
        };
        const flush = (final = false) => {
          while (true) {
            const separator = pending.match(/\r?\n\r?\n/);
            if (!separator || separator.index == null) break;
            const block = pending.slice(0, separator.index);
            pending = pending.slice(separator.index + separator[0].length);
            emitBlock(block);
          }
          if (final && pending.trim()) {
            emitBlock(pending);
            pending = "";
          }
        };
        upstreamRes.on("data", (chunk) => {
          if (finished) return;
          try {
            pending += decoder.write(chunk);
            flush();
          } catch (error) {
            fail(error, "anthropic_stream_conversion_failed");
          }
        });
        upstreamRes.once("end", () => {
          if (finished) return;
          try {
            pending += decoder.end();
            flush(true);
          } catch (error) {
            fail(error, "anthropic_stream_conversion_failed");
            return;
          }
          res.end();
          log(
            `POST /v1/responses model=${originalModel} ` +
              `upstream_model=${selection.upstreamModel} ` +
              `route=external_anthropic status=${statusCode} ` +
              `cache_read_tokens=${cacheReadTokens} ` +
              `cache_write_tokens=${cacheWriteTokens} ` +
              `duration_ms=${Date.now() - started}`,
          );
          finish();
        });
      },
    );
    res.once("close", closeHandler);
    upstream.setTimeout(360_000, () => upstream.destroy(new Error("upstream timed out")));
    upstream.once("error", (error) => fail(error));
    upstream.end(body);
  });
}

function streamExternalHttpToWebSocket(req, socket, payload, originalModel, selection) {
  return new Promise((resolve) => {
    preparePayloadForRoute(payload, selection, originalModel);
    delete payload.type;
    delete payload.previous_response_id;
    delete payload.generate;
    payload.stream = true;
    const body = Buffer.from(JSON.stringify(payload));
    const target = targetFor("external", "/v1/responses");
    let headers;
    try {
      headers = upstreamHeaders(req, "external", target.hostname, body.length);
    } catch (error) {
      sendWebSocketError(socket, 503, error.message, "external_key_unavailable");
      resolve();
      return;
    }
    headers.accept = "text/event-stream";
    headers["accept-encoding"] = "identity";
    headers["content-type"] = "application/json";
    const started = Date.now();
    const upstream = https.request(
      {
        hostname: target.hostname,
        port: target.port,
        method: "POST",
        path: target.path,
        headers,
        agent: upstreamHttpsAgent,
      },
      (upstreamRes) => {
        if ((upstreamRes.statusCode || 502) < 200 || (upstreamRes.statusCode || 502) >= 300) {
          const chunks = [];
          upstreamRes.on("data", (chunk) => chunks.push(chunk));
          upstreamRes.once("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            let parsed;
            try {
              parsed = JSON.parse(raw);
            } catch {
              parsed = null;
            }
            sendWebSocketError(
              socket,
              upstreamRes.statusCode || 502,
              parsed?.error?.message || raw.slice(0, 1000) || "External provider request failed",
              parsed?.error?.code || "external_request_failed",
            );
            log(
              `WS /v1/responses model=${originalModel} upstream_model=${selection.upstreamModel} ` +
                `route=external_http status=${upstreamRes.statusCode || 502} ` +
                `duration_ms=${Date.now() - started}`,
            );
            resolve();
          });
          return;
        }

        const decoder = new StringDecoder("utf8");
        let pending = "";
        const flush = (final = false) => {
          while (true) {
            const separator = pending.match(/\r?\n\r?\n/);
            if (!separator || separator.index == null) break;
            const block = pending.slice(0, separator.index);
            pending = pending.slice(separator.index + separator[0].length);
            const event = rewriteExternalWebSocketEvent(sseData(block));
            if (event && socket.readyState === WebSocket.OPEN) socket.send(event);
          }
          if (final && pending.trim()) {
            const event = rewriteExternalWebSocketEvent(sseData(pending));
            if (event && socket.readyState === WebSocket.OPEN) socket.send(event);
            pending = "";
          }
        };
        upstreamRes.on("data", (chunk) => {
          pending += decoder.write(chunk);
          flush();
        });
        upstreamRes.once("end", () => {
          pending += decoder.end();
          flush(true);
          log(
            `WS /v1/responses model=${originalModel} upstream_model=${selection.upstreamModel} ` +
              `route=external_http status=${upstreamRes.statusCode || 200} ` +
              `duration_ms=${Date.now() - started}`,
          );
          resolve();
        });
      },
    );
    const closeHandler = () => upstream.destroy();
    socket.once("close", closeHandler);
    upstream.setTimeout(360_000, () => upstream.destroy(new Error("upstream timed out")));
    upstream.once("error", (error) => {
      socket.off("close", closeHandler);
      sendWebSocketError(socket, 502, `External provider request failed: ${error.message}`);
      resolve();
    });
    upstream.once("close", () => socket.off("close", closeHandler));
    upstream.end(body);
  });
}

function handleLocalWebSocket(socket, req) {
  let chatgptSocket = null;
  let chatgptConnecting = null;
  let chatgptModel = null;
  let activeHybridController = null;
  let queue = Promise.resolve();

  const getChatgptSocket = async (model) => {
    if (chatgptSocket?.readyState === WebSocket.OPEN && chatgptModel === model) {
      return chatgptSocket;
    }
    if (chatgptSocket && chatgptSocket.readyState < WebSocket.CLOSING) {
      chatgptSocket[EXPECTED_UPSTREAM_CLOSE] = true;
      chatgptSocket.close(1000, "model changed");
      chatgptSocket = null;
      chatgptModel = null;
    }
    if (!chatgptConnecting) {
      chatgptConnecting = connectChatgptWebSocket(req, socket, model)
        .then((upstream) => {
          chatgptSocket = upstream;
          chatgptModel = model;
          upstream.once("close", () => {
            if (chatgptSocket === upstream) {
              chatgptSocket = null;
              chatgptModel = null;
            }
          });
          return upstream;
        })
        .finally(() => {
          chatgptConnecting = null;
        });
    }
    return chatgptConnecting;
  };

  socket.on("message", (data, isBinary) => {
    queue = queue.then(async () => {
      if (socket.readyState !== WebSocket.OPEN) return;
      if (isBinary) {
        sendWebSocketError(socket, 400, "Binary request frames are not supported");
        return;
      }
      const requestText = data.toString("utf8");
      let payload;
      try {
        payload = JSON.parse(requestText);
      } catch (error) {
        sendWebSocketError(socket, 400, `Invalid websocket JSON: ${error.message}`);
        return;
      }
      if (payload?.type !== "response.create") {
        sendWebSocketError(socket, 400, `Unsupported websocket message: ${String(payload?.type)}`);
        return;
      }
      const originalModel = payload.model;
      const selection = classifyModel(originalModel);
      if (!selection) {
        sendWebSocketError(socket, 400, `Model is not allowed by the local router: ${String(originalModel)}`);
        return;
      }

      if (selection.route === "chatgpt") {
        // A native GPT request is byte-for-byte unchanged unless it contains a
        // model-portable summary or a non-persisted reasoning reference created
        // by a third-party turn.
        const portableSummaryPresent = hasLocalCompaction(payload);
        if (portableSummaryPresent) restoreLocalCompactions(payload);
        const removedReasoning = dropUnreplayableReasoning(payload);
        if (removedReasoning > 0) {
          log(
            `WS /v1/responses model=${originalModel} route=chatgpt ` +
              `dropped_unreplayable_reasoning=${removedReasoning}`,
          );
        }
        const upstream = await getChatgptSocket(originalModel);
        const upstreamText = portableSummaryPresent || removedReasoning > 0
          ? JSON.stringify(payload)
          : requestText;
        log(
          `WS /v1/responses model=${originalModel} route=chatgpt ` +
            `request_bytes=${Buffer.byteLength(upstreamText)}`,
        );
        upstream.send(upstreamText);
        return;
      }

      if (payload.generate === false) {
        sendWebSocketJson(socket, {
          type: "response.completed",
          response: { id: "", status: "completed", output: [] },
        });
        log(
          `WS /v1/responses model=${originalModel} ` +
            `route=${selection.route}_warmup status=200`,
        );
        return;
      }

      if (isRemoteCompactionV2(payload)) {
        if (selection.route === "hybrid_final") {
          const compactPayload = hybridAgentPayload(
            payload,
            selection,
            originalModel,
          );
          compactPayload.type = "response.create";
          const compactText = JSON.stringify(compactPayload);
          const upstream = await getChatgptSocket(selection.upstreamModel);
          log(
            `WS /v1/responses model=${originalModel} ` +
              `route=chatgpt_native_compact compact_model=${selection.upstreamModel} ` +
              `request_bytes=${Buffer.byteLength(compactText)}`,
          );
          upstream.send(compactText);
          return;
        }
        const started = Date.now();
        try {
          const { summary, responseId, usage } =
            await generateExternalCompactionFallback(req, payload);
          const events = compactionEvents(summary, originalModel, responseId, usage);
          sendWebSocketJson(socket, events.outputDone);
          sendWebSocketJson(socket, events.completed);
          log(
            `WS /v1/responses model=${originalModel} route=chatgpt_compact ` +
              `compact_model=${COMPACT_MODEL} status=200 duration_ms=${Date.now() - started}`,
          );
        } catch (error) {
          sendWebSocketError(socket, 502, `Third-party compaction fallback failed: ${error.message}`);
        }
        return;
      }

      if (selection.route === "external" && hasNativeCompaction(payload)) {
        try {
          await bridgeNativeCompactionForExternal(req, payload, originalModel);
        } catch (error) {
          sendWebSocketError(
            socket,
            502,
            `Could not bridge native GPT compaction for portable routing: ${error.message}`,
            "native_compaction_bridge_failed",
          );
          return;
        }
      }

      if (selection.route === "hybrid_final") {
        const controller = new AbortController();
        activeHybridController = controller;
        const stopKeepalive = startHybridKeepalive(socket);
        try {
          const result = await runHybridFinalResponse(
            req,
            payload,
            originalModel,
            selection,
            { signal: controller.signal },
          );
          sendSseRecordsToWebSocket(socket, result.records);
        } catch (error) {
          if (isAbortError(error) || socket.readyState !== WebSocket.OPEN) {
            log(
              `WS /v1/responses model=${originalModel} ` +
                "route=hybrid_final canceled=local_socket_closed",
            );
            return;
          }
          sendWebSocketError(
            socket,
            502,
            `Hybrid final response failed: ${error.message}`,
            "hybrid_final_failed",
          );
        } finally {
          const keepalivePings = stopKeepalive();
          if (keepalivePings > 0) {
            log(
              `WS /v1/responses model=${originalModel} ` +
                `route=hybrid_keepalive pings=${keepalivePings}`,
            );
          }
          if (activeHybridController === controller) {
            activeHybridController = null;
          }
        }
        return;
      }

      if (selection.apiProtocol === "anthropic_messages") {
        await streamAnthropicMessagesToWebSocket(
          req,
          socket,
          payload,
          originalModel,
          selection,
        );
      } else {
        await streamExternalHttpToWebSocket(
          req,
          socket,
          payload,
          originalModel,
          selection,
        );
      }
    }).catch((error) => {
      log(`WS /v1/responses handler_error=${error.stack || error.message}`);
      sendWebSocketError(socket, 502, error.message);
    });
  });

  socket.once("close", () => {
    if (activeHybridController && !activeHybridController.signal.aborted) {
      activeHybridController.abort(abortError("local websocket closed"));
    }
    if (chatgptSocket && chatgptSocket.readyState < WebSocket.CLOSING) {
      chatgptSocket[EXPECTED_UPSTREAM_CLOSE] = true;
      chatgptSocket.close(1000, "local client closed");
    }
  });
}

const server = http.createServer(async (req, res) => {
  const path = requestPath(req.url);

  if (req.method === "GET" && (path === "/healthz" || path === "/v1/healthz")) {
    sendJson(res, 200, {
      ok: true,
      bind: `${HOST}:${PORT}`,
      proxy: PROXY_HOST && PROXY_PORT ? `${PROXY_HOST}:${PROXY_PORT}` : "direct",
      config_path: CONFIG_PATH,
      external_provider: EXTERNAL_PROVIDER.name,
      external_models: Object.fromEntries(EXTERNAL_MODELS),
      hybrid_final_models: Object.fromEntries(HYBRID_FINAL_MODELS),
    });
    return;
  }

  if (req.method === "GET" && path.startsWith("/v1/models")) {
    try {
      sendJson(res, 200, { models: loadCatalog() });
    } catch (error) {
      sendJson(res, 500, errorBody(error.message, "catalog_read_error"));
    }
    return;
  }

  if (
    req.method === "POST" &&
    (path === "/v1/alpha/search" || path.startsWith("/v1/alpha/search?"))
  ) {
    try {
      let body = await collectBody(req);
      body = decodeRequestBody(req, body);
      await forward(req, res, "chatgpt", body, "web-search", "web-search");
    } catch (error) {
      sendJson(res, 400, errorBody(error.message, "invalid_search_request"));
    }
    return;
  }

  if (
    req.method !== "POST" ||
    !(path.startsWith("/v1/responses") || path.startsWith("/responses"))
  ) {
    sendJson(res, 404, errorBody("Unsupported local router endpoint", "unsupported_endpoint"));
    return;
  }

  let rawBody;
  let payload;
  try {
    rawBody = await collectBody(req);
    rawBody = decodeRequestBody(req, rawBody);
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch (error) {
    sendJson(res, 400, errorBody(error.message, "invalid_json"));
    return;
  }

  const selection = classifyModel(payload.model);
  if (!selection) {
    log(`${req.method} ${path} model=${String(payload.model)} route=rejected`);
    sendJson(
      res,
      400,
      errorBody(`Model is not allowed by the local router: ${String(payload.model)}`, "model_not_allowed"),
    );
    return;
  }

  const originalModel = payload.model;
  if (selection.route === "hybrid_final" && isRemoteCompactionV2(payload)) {
    await runHybridNativeCompaction(
      req,
      res,
      payload,
      originalModel,
      selection,
    );
    return;
  }
  if (selection.route === "external" && isRemoteCompactionV2(payload)) {
    await runExternalCompactionFallback(req, res, payload, originalModel);
    return;
  }
  if (selection.route === "external" && hasNativeCompaction(payload)) {
    try {
      await bridgeNativeCompactionForExternal(req, payload, originalModel);
    } catch (error) {
      sendJson(
        res,
        502,
        errorBody(
          `Could not bridge native GPT compaction for portable routing: ${error.message}`,
          "native_compaction_bridge_failed",
        ),
      );
      return;
    }
  }
  if (selection.route === "hybrid_final") {
    try {
      const result = await runHybridFinalResponse(
        req,
        payload,
        originalModel,
        selection,
      );
      sendSseRecordsToHttp(res, result.records);
    } catch (error) {
      sendJson(
        res,
        502,
        errorBody(`Hybrid final response failed: ${error.message}`, "hybrid_final_failed"),
      );
    }
    return;
  }
  if (selection.apiProtocol === "anthropic_messages") {
    await streamAnthropicMessagesToHttp(
      req,
      res,
      payload,
      originalModel,
      selection,
    );
    return;
  }
  preparePayloadForRoute(payload, selection, originalModel);
  const body = Buffer.from(JSON.stringify(payload));
  await forward(
    req,
    res,
    selection.route,
    body,
    originalModel,
    selection.upstreamModel,
  );
});

const websocketServer = new WebSocketServer({ noServer: true, perMessageDeflate: true });
websocketServer.on("connection", handleLocalWebSocket);

server.on("upgrade", (req, socket, head) => {
  const path = requestPath(req.url);
  if (!(path === "/v1/responses" || path === "/responses")) {
    socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    return;
  }
  websocketServer.handleUpgrade(req, socket, head, (client) => {
    websocketServer.emit("connection", client, req);
  });
});

server.requestTimeout = 0;
server.headersTimeout = 30_000;
server.listen(PORT, HOST, () => {
  const proxy = PROXY_HOST && PROXY_PORT
    ? `http://${PROXY_HOST}:${PROXY_PORT}`
    : "direct";
  log(
    `listening=http://${HOST}:${PORT} proxy=${proxy} ` +
      `external_provider=${EXTERNAL_PROVIDER.name} config=${CONFIG_PATH}`,
  );
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
