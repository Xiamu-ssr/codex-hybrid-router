#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";

const auth = JSON.parse(fs.readFileSync(`${os.homedir()}/.codex/auth.json`, "utf8"));
const port = Number(process.env.CODEX_ROUTER_PORT || 10100);
const model =
  process.env.CODEX_ROUTER_HYBRID_MODEL || "hybrid/gpt-5.6-sol-claude-final";

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
    instructions:
      "Use web search and answer with the current title of the official OpenAI homepage.",
    input: [{
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Search the web now and answer." }],
    }],
    tools: [{ type: "web_search" }],
    tool_choice: "required",
    parallel_tool_calls: false,
    reasoning: { effort: "low", summary: "auto" },
    store: false,
    stream: true,
    include: ["reasoning.encrypted_content"],
  }),
});

const body = await response.text();
if (!response.ok) throw new Error(`HTTP ${response.status}: ${body.slice(0, 1000)}`);

const outputTypes = [];
let text = "";
let completedId = null;
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

if (outputTypes.includes("web_search_call")) {
  throw new Error(`Claude finalizer unexpectedly repeated web search: ${outputTypes.join(",")}`);
}
if (!outputTypes.includes("message") || !text.trim()) {
  throw new Error(`Claude finalizer returned no final message: ${outputTypes.join(",")}`);
}
if (completedId !== "") {
  throw new Error(`hybrid web-search response id was not cleared: ${completedId}`);
}
process.stdout.write("hybrid_claude_final_without_second_search_ok\n");
