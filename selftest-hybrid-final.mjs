#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import WebSocket from "ws";

const auth = JSON.parse(fs.readFileSync(`${os.homedir()}/.codex/auth.json`, "utf8"));
const port = Number(process.env.CODEX_ROUTER_PORT || 10100);
const model =
  process.env.CODEX_ROUTER_HYBRID_MODEL || "hybrid/gpt-5.6-sol-claude-final";
const timeout = setTimeout(() => {
  console.error("timeout");
  process.exit(2);
}, 240_000);

let phase = "final";
let finalText = "";
let sawToolCall = false;

const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/responses`, {
  headers: {
    authorization: `Bearer ${auth.tokens.access_token}`,
    "chatgpt-account-id": auth.tokens.account_id,
    "openai-beta": "responses_websockets=2026-02-06",
    "session-id": `router-hybrid-final-${Date.now()}`,
    "thread-id": `router-hybrid-final-${Date.now()}`,
    "x-codex-routing-hint": `model=${model}`,
  },
});

const common = {
  type: "response.create",
  model,
  parallel_tool_calls: false,
  reasoning: { effort: "low", summary: "auto" },
  store: false,
  stream: true,
  include: ["reasoning.encrypted_content"],
  client_metadata: {},
};

socket.once("open", () => {
  socket.send(JSON.stringify({
    ...common,
    instructions:
      "This is a two-stage handoff test. If the latest user message asks you to finalize " +
      "an immediately preceding assistant draft whose complete text is SOL_DRAFT_VISIBLE, " +
      "reply with exactly HYBRID_FINAL_OK. Otherwise reply with exactly SOL_DRAFT_VISIBLE.",
    input: [{
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Start the two-stage handoff test." }],
    }],
    tools: [],
    tool_choice: "none",
  }));
});

socket.on("message", (data) => {
  const event = JSON.parse(data.toString("utf8"));
  if (event.type === "error") {
    console.error(event.error?.message || JSON.stringify(event));
    clearTimeout(timeout);
    process.exitCode = 1;
    socket.close();
    return;
  }
  if (phase === "final" && event.type === "response.output_text.delta") {
    finalText += event.delta || "";
  }
  if (
    phase === "tool" &&
    event.type === "response.output_item.done" &&
    event.item?.type === "function_call"
  ) {
    sawToolCall = true;
  }
  if (event.type !== "response.completed") return;
  if (event.response?.id !== "") {
    console.error(`hybrid response id was not cleared: ${event.response?.id}`);
    process.exitCode = 1;
    clearTimeout(timeout);
    socket.close();
    return;
  }

  if (phase === "final") {
    if (finalText.trim() !== "HYBRID_FINAL_OK") {
      console.error(`unexpected hybrid final text: ${JSON.stringify(finalText)}`);
      process.exitCode = 1;
      clearTimeout(timeout);
      socket.close();
      return;
    }
    console.log("hybrid_claude_final_ok");
    phase = "tool";
    socket.send(JSON.stringify({
      ...common,
      instructions: "Call the lookup tool exactly once.",
      input: [{
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Use lookup now." }],
      }],
      tools: [{
        type: "function",
        name: "lookup",
        description: "Synthetic test tool.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      }],
      tool_choice: "required",
    }));
    return;
  }

  if (!sawToolCall) {
    console.error("GPT tool turn was incorrectly replaced by the Claude finalizer");
    process.exitCode = 1;
  } else {
    console.log("hybrid_gpt_tool_passthrough_ok");
  }
  clearTimeout(timeout);
  socket.close();
});

socket.on("error", (error) => {
  clearTimeout(timeout);
  console.error(error.message);
  process.exitCode = 1;
});
