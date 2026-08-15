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

const instructions =
  "This is a two-stage tool-evidence handoff test. On the first request, call lookup exactly " +
  "once. When a lookup result containing VERIFIED_TOOL_VALUE=COBALT is present but no later " +
  "assistant draft is present, reply exactly SOL_CONFIRMS_COBALT. When that tool result and an " +
  "immediately preceding assistant draft equal to SOL_CONFIRMS_COBALT are both present, reply " +
  "exactly OPUS_CONFIRMS_COBALT.";
const userMessage = {
  type: "message",
  role: "user",
  content: [{ type: "input_text", text: "Run the tool-evidence handoff test." }],
};
const lookupTool = {
  type: "function",
  name: "lookup",
  description: "Returns the synthetic verified value.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
};
const common = {
  type: "response.create",
  model,
  instructions,
  parallel_tool_calls: false,
  reasoning: { effort: "low", summary: "auto" },
  store: false,
  stream: true,
  include: ["reasoning.encrypted_content"],
  client_metadata: {},
};

let phase = "tool";
let firstOutput = [];
let finalText = "";
const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/responses`, {
  headers: {
    authorization: `Bearer ${auth.tokens.access_token}`,
    "chatgpt-account-id": auth.tokens.account_id,
    "openai-beta": "responses_websockets=2026-02-06",
    "session-id": `router-hybrid-tool-evidence-${Date.now()}`,
    "thread-id": `router-hybrid-tool-evidence-${Date.now()}`,
    "x-codex-routing-hint": `model=${model}`,
  },
});

socket.once("open", () => {
  socket.send(JSON.stringify({
    ...common,
    input: [userMessage],
    tools: [lookupTool],
    tool_choice: "required",
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
  if (phase === "tool" && event.type === "response.output_item.done" && event.item) {
    firstOutput.push(event.item);
  }
  if (phase === "final" && event.type === "response.output_text.delta") {
    finalText += event.delta || "";
  }
  if (event.type !== "response.completed") return;

  if (phase === "tool") {
    const call = firstOutput.find((item) => item?.type === "function_call");
    if (!call?.call_id) {
      console.error(`missing function call: ${firstOutput.map((item) => item?.type).join(",")}`);
      process.exitCode = 1;
      clearTimeout(timeout);
      socket.close();
      return;
    }
    phase = "final";
    socket.send(JSON.stringify({
      ...common,
      input: [
        userMessage,
        ...firstOutput,
        {
          type: "function_call_output",
          call_id: call.call_id,
          output: "VERIFIED_TOOL_VALUE=COBALT",
        },
      ],
      tools: [lookupTool],
      tool_choice: "none",
    }));
    return;
  }

  if (finalText.trim() !== "OPUS_CONFIRMS_COBALT") {
    console.error(`unexpected tool-evidence final text: ${JSON.stringify(finalText)}`);
    process.exitCode = 1;
  } else {
    console.log("hybrid_claude_tool_evidence_final_ok");
  }
  clearTimeout(timeout);
  socket.close();
});

socket.on("error", (error) => {
  clearTimeout(timeout);
  console.error(error.message);
  process.exitCode = 1;
});
