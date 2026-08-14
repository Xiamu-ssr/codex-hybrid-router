#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "codex-hybrid-router-"));
const catalogPath = path.join(temporary, "model-catalog.json");
const configPath = path.join(root, "config.example.json");
const fixture = {
  models: [
    {
      slug: "gpt-5.4-mini",
      display_name: "GPT template",
      priority: 100,
      context_window: 200000,
      max_context_window: 200000,
      auto_compact_token_limit: 180000,
      base_instructions: "You are Codex, a coding agent based on GPT-5.",
      supported_reasoning_levels: [{ effort: "high", description: "high" }]
    },
    {
      slug: "gpt-5.6-sol",
      display_name: "GPT-5.6 Sol",
      priority: 1,
      context_window: 300000,
      max_context_window: 300000,
      auto_compact_token_limit: 268000,
      base_instructions: "You are Codex, a coding agent based on GPT-5.",
      supported_reasoning_levels: [
        { effort: "low", description: "low" },
        { effort: "max", description: "max" }
      ]
    }
  ]
};
fs.writeFileSync(catalogPath, JSON.stringify(fixture));

const update = spawnSync(process.execPath, [path.join(root, "update-model-catalog.mjs")], {
  env: {
    ...process.env,
    CODEX_ROUTER_CONFIG: configPath,
    CODEX_MODEL_CATALOG: catalogPath,
  },
  encoding: "utf8",
});
assert.equal(update.status, 0, update.stderr);
const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
assert(catalog.models.some((model) => model.slug === "zenmux/claude-opus-5"));
assert(catalog.models.some((model) => model.slug === "hybrid/gpt-5.6-sol-claude-final"));

const removeCatalogEntries = spawnSync(
  process.execPath,
  [path.join(root, "update-model-catalog.mjs"), "--remove"],
  {
    env: {
      ...process.env,
      CODEX_ROUTER_CONFIG: configPath,
      CODEX_MODEL_CATALOG: catalogPath,
    },
    encoding: "utf8",
  },
);
assert.equal(removeCatalogEntries.status, 0, removeCatalogEntries.stderr);
const cleanedCatalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
assert(!cleanedCatalog.models.some((model) => model.slug === "zenmux/claude-opus-5"));
assert(!cleanedCatalog.models.some((model) => model.slug.startsWith("hybrid/")));

const reinstallCatalogEntries = spawnSync(
  process.execPath,
  [path.join(root, "update-model-catalog.mjs")],
  {
    env: {
      ...process.env,
      CODEX_ROUTER_CONFIG: configPath,
      CODEX_MODEL_CATALOG: catalogPath,
    },
    encoding: "utf8",
  },
);
assert.equal(reinstallCatalogEntries.status, 0, reinstallCatalogEntries.stderr);

const codexConfigPath = path.join(temporary, "config.toml");
const originalConfig = [
  'personality = "pragmatic"',
  'model_provider = "previous-provider"',
  'openai_base_url = "https://previous.example/v1"',
  "",
].join("\n");
fs.writeFileSync(codexConfigPath, originalConfig);
const patchConfig = spawnSync(
  process.execPath,
  [path.join(root, "scripts", "patch-codex-config.mjs")],
  {
    env: { ...process.env, CODEX_HOME: temporary, CODEX_ROUTER_PORT: "19123" },
    encoding: "utf8",
  },
);
assert.equal(patchConfig.status, 0, patchConfig.stderr);
const patchedConfig = fs.readFileSync(codexConfigPath, "utf8");
assert.match(patchedConfig, /^forced_login_method = "chatgpt"$/m);
assert.match(patchedConfig, /^model_provider = "openai"$/m);
assert.match(patchedConfig, /^openai_base_url = "http:\/\/127\.0\.0\.1:19123\/v1"$/m);
assert.match(patchedConfig, /^personality = "pragmatic"$/m);
assert(fs.existsSync(path.join(temporary, "hybrid-router-install-state.json")));

const unpatchConfig = spawnSync(
  process.execPath,
  [path.join(root, "scripts", "patch-codex-config.mjs"), "--uninstall"],
  {
    env: { ...process.env, CODEX_HOME: temporary, CODEX_ROUTER_PORT: "19123" },
    encoding: "utf8",
  },
);
assert.equal(unpatchConfig.status, 0, unpatchConfig.stderr);
const restoredConfig = fs.readFileSync(codexConfigPath, "utf8");
assert.match(restoredConfig, /^model_provider = "previous-provider"$/m);
assert.match(restoredConfig, /^openai_base_url = "https:\/\/previous\.example\/v1"$/m);
assert.doesNotMatch(restoredConfig, /^forced_login_method\s*=/m);
assert.doesNotMatch(restoredConfig, /^model_catalog_json\s*=/m);
assert(!fs.existsSync(path.join(temporary, "hybrid-router-install-state.json")));

const repatchConfig = spawnSync(
  process.execPath,
  [path.join(root, "scripts", "patch-codex-config.mjs")],
  {
    env: { ...process.env, CODEX_HOME: temporary, CODEX_ROUTER_PORT: "19123" },
    encoding: "utf8",
  },
);
assert.equal(repatchConfig.status, 0, repatchConfig.stderr);
const manuallyChangedConfig = fs.readFileSync(codexConfigPath, "utf8").replace(
  /^openai_base_url = .*$/m,
  'openai_base_url = "https://user-changed.example/v1"',
);
fs.writeFileSync(codexConfigPath, manuallyChangedConfig);
const safeUnpatchConfig = spawnSync(
  process.execPath,
  [path.join(root, "scripts", "patch-codex-config.mjs"), "--uninstall"],
  {
    env: { ...process.env, CODEX_HOME: temporary, CODEX_ROUTER_PORT: "19123" },
    encoding: "utf8",
  },
);
assert.equal(safeUnpatchConfig.status, 0, safeUnpatchConfig.stderr);
assert.match(
  fs.readFileSync(codexConfigPath, "utf8"),
  /^openai_base_url = "https:\/\/user-changed\.example\/v1"$/m,
);

const plistPath = path.join(temporary, "dev.codex-hybrid-router.plist");
const writePlist = spawnSync(
  process.execPath,
  [path.join(root, "scripts", "write-launch-agent.mjs")],
  {
    env: {
      ...process.env,
      CODEX_HOME: temporary,
      CODEX_ROUTER_CONFIG: configPath,
      CODEX_ROUTER_PLIST_PATH: plistPath,
    },
    encoding: "utf8",
  },
);
assert.equal(writePlist.status, 0, writePlist.stderr);
assert.match(fs.readFileSync(plistPath, "utf8"), /dev\.codex-hybrid-router/);

const port = 19000 + Math.floor(Math.random() * 1000);
const router = spawn(process.execPath, [path.join(root, "router.mjs")], {
  env: {
    ...process.env,
    CODEX_HOME: temporary,
    CODEX_ROUTER_CONFIG: configPath,
    CODEX_ROUTER_MODEL_CATALOG: catalogPath,
    CODEX_ROUTER_PORT: String(port),
    CODEX_ROUTER_PROXY_HOST: "",
    CODEX_ROUTER_PROXY_PORT: "",
  },
  stdio: ["ignore", "ignore", "pipe"],
});
let stderr = "";
router.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });

try {
  let health = null;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.ok) {
        health = await response.json();
        break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert(health, `router did not start: ${stderr}`);
  assert.equal(health.external_provider, "ZenMux");
  assert.equal(health.proxy, "direct");
  assert(health.external_models["zenmux/kimi-k3"]);
} finally {
  router.kill("SIGTERM");
  fs.rmSync(temporary, { recursive: true, force: true });
}

process.stdout.write("smoke_ok\n");
