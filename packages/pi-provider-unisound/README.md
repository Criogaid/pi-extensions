# @d3ara1n/pi-provider-unisound

[![npm version](https://img.shields.io/npm/v/@d3ara1n/pi-provider-unisound)](https://www.npmjs.com/package/@d3ara1n/pi-provider-unisound) [![npm downloads](https://img.shields.io/npm/dm/@d3ara1n/pi-provider-unisound)](https://www.npmjs.com/package/@d3ara1n/pi-provider-unisound) [![license](https://img.shields.io/npm/l/@d3ara1n/pi-provider-unisound)](https://www.npmjs.com/package/@d3ara1n/pi-provider-unisound)

Unisound (云知声) MaaS provider for [Pi Coding Agent](https://pi.dev) — registers the U2 model family (plus plan-hosted GLM/Kimi) via the platform's OpenAI-compatible API.

## Providers

| Provider ID | Name | Billing | API Key Env |
|---|---|---|---|
| `unisound` | Unisound MaaS | Pay-as-you-go | `$UNISOUND_API_KEY` |
| `unisound-plan` | Unisound MaaS (Token Plan) | Subscription | `$UNISOUND_PLAN_API_KEY` |

Both channels share the endpoint `https://maas-api.unisound.com/v1`. The keys are **not interchangeable**: pay-as-you-go keys come from *Metered & Packs → API Key Management*, Token Plan keys from *Subscription Management*. The Token Plan docs do not document a separate base URL; if a plan key turns out to need one, adjust `PLAN_BASE_URL`.

> **Token Plan usage restriction**: plan quota may only be used inside coding tools (U2Claw, OpenClaw, OpenCode and equivalents like pi). Using the plan key for non-coding automation or application backends is considered abuse and may get the key blocked.

## Models

### `unisound` (pay-as-you-go)

| Model | Reasoning | Input | Context | Max Output |
|---|---|---|---|---|
| `u2-flash` | Yes (on/off, no effort levels) | text | 512K | 128K |
| `u2` | Always on (cannot disable) | text | 160K | 64K |
| `u2-med` | Yes (on/off) | text, image | 256K | unpublished — 64K placeholder |
| `u2-radimed` | No (cannot enable) | text, image | 40K | unpublished — 8K placeholder |

### `unisound-plan` (Token Plan)

| Model | Reasoning | Input | Context | Max Output |
|---|---|---|---|---|
| `u2-flash` | Yes (on/off) | text | 512K | 128K |
| `u2` | Always on | text | 160K | 64K |
| `u2-med` | Yes (on/off) | text, image | 256K | unpublished — 64K placeholder |
| `glm-5.2` | Yes (`reasoning_effort` high/max) | text | 1M | 128K |
| `kimi-k3` | Always on (`reasoning_effort` low/high/max) | text, image | 1M | 1M |

`u2-radimed` is not part of the Token Plan. The platform also hosts third-party models on pay-as-you-go (DeepSeek, Kimi, GLM, Qwen, MiniMax); they are intentionally not registered — use their native providers.

## Compat Verification

**Live-verified on `u2-flash`** against `https://maas-api.unisound.com/v1` — see [`PROVIDER.md`](../../PROVIDER.md):

- **Thinking**: `thinking: { "type": "enabled" | "disabled" }` (pi's `"deepseek"` format). Thinking is **on by default** and toggleable on `u2-flash`. `reasoning_effort` is accepted but silently ignored → `supportsReasoningEffort: false`; pi's `minimal`/`low`/`medium` levels are hidden since they would all behave identically.
- **Roles**: only `system` / `user` / `assistant` / `tool` are accepted; `developer` returns 400 → `supportsDeveloperRole: false`.
- **`max_tokens`**: documented field name (the gateway also tolerates `max_completion_tokens`) → `maxTokensField: "max_tokens"`.
- **Streaming**: standard OpenAI SSE chunks; tool calls arrive as standard `delta.tool_calls`; usage arrives on a final empty-choices chunk with `stream_options: { include_usage: true }` (pi's default). Tool results round-trip without a `name` field; assistant replays need no `reasoning_content`.
- **`store: false` / tool `strict: false`**: accepted, no flags needed.
- **Images**: rejected on `u2-flash` — `model u2-flash does not support image_url content` → text-only. (`u2-med`/`u2-radimed` are documented vision models; image support there is taken from docs, not live-tested.)
- **Context overflow**: error text `This model's maximum context length is 1024000 tokens. However, your messages resulted in … tokens.` matches pi's built-in overflow patterns, so auto-compaction works without a `message_end` rewrite. Note the gateway's enforced limit (1,024,000) is higher than the advertised context window; the plugin declares the advertised 512K so pi compacts conservatively.
- **Caching**: usage reports `prompt_tokens_details.cached_tokens` (pi maps it to cache-read tokens); no automatic cache hits were observed on small repeated prompts, but cache-hit pricing is published and included in `cost`.

**From docs, not live-tested** (dev key only has `u2-flash` permission; the wire contract is assumed to match):

- `u2` thinking cannot be disabled; `u2-radimed` thinking cannot be enabled (`reasoning: false`); `u2-med` toggles like `u2-flash`.
- `glm-5.2` / `kimi-k3` (Token Plan only) honor `reasoning_effort` — level sets cross-checked against pi's built-in native entries (`zai.json`, `moonshotai.json`) and adjusted to their conventions: `glm-5.2` exposes off/high/max (low/medium are gateway aliases of high, hidden like zai.json does); `kimi-k3` exposes low/high/max, always-on (matches moonshotai.json; opencode.json's max-only entry is a conservative outlier). Note `moonshotai.json` also sets `requiresReasoningContentOnAssistantMessages` and `deferredToolsMode: "kimi"` natively — not set here, since Unisound's gateway is assumed to normalize those; re-verify with a plan key.
- Token Plan requests against the shared base URL.

## Pricing

pi tracks cost in USD. Unisound lists CNY prices, so `cost` fields are FX-converted estimates (~7.1 CNY/USD) for pi's status-bar display only — not real billing. List prices (input / cache-hit / output, CNY per million tokens): `u2-flash` 1/0.2/2 (60% launch discount excluded), `u2` 1/0.02/2, `u2-med` 8/2/28, `u2-radimed` 15/4/20. Token Plan models have subscription billing → `cost` 0. Cache-write pricing is not published.

## Installation

```bash
pi install npm:@d3ara1n/pi-provider-unisound
```

Or add to `~/.pi/agent/settings.json`:

```jsonc
{
  "extensions": [
    "/absolute/path/to/pi-extensions/packages/pi-provider-unisound"
  ]
}
```

Set your API key (pay-as-you-go):

```bash
export UNISOUND_API_KEY="sk-..."
```

Or for the Token Plan:

```bash
export UNISOUND_PLAN_API_KEY="sk-..."
```

Or use `/login` in pi to store them in `~/.pi/agent/auth.json`:

```json
{
  "unisound": { "apiKey": "sk-..." },
  "unisound-plan": { "apiKey": "sk-..." }
}
```

Then switch models with `/model unisound/u2-flash` or `/model unisound-plan/kimi-k3`.

## Getting an API Key

1. Visit the [Unisound MaaS platform](https://maas.unisound.com)
2. Pay-as-you-go: Metered & Packs → API Key Management
3. Token Plan: subscribe on the [Token Plan](https://maas.unisound.com/token-plan) page, then Subscription Management → dedicated API key

Note that model access is scoped per key — a key without permission for a model returns `no model <id> permission`.

## Dependencies

None — this is a standalone provider with no pi-extension dependencies. It uses pi's built-in `openai-completions` streaming.
