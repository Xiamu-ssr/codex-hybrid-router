# Security

本项目会在内存中处理 Codex 登录令牌和第三方 API Key。

- 只绑定 `127.0.0.1`，不要把端口开放给局域网或互联网。
- 只供单人、本机使用；不要共享 ChatGPT 订阅或搭建多人网关。
- API Key 放在环境变量或 macOS Keychain，不要写入 JSON、日志或仓库。
- 第三方/混合模型可能收到完整提示词、对话和工具结果；使用前确认供应商的数据政策。
- 日志、会话文件和压缩摘要都可能含敏感信息。

凭据意外泄露时应先撤销凭据，再清理历史。安全问题请优先使用 GitHub Private Vulnerability Reporting。
