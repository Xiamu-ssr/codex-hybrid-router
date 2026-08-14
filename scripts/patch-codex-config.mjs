#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const configPath = path.join(codexHome, "config.toml");
const catalogPath = path.join(codexHome, "model-catalog.json");
const statePath = path.join(codexHome, "hybrid-router-install-state.json");
const port = Number(process.env.CODEX_ROUTER_PORT || 10100);
const uninstall = process.argv.includes("--uninstall");

fs.mkdirSync(codexHome, { recursive: true, mode: 0o700 });
let source = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : "";

function tomlString(value) {
  return JSON.stringify(String(value));
}

function patternFor(key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped}\\s*=.*$`, "m");
}

function currentLine(key) {
  return source.match(patternFor(key))?.[0] ?? null;
}

function upsertTopLevel(key, line) {
  const pattern = patternFor(key);
  if (pattern.test(source)) {
    source = source.replace(pattern, line);
  } else {
    source = `${line}\n${source}`;
  }
}

function writeConfig() {
  fs.writeFileSync(configPath, source, { mode: 0o600 });
  fs.chmodSync(configPath, 0o600);
}

const managedLines = {
  forced_login_method: `forced_login_method = ${tomlString("chatgpt")}`,
  model_provider: `model_provider = ${tomlString("openai")}`,
  openai_base_url: `openai_base_url = ${tomlString(`http://127.0.0.1:${port}/v1`)}`,
  model_catalog_json: `model_catalog_json = ${tomlString(catalogPath)}`,
};

if (uninstall) {
  if (fs.existsSync(statePath)) {
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    for (const key of Object.keys(managedLines)) {
      const installedLine = state.managed_lines?.[key];
      if (installedLine && currentLine(key) === installedLine) {
        source = source.replace(
          patternFor(key),
          state.previous_lines?.[key] || "",
        );
      }
    }
    fs.rmSync(statePath, { force: true });
  } else if (currentLine("openai_base_url") === managedLines.openai_base_url) {
    // Safe migration path for installs made before reversible state existed.
    source = source.replace(patternFor("openai_base_url"), "");
  }
  source = source.replace(/^\n+/, "");
  writeConfig();
  process.stdout.write(`${configPath}\n`);
  process.exit(0);
}

const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
if (source) {
  fs.copyFileSync(configPath, `${configPath}.before-hybrid-router-${timestamp}`);
}

let state;
if (fs.existsSync(statePath)) {
  state = JSON.parse(fs.readFileSync(statePath, "utf8"));
} else {
  const previousLines = Object.fromEntries(
    Object.keys(managedLines).map((key) => [key, currentLine(key)]),
  );
  // A pre-state installer already wrote this local endpoint. Treat it as owned
  // by the router so a later uninstall cannot leave native GPT traffic stranded.
  if (previousLines.openai_base_url === managedLines.openai_base_url) {
    previousLines.openai_base_url = null;
  }
  state = {
    version: 1,
    config_path: configPath,
    installed_at: new Date().toISOString(),
    previous_lines: previousLines,
  };
}
state.managed_lines = managedLines;
fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
fs.chmodSync(statePath, 0o600);

for (const [key, line] of Object.entries(managedLines)) {
  upsertTopLevel(key, line);
}

writeConfig();
process.stdout.write(`${configPath}\n`);
