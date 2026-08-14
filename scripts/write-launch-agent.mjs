#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const nodePath = process.execPath;
const label = "dev.codex-hybrid-router";
const plistPath =
  process.env.CODEX_ROUTER_PLIST_PATH ||
  path.join(os.homedir(), "Library", "LaunchAgents", `${label}.plist`);

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

const environment = {
  HOME: os.homedir(),
  CODEX_HOME: codexHome,
  CODEX_ROUTER_CONFIG:
    process.env.CODEX_ROUTER_CONFIG || path.join(codexHome, "hybrid-router.json"),
  CODEX_ROUTER_HOST: process.env.CODEX_ROUTER_HOST || "127.0.0.1",
  CODEX_ROUTER_PORT: process.env.CODEX_ROUTER_PORT || "10100",
};
for (const name of [
  "CODEX_ROUTER_PROXY_HOST",
  "CODEX_ROUTER_PROXY_PORT",
  "CODEX_ROUTER_COMPACT_MODEL",
  "CODEX_ROUTER_HYBRID_KEEPALIVE_MS",
  "NODE_EXTRA_CA_CERTS",
]) {
  if (process.env[name]) environment[name] = process.env[name];
}

const environmentXml = Object.entries(environment)
  .map(([key, value]) => `    <key>${escapeXml(key)}</key>\n    <string>${escapeXml(value)}</string>`)
  .join("\n");
const logPath = path.join(codexHome, "hybrid-router.log");
const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(nodePath)}</string>
    <string>--use-system-ca</string>
    <string>${escapeXml(path.join(repoRoot, "router.mjs"))}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${environmentXml}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${escapeXml(logPath)}</string>
  <key>StandardErrorPath</key><string>${escapeXml(logPath)}</string>
</dict>
</plist>
`;

fs.mkdirSync(path.dirname(plistPath), { recursive: true });
fs.writeFileSync(plistPath, plist, { mode: 0o600 });
process.stdout.write(`${plistPath}\n`);
