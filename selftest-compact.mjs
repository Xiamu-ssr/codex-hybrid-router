#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import WebSocket from "ws";

const auth = JSON.parse(fs.readFileSync(`${os.homedir()}/.codex/auth.json`, "utf8"));
const port = Number(process.env.CODEX_ROUTER_PORT || 10100);
const model = process.env.CODEX_ROUTER_EXTERNAL_MODEL || "zenmux/grok-4.6";
const timeout = setTimeout(() => {
  console.error("timeout");
  process.exit(2);
}, 180_000);
let compactItem = null;
let phase = "compact";
let followupText = "";

const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/responses`, {
  headers: {
    authorization: `Bearer ${auth.tokens.access_token}`,
    "chatgpt-account-id": auth.tokens.account_id,
    "openai-beta": "responses_websockets=2026-02-06",
    "session-id": `router-compact-selftest-${Date.now()}`,
    "thread-id": `router-compact-selftest-${Date.now()}`,
    "x-codex-routing-hint": `model=${model}`,
  },
});

const base = {
  type: "response.create",
  model,
  instructions: "Follow the supplied context checkpoint. Reply concisely.",
  tools: [],
  parallel_tool_calls: false,
  reasoning: { effort: "low", summary: "auto" },
  store: false,
  stream: true,
  include: ["reasoning.encrypted_content"],
  client_metadata: {},
};

socket.once("open", () => {
  socket.send(JSON.stringify({
    ...base,
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Remember: the secret word is ORANGE." }],
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
  if (phase === "compact" && event.type === "response.output_item.done") {
    compactItem = event.item;
  }
  if (phase === "followup" && event.type === "response.output_text.delta") {
    followupText += event.delta || "";
  }
  if (event.type !== "response.completed") return;

  if (phase === "compact") {
    if (compactItem?.type !== "compaction" ||
        !compactItem.encrypted_content?.startsWith("codex-hybrid-summary-v1:")) {
      console.error("missing portable compaction item");
      process.exitCode = 1;
      socket.close();
      return;
    }
    console.log("compact_ok");
    phase = "followup";
    socket.send(JSON.stringify({
      ...base,
      input: [
        compactItem,
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "What was the secret word? Reply with only it." }],
        },
      ],
    }));
    return;
  }

  if (!followupText.toUpperCase().includes("ORANGE")) {
    console.error(`follow-up lost compacted context: ${followupText}`);
    process.exitCode = 1;
  } else {
    console.log(`followup_ok:${followupText.trim()}`);
  }
  clearTimeout(timeout);
  socket.close();
});
