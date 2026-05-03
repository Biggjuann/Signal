# Signal — AI Visibility Audit

Cross-engine citation audit. Runs a query through Claude, ChatGPT, Gemini, and Perplexity in parallel and produces a composite Visibility Score.

## Local setup

```bash
npm install
cp .env.example .env
# fill in API keys in .env
npm run dev
```

App runs at http://localhost:3000.

## API keys

You need keys for each provider. Missing keys won't crash the audit — that engine returns an error result and the other three still run.

| Provider | Where | Env var |
|---|---|---|
| Anthropic (Claude + Haiku for sentiment) | https://console.anthropic.com | `ANTHROPIC_API_KEY` |
| OpenAI (ChatGPT) | https://platform.openai.com | `OPENAI_API_KEY` |
| Google AI Studio (Gemini) | https://aistudio.google.com | `GEMINI_API_KEY` |
| Perplexity | https://perplexity.ai/settings/api | `PERPLEXITY_API_KEY` |

Set hard spending caps in each provider's dashboard before going live.

## Endpoints

- `POST /api/audit` — body `{ business_name, query, email? }`. JSON response with all four engine results, score, headline, and `cached` flag.
- `GET /api/audit/stream?business_name=...&query=...` — Server-Sent Events. Emits `progress`, `result`, `complete` events as each engine finishes. The frontend uses this for the staggered reveal.
- `GET /api/health` — checks which API keys are configured and current cache size.

## Throttle

Per-IP limit, configured via env:
- `RATE_LIMIT_MAX` (default 5)
- `RATE_LIMIT_WINDOW_MS` (default 3600000 = 1h)

When exceeded, returns 429 with a `Retry-After` header.

## Caching

In-memory `Map` keyed by `business_name + query`, 24h TTL. Same audit within the window returns instantly, no API spend. Cache resets on server restart — that's fine for v1, move to a real store when adding lead capture.

## Cost per audit

Roughly **$0.25–0.55** uncached. The Anthropic Haiku sentiment classification adds about $0.01 per detected mention. With caching, repeat traffic on a given business+query is free.

## Deploy to Railway

1. Push this repo to GitHub.
2. New project → Deploy from GitHub repo → select this repo.
3. In Variables, set: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `PERPLEXITY_API_KEY`. (Optional: `RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW_MS`.)
4. Railway auto-runs `npm start`. Generate a domain from the dashboard or attach a custom one.

The server reads `PORT` from env automatically — Railway sets this.

## Project layout

```
server.js              Express app, /api/audit, SSE endpoint, rate limit
lib/
  llm-clients.js       Per-provider query functions, all return { raw, error }
  analyzer.js          Detection, sentiment classification, scoring, headline
  cache.js             24h in-memory TTL cache
public/
  index.html           Landing page + audit UI, consumes SSE
.env.example           Template for required env vars
```

## Scoring

For each engine: detection (15) + characterization (enthusiastic 7.5 → negative 0). Plus a consistency bonus (10 if detected on 3+, 5 if on 2). Capped at 100.

| Score | Interpretation |
|---|---|
| 0–30 | Critical — significant visibility gap |
| 31–50 | Weak — fractured presence |
| 51–70 | Moderate — present but undifferentiated |
| 71–85 | Strong — well-positioned |
| 86–100 | Dominant — owns the category |

## Canonical demo

`The Grind Burger Bar` / `best burgers near Lewisville TX` — expected to score low/mid (invisible on Claude, weak on ChatGPT). Use this as the live case study on the landing page.
