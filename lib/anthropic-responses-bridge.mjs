import { ResponsesToMessagesConverter } from "@zenmux/rosetta-ai";

function cacheControl(ttl) {
  return ttl === "1h"
    ? { type: "ephemeral", ttl: "1h" }
    : { type: "ephemeral" };
}

export function addAnthropicPromptCache(request, { ttl = "5m" } = {}) {
  if (!request || typeof request !== "object") return 0;
  let breakpoints = 0;

  if (Array.isArray(request.tools) && request.tools.length > 0) {
    const lastTool = request.tools[request.tools.length - 1];
    if (lastTool && typeof lastTool === "object") {
      lastTool.cache_control = cacheControl(ttl);
      breakpoints += 1;
    }
  }

  if (typeof request.system === "string" && request.system.length > 0) {
    request.system = [
      {
        type: "text",
        text: request.system,
        cache_control: cacheControl(ttl),
      },
    ];
    breakpoints += 1;
  } else if (Array.isArray(request.system)) {
    for (let index = request.system.length - 1; index >= 0; index -= 1) {
      const block = request.system[index];
      if (!block || typeof block !== "object") continue;
      block.cache_control = cacheControl(ttl);
      breakpoints += 1;
      break;
    }
  }

  // Anthropic's automatic mode moves this breakpoint to the end of the
  // cacheable conversation on every request. Keep explicit tool/system
  // breakpoints as stable fallbacks, then let the automatic breakpoint cover
  // the growing message prefix.
  request.cache_control = cacheControl(ttl);
  breakpoints += 1;

  return breakpoints;
}

function mergeAnthropicExtensions(request, responsePayload) {
  if (responsePayload?.thinking && typeof responsePayload.thinking === "object") {
    request.thinking = structuredClone(responsePayload.thinking);
  }
  if (
    responsePayload?.output_config &&
    typeof responsePayload.output_config === "object"
  ) {
    request.output_config = {
      ...structuredClone(responsePayload.output_config),
      ...(request.output_config || {}),
    };
  }
}

function normalizeResponsesEvent(event) {
  if (event?.type === "response.completed" && event.response) {
    // The next Codex turn must replay local history instead of referring to an
    // Anthropic response id that the OpenAI Responses endpoint cannot resolve.
    event.response.id = "";
  }
  return event;
}

export class AnthropicResponsesBridge {
  constructor(responsePayload, { promptCache = false, cacheTtl = "5m" } = {}) {
    this.converter = new ResponsesToMessagesConverter();
    this.request = this.converter.convertRequest(responsePayload);
    mergeAnthropicExtensions(this.request, responsePayload);
    this.cacheBreakpoints = promptCache
      ? addAnthropicPromptCache(this.request, { ttl: cacheTtl })
      : 0;
  }

  convertEvent(event) {
    if (event?.type === "error") {
      const detail = event.error || event;
      return [
        {
          type: "error",
          status: detail.status || 502,
          error: {
            code: detail.type || "external_request_failed",
            message: detail.message || "Anthropic upstream stream failed",
          },
        },
      ];
    }
    return this.converter
      .convertStreamEvent(event)
      .map((converted) => normalizeResponsesEvent(converted));
  }
}
