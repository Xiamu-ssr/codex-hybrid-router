# Codex Hybrid Router

An experimental local router for Codex Desktop and Codex CLI. It keeps native GPT models on the signed-in ChatGPT subscription path while adding models from an OpenAI Responses-compatible provider to the same Codex model picker.

It also supports a hybrid model: GPT runs the Codex agent/tool loop, then an external model independently writes the final user-facing answer.

> This is an unofficial community project. It relies on Codex and ChatGPT behavior that can change without notice. It is designed for one user on one machine, not subscription sharing.

## What it does

```text
Codex Desktop / CLI
        |
        v
127.0.0.1:10100
        |
        +-- native GPT ----------> ChatGPT Codex WebSocket
        |
        +-- external/* ----------> provider /responses over HTTP/SSE
        |
        +-- hybrid/* ------------> GPT tool loop -> external final answer
```

- Native GPT requests keep the built-in `openai` provider, ChatGPT login, Responses WebSocket transport, and native compaction. Ordinary native WebSocket request frames are forwarded byte-for-byte.
- External models use a configurable HTTPS base URL, API key, model mapping, and compatibility profile.
- External/hybrid compaction creates a portable summary with a configured GPT subscription model because provider-specific reasoning/compaction artifacts are not portable.
- A hybrid request sends protocol-level WebSocket pings while a buffered model call is running, preventing Codex's stream idle timeout from turning a long inference into a false reconnect.
- If the hybrid finalizer fails, the already completed GPT answer is returned instead.

Codex officially supports `model_provider`, custom provider `base_url`, API-key environment variables, the Responses wire protocol, and provider WebSocket capability flags. This project deliberately keeps `model_provider = "openai"` and routes locally so ChatGPT subscription authentication remains available. See the [official Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).

## Requirements

- macOS for the included installer and Keychain helper
- Node.js 22 or newer
- Codex Desktop or CLI already signed in with ChatGPT
- An external provider exposing an OpenAI-compatible `POST /responses` SSE endpoint

The Node router can run on other operating systems, but service installation is currently manual there.

## Quick start: ZenMux preset

```bash
git clone https://github.com/Xiamu-ssr/codex-hybrid-router.git
cd codex-hybrid-router
cp config.example.json ~/.codex/hybrid-router.json
chmod 600 ~/.codex/hybrid-router.json
npm ci
./scripts/store-key-macos.sh
./scripts/install-macos.sh
```

Restart Codex. The configured external and hybrid models should appear in the model picker while native GPT models continue to use the ChatGPT subscription.

If ZenMux requires Clash on your network, install with explicit proxy variables:

```bash
CODEX_ROUTER_PROXY_HOST=127.0.0.1 \
CODEX_ROUTER_PROXY_PORT=7890 \
./scripts/install-macos.sh
```

Without those variables the router connects directly. It does not silently inherit a system proxy.

## Use another provider

Edit `~/.codex/hybrid-router.json`:

```json
{
  "external_provider": {
    "name": "My Provider",
    "base_url": "https://provider.example/v1",
    "api_key_env": "MY_PROVIDER_API_KEY",
    "keychain_service": "dev.codex-hybrid-router.my-provider",
    "send_authorization": true,
    "send_x_api_key": false,
    "headers": {}
  },
  "external_models": {
    "external/my-model": {
      "upstream_model": "vendor/model-id",
      "compatibility": "generic",
      "display_name": "My Model",
      "context_window": 200000,
      "auto_compact_token_limit": 180000,
      "default_reasoning_level": "high",
      "reasoning_levels": ["low", "medium", "high"]
    }
  },
  "hybrid_final_models": {}
}
```

Then rerun the key helper and installer. Supported compatibility values are:

- `generic`: pass ordinary Responses fields through.
- `claude`: remove assistant-progress prefill and translate maximum reasoning to adaptive thinking for gateways that expose current Claude models through Responses.
- `kimi`: cap unsupported `ultra` effort at `max`.
- `grok`: cap reasoning at `high` and remove unsupported namespace tools.

Provider compatibility varies. A gateway may claim OpenAI compatibility while rejecting Codex-specific tools, reasoning items, hosted search, compaction, or assistant-message shapes. Add one model at a time and run the integration checks.

## Configuration

Router configuration defaults to `~/.codex/hybrid-router.json`. Override it with `CODEX_ROUTER_CONFIG`.
The repository includes [`config.schema.json`](./config.schema.json) for editor validation and autocomplete.

Useful environment variables:

| Variable | Default | Meaning |
|---|---:|---|
| `CODEX_ROUTER_HOST` | `127.0.0.1` | Local bind address; do not make this public |
| `CODEX_ROUTER_PORT` | `10100` | Local port |
| `CODEX_ROUTER_PROXY_HOST` | empty | Optional HTTP CONNECT proxy host |
| `CODEX_ROUTER_PROXY_PORT` | empty | Optional HTTP CONNECT proxy port |
| `CODEX_ROUTER_COMPACT_MODEL` | `gpt-5.6-luna` | Native GPT model used for portable summaries |
| `CODEX_ROUTER_HYBRID_KEEPALIVE_MS` | `30000` | Hybrid WS ping interval |
| `CODEX_ROUTER_MODEL_CATALOG` | `~/.codex/model-catalog.json` | Catalog served to Codex |

API keys are read lazily from the configured environment variable, then from macOS Keychain. The JSON file never needs to contain the key.

## Validation

Offline checks:

```bash
npm test
npm run check
npm audit --omit=dev
```

Authenticated integration checks use the local `~/.codex/auth.json` without printing its tokens:

```bash
node selftest.mjs gpt-5.6-luna
node selftest-hybrid-final.mjs
node selftest-compact.mjs
```

These calls can consume ChatGPT subscription or external-provider quota.

## Important boundaries

- The router is loopback-only by default, but it still handles bearer tokens in memory. Do not expose its port.
- Native GPT transparency applies to ordinary native turns. When a conversation crosses provider boundaries, the router may remove unresolvable third-party reasoning IDs or restore a locally signed portable compaction summary.
- External and hybrid turns may send the full active conversation, instructions, and tool results to the external provider.
- Hybrid finalization is not a second agent loop: the finalizer receives completed context and cannot execute new client-side tools. Hosted provider-side web search may still be allowed.
- The installer backs up Codex config and model catalog, but uninstall intentionally does not overwrite later user changes.
- Codex model-catalog formats and ChatGPT internal endpoints are not a stable public contract. Test after Codex updates.

## Uninstall

```bash
./scripts/uninstall-macos.sh
```

Restore the desired `~/.codex/*.before-hybrid-router-*` backups and restart Codex.

## License

MIT
