# Codex Hybrid Router

给 Codex Desktop / CLI 增加第三方模型，同时保留 ChatGPT 订阅登录和原生 GPT 模型。

```text
Codex -> 本机 127.0.0.1:10100
          ├─ GPT          -> ChatGPT 订阅
          ├─ external/*   -> 第三方 Responses API
          └─ hybrid/*     -> GPT 执行工具，第三方模型写最终回复
```

> 非官方实验项目，仅适合单人、本机使用。不要用于账号共享或搭建多人网关。

## 适合谁

- 已在 Codex 登录 ChatGPT 订阅；
- 想在同一个模型列表里试用 Claude、Kimi、Grok 等第三方模型；
- 有第三方供应商 API Key，能接受本地代理和兼容性风险。

如果只用 OpenAI API Key、需要多人共享，或不能接受 Codex 更新后偶尔要修兼容性，不建议使用。

## 安装（macOS）

需要 Node.js 22+，并先打开一次 Codex 完成 ChatGPT 登录。

```bash
git clone https://github.com/Xiamu-ssr/codex-hybrid-router.git
cd codex-hybrid-router
cp config.example.json ~/.codex/hybrid-router.json
chmod 600 ~/.codex/hybrid-router.json
npm ci
./scripts/store-key-macos.sh
./scripts/install-macos.sh
```

重启 Codex 后，第三方和混合模型会出现在模型列表中。默认配置是 ZenMux；其他供应商只需修改 [`config.example.json`](./config.example.json) 对应字段。

需要显式经过 Clash 时：

```bash
CODEX_ROUTER_PROXY_HOST=127.0.0.1 \
CODEX_ROUTER_PROXY_PORT=7890 \
./scripts/install-macos.sh
```

不传代理变量时直接联网，不会自动继承系统代理。

## 会修改什么

| 位置 | 改动 |
|---|---|
| `~/.codex/config.toml` | 设置 `forced_login_method`、`model_provider`、`openai_base_url`、`model_catalog_json`；安装前备份，并记录原值供卸载恢复 |
| `~/.codex/model-catalog.json` | 增加第三方/混合模型条目；安装前备份 |
| `~/.codex/hybrid-router.json` | 保存供应商和模型配置，不保存明文 API Key |
| macOS Keychain | 保存第三方供应商 API Key |
| `~/Library/LaunchAgents/dev.codex-hybrid-router.plist` | 让本地路由器登录后自动运行 |
| `~/.codex/hybrid-router.log` | 本地运行日志 |
| `~/.codex/zenmux-router/compact-secret` | 本地可迁移压缩摘要的签名密钥；名称是历史遗留，供应商不限 ZenMux |

它**不会修改或删除** `~/.codex/auth.json`、Codex 会话文件和 ChatGPT 登录态。原生 GPT 仍消耗你的 ChatGPT 订阅，不会改成第三方 API Key。

Codex 官方支持用户级 `model_provider`、`openai_base_url` 和 `model_catalog_json` 配置；本项目用本机入口完成分流。参见 [Codex 配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)。

## 风险

- 安装期间，原生 GPT 流量也要经过本地路由器；路由器退出或端口被占用时，Codex 会请求失败。
- 使用第三方/混合模型时，当前提示词、对话和工具结果可能发送给第三方，并消耗其额度。
- 第三方模型的工具、推理、搜索和压缩兼容性取决于供应商；“兼容 OpenAI”不代表支持全部 Codex 行为。
- 第三方会话的可迁移压缩可能调用 ChatGPT 订阅模型；Codex 或 ChatGPT 内部协议更新可能造成暂时不可用。
- 本机端口会处理登录令牌，必须保持绑定 `127.0.0.1`，不要暴露到局域网或互联网。

## 卸载

```bash
./scripts/uninstall-macos.sh
```

卸载会停止并删除 LaunchAgent、移除新增模型、撤销本地代理入口，并在未被你手动改写的前提下恢复安装前的 Codex 配置。重启 Codex 后生效。

为方便重装，以下内容默认保留：ChatGPT 登录、第三方 Key、路由配置、日志和备份。确认不再需要时可选清理：

```bash
rm -f ~/.codex/hybrid-router.json ~/.codex/hybrid-router.log
rm -rf ~/.codex/zenmux-router
security delete-generic-password -s dev.codex-hybrid-router.zenmux
```

最后一条 Keychain 服务名需与 `hybrid-router.json` 中的 `keychain_service` 一致。

## 开发检查

```bash
npm test
npm run check
npm audit --omit=dev
```

需要真实账号的 `selftest-*.mjs` 会消耗 ChatGPT 订阅或第三方额度，不属于默认测试。

## License

MIT
