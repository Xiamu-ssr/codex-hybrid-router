#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const configPath =
  process.env.CODEX_ROUTER_CONFIG || path.join(codexHome, "hybrid-router.json");
const catalogPath =
  process.env.CODEX_MODEL_CATALOG || path.join(codexHome, "model-catalog.json");

const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
if (!Array.isArray(catalog.models)) {
  throw new Error(`${catalogPath} has no models array`);
}

const externalDefinitions = Object.entries(config.external_models || {});
const hybridDefinitions = Object.entries(config.hybrid_final_models || {});
if (externalDefinitions.length === 0 && hybridDefinitions.length === 0) {
  throw new Error(`${configPath} defines no models`);
}

function templateFor(slug, fallback = null) {
  return (
    catalog.models.find((model) => model.slug === slug) ||
    (fallback ? catalog.models.find((model) => model.slug === fallback) : null) ||
    catalog.models.find((model) =>
      typeof model.slug === "string" && model.slug.startsWith("gpt-") && model.base_instructions
    )
  );
}

const externalTemplateSlug =
  config.catalog_template_model || process.env.CODEX_ROUTER_CATALOG_TEMPLATE || "gpt-5.4-mini";
const externalTemplate = templateFor(externalTemplateSlug);
if (!externalTemplate) {
  throw new Error("Could not find a compatible GPT model as the catalog template");
}

const reasoningDescriptions = {
  minimal: "Minimal reasoning for the fastest responses",
  low: "Fast responses with lighter reasoning",
  medium: "Balances speed and reasoning depth for everyday tasks",
  high: "Greater reasoning depth for complex tasks",
  xhigh: "Extra high reasoning depth for difficult tasks",
  max: "Maximum reasoning depth for the hardest tasks",
  ultra: "Ultra reasoning depth when supported by the provider",
};

function reasoningLevels(efforts) {
  return efforts.map((effort) => ({
    effort,
    description: reasoningDescriptions[effort] || `${effort} reasoning effort`,
  }));
}

function rewriteIdentity(model, displayName) {
  const identity = `You are Codex, a coding agent using ${displayName}.`;
  model.base_instructions = model.base_instructions
    ?.replace("You are Codex, a coding agent based on GPT-5.", identity)
    .replace(
      "Always use apply_patch for manual code edits. Do not use cat or any other commands when creating or editing files.",
      "Use the available file-editing tool for manual code edits; if apply_patch is unavailable, use exec_command with a safe non-interactive editor.",
    );
  if (model.model_messages?.instructions_template) {
    model.model_messages.instructions_template =
      model.model_messages.instructions_template
        .replace("You are Codex, a coding agent based on GPT-5.", identity)
        .replace(
          "Always use apply_patch for manual code edits. Do not use cat or any other commands when creating or editing files.",
          "Use the available file-editing tool for manual code edits; if apply_patch is unavailable, use exec_command with a safe non-interactive editor.",
        );
  }
}

const externalModels = externalDefinitions.map(([slug, definition], index) => {
  const model = {
    ...structuredClone(externalTemplate),
    slug,
    display_name: definition.display_name || slug,
    description:
      definition.description || `External model ${definition.upstream_model || slug}`,
    priority: definition.priority ?? 20 + index,
    visibility: "list",
    supported_in_api: true,
    context_window: definition.context_window ?? 200000,
    max_context_window:
      definition.max_context_window ?? definition.context_window ?? 200000,
    auto_compact_token_limit:
      definition.auto_compact_token_limit ??
      Math.floor((definition.context_window ?? 200000) * 0.9),
    effective_context_window_percent:
      definition.effective_context_window_percent ?? 95,
    default_reasoning_level: definition.default_reasoning_level || "high",
    supported_reasoning_levels: reasoningLevels(
      definition.reasoning_levels || ["low", "medium", "high"],
    ),
    additional_speed_tiers: [],
    service_tiers: [],
    supports_search_tool: definition.supports_search_tool === true,
    use_responses_lite: false,
    prefer_websockets: false,
    upgrade: null,
    availability_nux: null,
  };
  rewriteIdentity(model, model.display_name);
  if (definition.disable_apply_patch_tool === true) {
    delete model.apply_patch_tool_type;
  }
  return model;
});

const hybridModels = hybridDefinitions.map(([slug, definition], index) => {
  const agentTemplate = templateFor(definition.agent_model, "gpt-5.6-sol");
  if (!agentTemplate) {
    throw new Error(`Could not find catalog template for hybrid agent ${definition.agent_model}`);
  }
  const model = {
    ...structuredClone(agentTemplate),
    slug,
    display_name: definition.display_name || slug,
    description:
      definition.description ||
      `${definition.agent_model} runs tools; ${definition.finalizer_model} writes the final answer.`,
    priority: definition.priority ?? 10 + index,
    visibility: "list",
    supported_in_api: true,
    context_window: definition.context_window ?? agentTemplate.context_window,
    max_context_window:
      definition.max_context_window ??
      definition.context_window ??
      agentTemplate.max_context_window ??
      agentTemplate.context_window,
    auto_compact_token_limit:
      definition.auto_compact_token_limit ?? agentTemplate.auto_compact_token_limit,
    use_responses_lite: false,
    prefer_websockets: false,
    upgrade: null,
    availability_nux: null,
  };
  if (Array.isArray(definition.reasoning_levels)) {
    model.supported_reasoning_levels = reasoningLevels(definition.reasoning_levels);
  } else if (Array.isArray(model.supported_reasoning_levels)) {
    model.supported_reasoning_levels = model.supported_reasoning_levels.filter(
      (level) => level.effort !== "ultra",
    );
  }
  delete model.multi_agent_version;
  return model;
});

const installedSlugs = new Set(
  [...externalModels, ...hybridModels].map((model) => model.slug),
);
catalog.models = catalog.models
  .filter((model) => !installedSlugs.has(model.slug))
  .concat(hybridModels, externalModels)
  .sort((left, right) => left.priority - right.priority);

const temporaryPath = `${catalogPath}.tmp`;
fs.writeFileSync(temporaryPath, `${JSON.stringify(catalog, null, 2)}\n`, {
  mode: 0o600,
});
fs.renameSync(temporaryPath, catalogPath);

process.stdout.write(
  `${[...hybridModels, ...externalModels].map((model) => model.slug).join("\n")}\n`,
);
