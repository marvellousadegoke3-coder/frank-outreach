# Frank Outreach

B2B lead-gen and cold outreach backend + dashboard for Frank Digitals, deployed on
Railway from this repo. n8n Cloud's only job is a daily cron that hits
`POST /agent/run` — everything else (who to email, drafting copy, sending,
follow-up scheduling) lives in the backend.

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
5. Backend service — also set: `WEBHOOK_SECRET` (pick a random string, shared
   with n8n), `ANTHROPIC_API_KEY` (optional, enables Claude-based reply
   classification and copy drafting — without it, drafting falls back to a
   fixed template and sentiment falls back to a keyword heuristic),
   `REOON_API_KEY` (optional, enables verification fallback), `CORS_ORIGIN`
   (set to your dashboard's Railway URL once you have it, or leave `*`),
   and `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`/`GOOGLE_REFRESH_TOKEN`
   (optional — until all three are set, `/agent/run` logs drafted emails
   instead of sending them, so the pipeline runs safely before Gmail OAuth
   is set up; see **Sending via Gmail API** below for how to generate the
   refresh token).
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
| `POST /webhook/inbound` | n8n (or your inbox provider) posts inbound replies here; classifies sentiment (Claude if `ANTHROPIC_API_KEY` set, else keyword heuristic), logs an event, sets the lead's status to `needs_human_reply` (permanently excluding it from `/agent/run`, regardless of sentiment), and auto-suppresses on `unsubscribe` sentiment. Requires `x-webhook-secret` header matching `WEBHOOK_SECRET`. |
| `POST /agent/run` | **The only endpoint n8n's cron calls.** Selects leads due for step 1 (no message sent yet), step 2 (step 1 sent 2+ days ago, no step 2 yet), or step 3 (step 1 sent 5+ days ago, no step 3 yet) — excluding anything suppressed or with any reply ever logged. For each: checks suppression, drafts subject/body with Claude (fixed template fallback without a key), sends via the Gmail API (or logs a stub without Google OAuth creds), and logs the `messages` row + a `sent` event. Requires `x-webhook-secret` header matching `WEBHOOK_SECRET`. Returns a JSON summary (`processed`, `sent`, `skipped_suppressed`, `skipped_no_campaign`, `skipped_daily_limit`, `errors`). |
| `GET /suppression/check?email=` | Check if an email is suppressed |
| `POST /suppression` | Add a suppression record |
| `POST /events` | Log a generic event (`delivered`, `opened`, `clicked`, etc.) |
| `GET /health` | Health check |

Note: `/agent/run` picks a campaign for each lead by matching `campaigns.niche`
to the lead's `niche` where `campaigns.status = 'active'`, and respects that
campaign's `daily_send_limit` (skipping once the day's cap is hit). A lead
with no matching active campaign is skipped (`skipped_no_campaign`) — make
sure every niche you're sending to has an active campaign row.

## Known gap: no seniority filtering on leads

The drafting prompt assumes every lead is a decision-maker (CEO, founder,
owner, or principal/managing partner) and writes founder-to-founder copy on
that assumption — but the `leads` table has no `title`/`seniority` column,
and nothing in this backend filters or verifies seniority. Right now
whatever populates `leads` (lead sourcing/scraping isn't built yet) is
implicitly responsible for only inserting decision-maker contacts.

Before wiring up real lead sourcing, either add a `title` (or similar)
column to `leads` and filter `/agent/run`'s candidate query on it, or at
minimum have the sourcing step store the scraped title in `enrichment` and
add that filter then. Until one of those exists, a non-decision-maker lead
that slips into the table will still get founder-to-founder copy addressed
to someone who isn't the owner.

## Sending via Gmail API

`/agent/run` sends through the Gmail API (`users.messages.send`) using an
OAuth refresh token, not SMTP. Until `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
and `GOOGLE_REFRESH_TOKEN` are all set on the backend service, sends are
logged instead of actually delivered.

**Prerequisites in Google Cloud Console** (same project as your OAuth client):
- Enable the **Gmail API** for the project.
- On the OAuth consent screen, add the sending Gmail account as a **test
  user** if the app is still in "Testing" publishing status (otherwise
  Google blocks the consent screen).

**One-time authorization** — run this locally, from `backend/`:

```bash
GOOGLE_CLIENT_ID=<your client id> GOOGLE_CLIENT_SECRET=<your client secret> node scripts/gmail-auth.js
```

It prints a Google consent URL (and tries to open it automatically on
macOS). Open it, sign into the **Gmail account you want to send from**, and
approve access. The script runs a temporary local server to catch the
redirect automatically — no manual code copy/paste needed — then prints a
refresh token. Set that as `GOOGLE_REFRESH_TOKEN` on the backend service
(along with `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`), e.g.:

```bash
railway variable --service <backend-service> --set "GOOGLE_CLIENT_ID=..." \
  --set "GOOGLE_CLIENT_SECRET=..." --set "GOOGLE_REFRESH_TOKEN=..."
```

**From address**: each send uses the sending campaign's `from_inbox` as the
`From` header (falling back to `GOOGLE_SEND_AS` if unset). That address must
be either the authorized Gmail account itself or a verified "Send As" alias
on it (Gmail Settings → Accounts → Send mail as).

**Reply threading**: every send mints its own `Message-ID` header (stored in
`messages.message_id`) rather than relying on Gmail's API id. Follow-up
sends (step 2/3) look up the lead's most recent prior message and set
`In-Reply-To`/`References` to its `Message-ID`, and pass its Gmail
`threadId` (stored in `messages.thread_id`) so the follow-up lands in the
same Gmail conversation. This is what lets `/webhook/inbound` match an
inbound reply back to the right message via `In-Reply-To`/`References`.

## Connecting to n8n Cloud

Once the backend has a public Railway domain, n8n's role is just one workflow:

1. **Schedule Trigger** node — set to run once daily (pick whatever time you
   want sends to go out).
2. **HTTP Request** node — `POST https://<backend-domain>/agent/run`, header
   `x-webhook-secret: <your WEBHOOK_SECRET>`, no body needed.

That's it. The backend decides who to email, drafts the copy, sends it, and
schedules the next follow-up step on its own — n8n just has to fire the cron.

For inbound replies, point your inbox-monitoring trigger (IMAP/Gmail trigger
node polling the sending inbox) at a workflow that ends with an HTTP Request
node calling `POST https://<backend-domain>/webhook/inbound`, header
`x-webhook-secret: <your WEBHOOK_SECRET>`, body either
`{ "raw": "<full .eml source>" }` or the parsed fields directly:
`{ "from": "...", "subject": "...", "text": "...", "in_reply_to": "...", "references": [...] }`.

**Dashboard**: no n8n wiring needed — it just reads `messages`/`events`
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
