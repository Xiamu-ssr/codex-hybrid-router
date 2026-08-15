import assert from "node:assert/strict";
import {
  appendFinalizerHandoff,
  CLAUDE_FINALIZER_INSTRUCTIONS,
} from "../lib/finalizer-handoff.mjs";
import { AnthropicResponsesBridge } from "../lib/anthropic-responses-bridge.mjs";

const originalInput = [
  {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "完成任务" }],
  },
  {
    type: "custom_tool_call",
    call_id: "call_1",
    name: "exec",
    input: "const result = await tools.exec_command({cmd: 'true'});",
  },
  {
    type: "custom_tool_call_output",
    call_id: "call_1",
    output: "success",
  },
  {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: "工具执行成功。" }],
  },
];
const payload = {
  instructions: "原始 system 指令",
  input: structuredClone(originalInput),
  tools: [{ type: "custom", name: "exec" }],
  tool_choice: "required",
  parallel_tool_calls: true,
};
const agentResponse = {
  output: [
    { type: "reasoning", encrypted_content: "provider-specific" },
    {
      id: "msg_openai_only",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "SOL_DRAFT_VISIBLE" }],
    },
  ],
};

const result = appendFinalizerHandoff(payload, agentResponse);

assert.equal(result.draftMessages, 1);
assert.equal(result.toolEvidenceItems, 2);
assert.equal(payload.input[1].type, "function_call");
assert.equal(payload.input[1].call_id, "call_1");
assert.deepEqual(JSON.parse(payload.input[1].arguments), {
  input: "const result = await tools.exec_command({cmd: 'true'});",
});
assert.deepEqual(payload.input[2], {
  type: "function_call_output",
  call_id: "call_1",
  output: "success",
});
assert.deepEqual(payload.input[3], originalInput[3]);
assert.equal(payload.input.at(-2).role, "assistant");
assert.equal(payload.input.at(-2).content[0].text, "SOL_DRAFT_VISIBLE");
assert.equal(payload.input.at(-2).id, undefined);
assert.equal(payload.input.at(-1).role, "user");
assert.match(payload.input.at(-1).content[0].text, /终审/);
assert.match(payload.instructions, /^原始 system 指令/);
assert(payload.instructions.includes(CLAUDE_FINALIZER_INSTRUCTIONS));
assert.deepEqual(payload.tools, []);
assert.equal(payload.tool_choice, undefined);
assert.equal(payload.parallel_tool_calls, false);

const anthropic = new AnthropicResponsesBridge({
  ...payload,
  model: "claude-opus-5",
  stream: true,
});
const toolUse = anthropic.request.messages
  .flatMap((message) => message.content || [])
  .find((block) => block?.type === "tool_use");
const toolResult = anthropic.request.messages
  .flatMap((message) => message.content || [])
  .find((block) => block?.type === "tool_result");
assert.deepEqual(toolUse, {
  type: "tool_use",
  id: "call_1",
  name: "exec",
  input: {
    input: "const result = await tools.exec_command({cmd: 'true'});",
  },
});
assert.deepEqual(toolResult, {
  type: "tool_result",
  tool_use_id: "call_1",
  content: [{ type: "text", text: "success" }],
});

process.stdout.write("finalizer_handoff_ok\n");
