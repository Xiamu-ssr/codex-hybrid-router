#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import WebSocket from "ws";

const auth = JSON.parse(fs.readFileSync(`${os.homedir()}/.codex/auth.json`, "utf8"));
const accessToken = auth.tokens.access_token;
const accountId = auth.tokens.account_id;
const port = Number(process.env.CODEX_ROUTER_PORT || 10100);
const requestedModel = process.argv[2] || "zenmux/grok-4.6";
const timeout = setTimeout(() => {
  console.error("timeout");
  process.exit(2);
}, 120_000);

const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/responses`, {
  headers: {
    authorization: `Bearer ${accessToken}`,
    "chatgpt-account-id": accountId,
    "openai-beta": "responses_websockets=2026-02-06",
    "session-id": `router-selftest-${Date.now()}`,
    "thread-id": `router-selftest-${Date.now()}`,
    "x-codex-routing-hint": `model=${requestedModel}`,
  },
});

socket.once("open", () => {
  console.log("open");
  socket.send(JSON.stringify({
    type: "response.create",
    model: requestedModel,
    instructions: "Reply with exactly ROUTER_OK and nothing else.",
    input: [{
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Reply with exactly ROUTER_OK" }],
    }],
    tools: [],
    tool_choice: "none",
    parallel_tool_calls: false,
    reasoning: { effort: "low", summary: "auto" },
    store: false,
    stream: true,
    include: ["reasoning.encrypted_content"],
    client_metadata: {},
  }));
});

socket.on("message", (data) => {
  const event = JSON.parse(data.toString("utf8"));
  console.log(event.type, event.response?.id ?? event.item?.type ?? event.error?.message ?? "");
  if (event.type === "error") {
    clearTimeout(timeout);
    socket.close();
    process.exitCode = 1;
  }
  if (event.type === "response.completed") {
    clearTimeout(timeout);
    socket.close();
  }
});

socket.on("error", (error) => {
  clearTimeout(timeout);
  console.error(error.message);
  process.exitCode = 1;
});
