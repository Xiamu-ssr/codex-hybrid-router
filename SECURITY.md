# Security

This router handles a signed-in Codex session and external-provider credentials.

- Keep it bound to `127.0.0.1`. Never expose the listening port to a LAN or the internet.
- Do not use it for account sharing or as a multi-user subscription gateway.
- Store provider keys in an environment variable or macOS Keychain; never put a key in the JSON config.
- Treat router logs, Codex session files, prompts, tool results, and compacted summaries as sensitive.
- Review an external provider's data policy before routing a conversation to it. External and hybrid turns can send the full active prompt and tool results to that provider.

If a credential is accidentally committed or logged, revoke it first and then remove it from history. Please report vulnerabilities through GitHub's private vulnerability reporting when available.
