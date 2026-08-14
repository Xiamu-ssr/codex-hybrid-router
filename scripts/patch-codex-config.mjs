#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const configPath = path.join(codexHome, "config.toml");
const catalogPath = path.join(codexHome, "model-catalog.json");
const port = Number(process.env.CODEX_ROUTER_PORT || 10100);

let source = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : "";
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
if (source) {
  fs.copyFileSync(configPath, `${configPath}.before-hybrid-router-${timestamp}`);
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

function upsertTopLevel(key, value) {
  const line = `${key} = ${value}`;
  const pattern = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=.*$`, "m");
  if (pattern.test(source)) {
    source = source.replace(pattern, line);
  } else {
    source = `${line}\n${source}`;
  }
}

upsertTopLevel("forced_login_method", tomlString("chatgpt"));
upsertTopLevel("model_provider", tomlString("openai"));
upsertTopLevel("openai_base_url", tomlString(`http://127.0.0.1:${port}/v1`));
upsertTopLevel("model_catalog_json", tomlString(catalogPath));

fs.mkdirSync(codexHome, { recursive: true, mode: 0o700 });
fs.writeFileSync(configPath, source, { mode: 0o600 });
fs.chmodSync(configPath, 0o600);
process.stdout.write(`${configPath}\n`);
