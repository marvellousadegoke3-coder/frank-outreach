# Frank Outreach

B2B lead-gen and cold outreach backend + dashboard for Frank Digitals, deployed on
Railway from this repo, driven by n8n Cloud for scraping/sending.

## Structure

- `backend/` — Express API (ESM, `pg`). Leads, messages, events, suppression,
  verification, inbound-reply webhook.
- `dashboard/` — Express + Chart.js. Reads the same Postgres DB and renders
  totals / per-campaign / per-niche stats.

Both are separate Railway services from the same GitHub repo, each pointed at
its subfolder as the "root directory", both using `DATABASE_URL` for your
existing Railway Postgres.

## One-time DB setup

Run `backend/migrations/001_constraints.sql` once against your existing
Postgres (Railway's Query tab, or `psql "$DATABASE_URL" -f backend/migrations/001_constraints.sql`).
It adds the unique constraints the `POST /leads` and `POST /suppression`
upserts rely on, plus a few indexes for the dashboard's aggregate queries.
Safe to re-run.

## Local dev

```bash
cd backend && cp .env.example .env   # fill in DATABASE_URL etc.
npm install
npm run dev

cd dashboard && cp .env.example .env
npm install
npm run dev
```

## Deploying to Railway

1. Push this repo to GitHub (see below).
2. In Railway: **New Project → Deploy from GitHub repo**, pick this repo.
   Railway will ask to create a service — set its **Root Directory** to
   `backend`. It auto-detects the Dockerfile.
3. Add a second service in the same project: **New → GitHub Repo** (same
   repo again), Root Directory `dashboard`.
4. For each service, set the `DATABASE_URL` env var to reference your
   existing Postgres plugin — in Railway you can do this with a variable
   reference (`${{Postgres.DATABASE_URL}}`) instead of pasting the string,
   so it stays in sync if the DB ever migrates.
5. Backend service — also set: `WEBHOOK_SECRET` (pick a random string),
   `ANTHROPIC_API_KEY` (optional, enables Claude-based reply classification),
   `REOON_API_KEY` (optional, enables verification fallback), `CORS_ORIGIN`
   (set to your dashboard's Railway URL once you have it, or leave `*`).
6. Dashboard service — no extra env vars beyond `DATABASE_URL`.
7. Generate a public domain for each service under Settings → Networking →
   "Generate Domain".

## Backend API

| Endpoint | Description |
|---|---|
| `POST /leads` | Upsert a lead on `email` |
| `GET /leads?niche=&status=` | List/filter leads |
| `PATCH /leads/:id/status` | Update a lead's status |
| `POST /verify` | MX check (+ Reoon fallback if `REOON_API_KEY` set); persists `verified`/`catch_all` |
| `POST /messages` | Create a message record |
| `PATCH /messages/:id/sent` | Mark a message sent |
| `PATCH /messages/:id/bounced` | Mark bounced, logs a `bounced` event |
| `POST /webhook/inbound` | n8n posts inbound replies here; classifies sentiment (Claude if `ANTHROPIC_API_KEY` set, else keyword heuristic), logs an event, auto-suppresses on `unsubscribe` sentiment. Requires `x-webhook-secret` header matching `WEBHOOK_SECRET`. |
| `GET /suppression/check?email=` | Check if an email is suppressed |
| `POST /suppression` | Add a suppression record |
| `POST /events` | Log a generic event (`delivered`, `opened`, `clicked`, etc.) |
| `GET /health` | Health check |

## Connecting to n8n Cloud

Once both services have public Railway domains:

1. **Lead intake**: in your scraping workflow, add an HTTP Request node —
   `POST https://<backend-domain>/leads` with the scraped fields as JSON body.
   It upserts on email, so re-running scrapes is safe.

2. **Verification**: after scraping (or right before sending), call
   `POST https://<backend-domain>/verify` with `{ "email": "...", "lead_id": ... }`.
   It updates the lead's `verified`/`catch_all` columns and returns the result
   so you can branch the workflow (e.g. skip sending if `verified: false`).

3. **Suppression gate**: before sending, call
   `GET https://<backend-domain>/suppression/check?email=...` and skip the
   send if `suppressed: true`.

4. **Send step**: after your sending node (Gmail/SMTP/inbox provider) actually
   sends, call `PATCH https://<backend-domain>/messages/:id/sent` with the
   provider's `message_id`/`thread_id` so replies can be matched later. If the
   send bounces, call `PATCH .../messages/:id/bounced` instead.

5. **Inbound replies**: point your inbox-monitoring trigger (IMAP/Gmail
   trigger node polling the sending inbox) at a workflow that ends with an
   HTTP Request node calling `POST https://<backend-domain>/webhook/inbound`.
   Send header `x-webhook-secret: <your WEBHOOK_SECRET>` and body either
   `{ "raw": "<full .eml source>" }` or the parsed fields directly:
   `{ "from": "...", "subject": "...", "text": "...", "in_reply_to": "...", "references": [...] }`.
   The endpoint classifies sentiment, logs an `events` row, marks the message
   `replied`, and auto-adds to `suppression` if the reply reads as an
   unsubscribe request.

6. **Dashboard**: no n8n wiring needed — it just reads `messages`/`events`
   directly. Open `https://<dashboard-domain>` any time to see live totals.

## Push to GitHub

```bash
git init
git add -A
git commit -m "Initial outreach backend + dashboard"
git branch -M main
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```
