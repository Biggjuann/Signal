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

- `POST /api/audit` — body `{ business_name, query, email?, fresh? }`. JSON response with all four engine results, score, headline, and `cached` flag. `fresh: true` bypasses the 24h cache.
- `GET /api/audit/stream?business_name=...&query=...&fresh=1` — Server-Sent Events. Emits `progress`, `result`, `complete` events as each engine finishes. The frontend uses this for the staggered reveal.
- `POST /api/leads` — body `{ email, business_name, website?, query?, audit_score?, audit_results? }`. Stores the lead in Postgres along with the full audit JSON for sales context. Returns 503 if `DATABASE_URL` is not configured.
- `GET /api/health` — checks which API keys are configured, whether the DB is connected, and current cache size.

## Throttle

Per-IP limit, configured via env:
- `RATE_LIMIT_MAX` (default 5)
- `RATE_LIMIT_WINDOW_MS` (default 3600000 = 1h)

When exceeded, returns 429 with a `Retry-After` header.

## Caching

In-memory `Map` keyed by `business_name + query`, 24h TTL. Same audit within the window returns instantly, no API spend. Cache resets on server restart. The "Force fresh" checkbox in the UI (and `fresh=1` query param) bypasses the cache to re-query all four engines.

## Lead capture

The post-audit modal triggers 25s after the audit completes OR on exit-intent (mouse leaves the top of the viewport), whichever is first. Posts to `POST /api/leads` and stores the lead in Postgres along with the full audit JSON.

Schema (auto-created on startup if missing):

```sql
leads (
  id            SERIAL PRIMARY KEY,
  email         TEXT NOT NULL,
  business_name TEXT NOT NULL,
  website       TEXT,
  query         TEXT,
  audit_score   INTEGER,
  audit_results JSONB,    -- full per-engine results
  ip_address    TEXT,
  user_agent    TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
)
```

Pull leads with: `SELECT id, email, business_name, audit_score, created_at FROM leads ORDER BY created_at DESC;`

Wire your Calendly link by replacing `leadModal.calendlyUrl` in `public/index.html`.

## Cost per audit

Roughly **$0.25–0.55** uncached. The Anthropic Haiku sentiment classification adds about $0.01 per detected mention. With caching, repeat traffic on a given business+query is free.

## Deploy to Railway

1. Push this repo to GitHub.
2. New project → Deploy from GitHub repo → select this repo.
3. **Add Postgres**: in the project, click "+ New" → Database → PostgreSQL. Railway injects `DATABASE_URL` into the web service automatically. The schema is created on first boot.
4. In the web service Variables tab, set: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `PERPLEXITY_API_KEY`. (Optional: `RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW_MS`.)
5. Railway auto-runs `npm start`. Generate a domain from the dashboard or attach a custom one.

The server reads `PORT` from env automatically — Railway sets this. If `DATABASE_URL` is not set, the app still runs but `/api/leads` returns 503 (lead capture disabled).

## Project layout

```
server.js              Express app: /api/audit, SSE stream, /api/leads, rate limit
lib/
  llm-clients.js       Per-provider query functions, all return { raw, error, sources? }
  analyzer.js          Detection (with grounded-source check), list-position, sentiment, scoring
  cache.js             24h in-memory TTL cache
  db.js                Postgres pool + leads schema + insert
public/
  index.html           Landing page, audit UI (SSE), lead capture modal
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
