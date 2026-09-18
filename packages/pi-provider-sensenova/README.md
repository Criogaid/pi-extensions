# @d3ara1n/pi-provider-sensenova

[![npm version](https://img.shields.io/npm/v/@d3ara1n/pi-provider-sensenova)](https://www.npmjs.com/package/@d3ara1n/pi-provider-sensenova) [![npm downloads](https://img.shields.io/npm/dm/@d3ara1n/pi-provider-sensenova)](https://www.npmjs.com/package/@d3ara1n/pi-provider-sensenova) [![license](https://img.shields.io/npm/l/@d3ara1n/pi-provider-sensenova)](https://www.npmjs.com/package/@d3ara1n/pi-provider-sensenova)

SenseNova (商汤日日新) provider for [Pi Coding Agent](https://pi.dev) — registers the SenseNova Token Plan models via OpenAI-compatible API.

## Provider

| Provider ID | Name | API Key Env |
|---|---|---|
| `sensenova-plan` | SenseNova (Token Plan) | `$SENSENOVA_API_KEY` |

## Models

| Model | Reasoning | Input | Context | Max Output |
|---|---|---|---|---|
| `sensenova-6.7-flash-lite` | Yes | text, image | 256K | 64K |
| `sensenova-6.8-flash-lite` | Yes | text, image | 256K | 64K |
| `deepseek-v4-flash` | Yes | text | 1M | 64K |
| `deepseek-v4-pro` | Yes | text | 1M | 384K |
| `glm-5.2` | Yes | text | 1M | 128K |
| `kimi-k3` | Yes | text, image | 1M | 1M |

Image-generation models (`sensenova-u1-fast`, `sensenova-u1.5-lite`) are intentionally not registered — their output modality is image, not chat.

The chat models run over an OpenAI-compatible chat/completions API — tool calling, streaming, and usage reporting are verified against the live API. Reasoning accepts only `low` / `medium` / `high` / `none`, so pi's `minimal` thinking level is not offered for these models.

## Installation

```bash
pi install npm:@d3ara1n/pi-provider-sensenova
```

Or add to `~/.pi/agent/settings.json`:

```jsonc
{
  "extensions": [
    "/absolute/path/to/pi-extensions/packages/pi-provider-sensenova"
  ]
}
```

Set your API key:

```bash
export SENSENOVA_API_KEY="sk-..."
```

Or use `/login` in pi to store it in `~/.pi/agent/auth.json`:

```json
{ "sensenova-plan": { "apiKey": "sk-..." } }
```

## Getting an API Key

1. Visit [SenseNova Platform](https://platform.sensenova.cn/console)
2. Go to 管理中心 → API-Key 管理 → 创建 API-Key
3. Copy the key immediately (it's shown only once)

The Token Plan is currently in **free public beta** — no credit card required, up to 1,500 calls per model every 5 hours, with up to 20 API keys.

## Dependencies

None — this is a standalone provider with no pi-extension dependencies. It uses pi's built-in `openai-completions` streaming.

## Usage Quota Reporting

Not yet implemented. SenseNova does not currently expose a public quota or balance API. When one becomes available, quota reporting will be added via `@d3ara1n/pi-usage-block-core`.
