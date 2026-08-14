#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import WebSocket from "ws";

const auth = JSON.parse(fs.readFileSync(`${os.homedir()}/.codex/auth.json`, "utf8"));
const gptModel = "gpt-5.6-sol";
const followupModel =
  process.env.CODEX_ROUTER_FOLLOWUP_MODEL || "zenmux/grok-4.6";
const port = Number(process.env.CODEX_ROUTER_PORT || 10100);
const timeout = setTimeout(() => {
  console.error("timeout");
  process.exit(2);
}, 240_000);
let phase = "gpt_compact";
let nativeCompaction = null;
let followupText = "";

const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/responses`, {
  headers: {
    authorization: `Bearer ${auth.tokens.access_token}`,
    "chatgpt-account-id": auth.tokens.account_id,
    "openai-beta": "responses_websockets=2026-02-06",
    "session-id": `router-native-bridge-${Date.now()}`,
    "thread-id": `router-native-bridge-${Date.now()}`,
    "x-codex-routing-hint": `model=${gptModel}`,
  },
});

const common = {
  type: "response.create",
  instructions: "Follow the supplied conversation context. Reply concisely.",
  tools: [],
  parallel_tool_calls: false,
  store: false,
  stream: true,
  include: ["reasoning.encrypted_content"],
  client_metadata: {},
};

socket.once("open", () => {
  socket.send(JSON.stringify({
    ...common,
    model: gptModel,
    reasoning: { effort: "low", summary: "auto" },
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Remember: the bridge secret is COBALT." }],
      },
      { type: "compaction_trigger" },
    ],
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
  if (phase === "gpt_compact" && event.type === "response.output_item.done" &&
      (event.item?.type === "compaction" || event.item?.type === "compaction_summary")) {
    nativeCompaction = event.item;
  }
  if (phase === "zenmux_followup" && event.type === "response.output_text.delta") {
    followupText += event.delta || "";
  }
  if (event.type !== "response.completed") return;

  if (phase === "gpt_compact") {
    if (!nativeCompaction?.encrypted_content ||
        nativeCompaction.encrypted_content.startsWith("codex-hybrid-summary-v1:")) {
      console.error("missing native GPT compaction item");
      process.exitCode = 1;
      socket.close();
      return;
    }
    console.log("native_gpt_compact_ok");
    phase = "zenmux_followup";
    socket.send(JSON.stringify({
      ...common,
      model: followupModel,
      reasoning: { effort: "low", summary: "auto" },
      input: [
        nativeCompaction,
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "What was the bridge secret? Reply with only it." }],
        },
      ],
    }));
    return;
  }

  if (!followupText.toUpperCase().includes("COBALT")) {
    console.error(`native bridge lost context: ${followupText}`);
    process.exitCode = 1;
  } else {
    console.log(`native_bridge_ok:${followupText.trim()}`);
  }
  clearTimeout(timeout);
  socket.close();
});
