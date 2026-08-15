import assert from "node:assert/strict";
import { AnthropicResponsesBridge } from "../lib/anthropic-responses-bridge.mjs";

const bridge = new AnthropicResponsesBridge(
  {
    model: "claude-opus-5",
    instructions: "stable system instructions",
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "first question" }],
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "first answer" }],
      },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "follow-up question" }],
      },
    ],
    tools: [
      {
        type: "function",
        name: "lookup",
        description: "look something up",
        parameters: { type: "object", properties: {} },
      },
    ],
    thinking: { type: "adaptive" },
    output_config: { effort: "max" },
    stream: true,
  },
  { promptCache: true, cacheTtl: "5m" },
);

assert.equal(bridge.cacheBreakpoints, 3);
assert.deepEqual(bridge.request.thinking, { type: "adaptive" });
assert.equal(bridge.request.output_config.effort, "max");
assert.deepEqual(bridge.request.tools.at(-1).cache_control, { type: "ephemeral" });
assert.deepEqual(bridge.request.system.at(-1).cache_control, { type: "ephemeral" });
assert.deepEqual(bridge.request.cache_control, { type: "ephemeral" });
assert.equal(
  bridge.request.messages.at(-1).content.at(-1).cache_control,
  undefined,
);

const converted = [];
for (const event of [
  {
    type: "message_start",
    message: {
      id: "msg_test",
      model: "claude-opus-5",
      role: "assistant",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      type: "message",
      usage: {
        input_tokens: 10,
        output_tokens: 0,
        cache_read_input_tokens: 1200,
        cache_creation_input_tokens: 25,
      },
    },
  },
  {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  },
  {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: "ok" },
  },
  { type: "content_block_stop", index: 0 },
  {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: 1 },
  },
  { type: "message_stop" },
]) {
  converted.push(...bridge.convertEvent(event));
}

const completed = converted.find((event) => event.type === "response.completed");
assert(completed);
assert.equal(completed.response.id, "");
assert.equal(completed.response.usage.input_tokens_details.cached_tokens, 1200);
assert.equal(completed.response.usage.input_tokens, 1235);

process.stdout.write("anthropic_prompt_cache_bridge_ok\n");
