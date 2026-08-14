#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";

const auth = JSON.parse(fs.readFileSync(`${os.homedir()}/.codex/auth.json`, "utf8"));
const port = Number(process.env.CODEX_ROUTER_PORT || 10100);
const model =
  process.env.CODEX_ROUTER_HYBRID_MODEL || "hybrid/gpt-5.6-sol-claude-final";
const effort = process.env.CODEX_ROUTER_EFFORT || "low";
const poisonReasoning = process.env.CODEX_ROUTER_POISON_REASONING === "1";
const input = [{
  type: "message",
  role: "user",
  content: [{ type: "input_text", text: "Reply with exactly HYBRID_HTTP_OK" }],
}];
if (poisonReasoning) {
  input.unshift({
    type: "reasoning",
    id: "rs_router_unpersisted_selftest",
    summary: [],
    content: null,
    encrypted_content: null,
  });
}

const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${auth.tokens.access_token}`,
    "chatgpt-account-id": auth.tokens.account_id,
    "content-type": "application/json",
    "x-codex-routing-hint": `model=${model}`,
  },
  body: JSON.stringify({
    model,
    instructions: "Reply with exactly HYBRID_HTTP_OK and nothing else.",
    input,
    tools: [],
    tool_choice: "none",
    parallel_tool_calls: false,
    reasoning: { effort, summary: "auto" },
    store: false,
    stream: true,
    include: ["reasoning.encrypted_content"],
  }),
});

const body = await response.text();
if (!response.ok) throw new Error(`HTTP ${response.status}: ${body.slice(0, 1000)}`);

let text = "";
let completedId = null;
const outputTypes = [];
for (const block of body.split(/\r?\n\r?\n/)) {
  const data = block
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (!data || data === "[DONE]") continue;
  const event = JSON.parse(data);
  if (event.type === "response.output_item.done" && event.item?.type) {
    outputTypes.push(event.item.type);
  }
  if (event.type === "response.output_text.delta") text += event.delta || "";
  if (event.type === "response.completed") completedId = event.response?.id;
}

if (text.trim() !== "HYBRID_HTTP_OK") {
  throw new Error(`unexpected hybrid HTTP text: ${JSON.stringify(text)}`);
}
if (completedId !== "") {
  throw new Error(`hybrid HTTP response id was not cleared: ${completedId}`);
}
if (outputTypes.includes("reasoning")) {
  throw new Error("Claude reasoning item leaked into Codex-visible hybrid response");
}
process.stdout.write("hybrid_http_claude_final_ok\n");
