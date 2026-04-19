# groq-paperclip-adapter

> Paperclip adapter for Groq's free LLM tier.

Paperclip adapter for Groq's free tier (Llama 3.3 70B, Qwen 3 32B, Kimi K2). Lightning-fast inference.

## Status

🚧 **v0.0.1 — scaffold only.** Implementation in progress.

Part of the [Free LLM Adapter Pack](https://github.com/acunningham-ship-it) for Paperclip.

## Authentication

Set environment variable:

```bash
export GROQ_API_KEY=your_key_here
```

## Installation (when v1 ships)

```bash
npm install -g groq-paperclip-adapter
```

## Agent configuration

```json
{
  "adapterType": "groq_local",
  "adapterConfig": {
    "model": "llama-3.3-70b-versatile",
    "timeoutSec": 300
  }
}
```

## Available free models

See `FREE_MODELS` in `src/shared/constants.ts`.

## Roadmap

- v0.0.1 (now) — scaffold + README
- v0.5.0 — execute.ts MVP
- v1.0.0 — production-ready, launches with Free LLM Adapter Pack

## License

MIT — Armani Cunningham, 2026.
