export const CLAUDE_FINALIZER_INSTRUCTIONS =
  "Agent 阶段已经完成。上一条 assistant 回复是待审查草稿。" +
  "请结合完整对话和工具结果，独立核对后直接向用户输出最终回复。" +
  "不得调用工具；此前的 tool call/output 已由 Agent 执行，output 是事实依据，" +
  "当前没有工具定义不代表执行失败。除非 output 明确报错，否则不得声称工具失效或未执行。" +
  "以时间较新的工具结果覆盖 checkpoint 或较早 assistant 中的旧状态。" +
  "不要提及模型交接，也不要虚构上下文中没有发生的操作或证据。只输出一次最终回复。";

const FINALIZER_TRIGGER =
  "请现在针对此前最后一条真实用户请求执行上述终审，并直接输出最终回复。";

function messageHasPlainOutputText(item) {
  if (item?.type !== "message" || !Array.isArray(item.content)) return false;
  if (item.content.some((part) => part?.type === "refusal")) return false;
  return item.content.some(
    (part) =>
      part?.type === "output_text" &&
      typeof part.text === "string" &&
      part.text.trim(),
  );
}

function agentDraftMessages(agentResponse) {
  if (!Array.isArray(agentResponse?.output)) return [];
  return agentResponse.output
    .filter(messageHasPlainOutputText)
    .map((item) => ({
      type: "message",
      role: "assistant",
      content: structuredClone(item.content),
    }));
}

function portableArguments(input) {
  if (input && typeof input === "object") return JSON.stringify(input);
  if (typeof input !== "string") return "{}";
  try {
    const parsed = JSON.parse(input);
    return JSON.stringify(
      parsed && typeof parsed === "object" ? parsed : { input: parsed },
    );
  } catch {
    return JSON.stringify({ input });
  }
}

function portableOutput(output) {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) {
    return output.map((part) => {
      if (typeof part === "string") return part;
      if (typeof part?.text === "string") return part.text;
      return JSON.stringify(part);
    }).join("\n");
  }
  return output == null ? "" : JSON.stringify(output);
}

function makeHistoricalToolEvidencePortable(payload) {
  if (!Array.isArray(payload.input)) return 0;
  let converted = 0;
  payload.input = payload.input.map((item) => {
    if (item?.type === "custom_tool_call") {
      converted += 1;
      return {
        type: "function_call",
        call_id: item.call_id,
        name: item.name || "client_tool",
        arguments: portableArguments(item.input),
        status: item.status || "completed",
      };
    }
    if (item?.type === "custom_tool_call_output") {
      converted += 1;
      return {
        type: "function_call_output",
        call_id: item.call_id,
        output: portableOutput(item.output),
      };
    }
    return item;
  });
  return converted;
}

export function appendFinalizerHandoff(payload, agentResponse) {
  const originalInstructions =
    typeof payload.instructions === "string" ? payload.instructions.trim() : "";
  payload.instructions = originalInstructions
    ? `${originalInstructions}\n\n${CLAUDE_FINALIZER_INSTRUCTIONS}`
    : CLAUDE_FINALIZER_INSTRUCTIONS;

  // Historical tool calls and outputs stay in payload.input as evidence. Only
  // remove the finalizer's ability to start another tool loop.
  payload.tools = [];
  delete payload.tool_choice;
  payload.parallel_tool_calls = false;
  const toolEvidenceItems = makeHistoricalToolEvidencePortable(payload);

  if (!Array.isArray(payload.input)) payload.input = [];
  const drafts = agentDraftMessages(agentResponse);
  payload.input.push(...drafts);
  payload.input.push({
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: FINALIZER_TRIGGER }],
  });
  return { draftMessages: drafts.length, toolEvidenceItems };
}
