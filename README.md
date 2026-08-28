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
   refresh token), and `HUNTER_API_KEY` (optional for `/leads/source`;
   without it, lead sourcing runs entirely on pattern-guessed emails — see
   **Lead sourcing** below). `/leads/source`'s discovery step uses
   OpenStreetMap's Overpass API, which needs no key or billing account.
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
| `POST /webhook/inbound` | n8n (or your inbox provider) posts everything that lands in the monitored sending inbox here — genuine replies **and** Gmail bounce/DSN notifications (bounces return to the sender, i.e. this same inbox). Auto-detects which it is (see **Bounce handling** below) and branches: a reply gets classified for sentiment (Claude if `ANTHROPIC_API_KEY` set, else keyword heuristic), logs an event, sets the lead's status to `needs_human_reply` (permanently excluding it from `/agent/run`, regardless of sentiment), and auto-suppresses on `unsubscribe` sentiment; a bounce marks the message/lead `status = 'bounced'` and adds the address to `suppression` instead — never runs a bounce through sentiment classification. Requires `x-webhook-secret` header matching `WEBHOOK_SECRET`. |
| `POST /agent/run` | **n8n's daily send cron calls this.** Selects leads due for step 1 (no message sent yet), step 2 (step 1 sent 2+ days ago, no step 2 yet), or step 3 (step 1 sent 5+ days ago, no step 3 yet) — excluding anything suppressed or with any reply ever logged. For each: checks suppression, drafts subject/body with Claude (fixed template fallback without a key), sends via the Gmail API (or logs a stub without Google OAuth creds), and logs the `messages` row + a `sent` event. Requires `x-webhook-secret` header matching `WEBHOOK_SECRET`. Returns a JSON summary (`processed`, `sent`, `skipped_suppressed`, `skipped_no_campaign`, `skipped_daily_limit`, `errors`). |
| `POST /leads/source` | **n8n's daily scraping cron calls this.** Discovers small-business decision-makers via OpenStreetMap (Overpass API, free/no key) + Hunter/pattern-guessing (see **Lead sourcing** below), verifies, and upserts qualifying leads. Requires `x-webhook-secret` header matching `WEBHOOK_SECRET`. **Runs asynchronously** — responds immediately (`202 {"status":"started"}`) and does the actual work in the background; see **Lead sourcing** below for why and how to check results. |
| `GET /suppression/check?email=` | Check if an email is suppressed |
| `POST /suppression` | Add a suppression record |
| `POST /events` | Log a generic event (`delivered`, `opened`, `clicked`, etc.) |
| `GET /health` | Health check |

Note: `/agent/run` picks a campaign for each lead by matching `campaigns.niche`
to the lead's `niche` where `campaigns.status = 'active'`, and respects that
campaign's `daily_send_limit` (skipping once the day's cap is hit). A lead
with no matching active campaign is skipped (`skipped_no_campaign`) —
`/leads/source` auto-creates one the first time it sources a lead in a
brand-new niche (see **Lead sourcing** below), so this only bites if you're
inserting leads into `/leads` directly with a niche `/leads/source` has
never encountered, or if you manually paused the campaign it created.

## Lead sourcing (`POST /leads/source`)

n8n's scraping cron calls this once daily. Pipeline per call:

1. **Discovery** — rotates through a fixed list of business-type queries
   (solar, moving, insurance, real estate, plumbing, landscaping, HVAC,
   dental, law, ecommerce boutiques — see `QUERY_TEMPLATES` in
   `backend/src/routes/sourceLeads.js`) crossed with a mix of US/UK cities
   (hardcoded lat/lon centers, no geocoding call needed), deterministically
   offset by day-of-year so a daily cron works through new ground instead of
   repeating itself. Search runs against **OpenStreetMap's Overpass API** —
   free, no API key, no billing account — via `backend/src/lib/osm.js`. Each
   query matches a standard OSM tag where one exists (`office=insurance`,
   `office=estate_agent`, `craft=plumber`, `craft=gardener`, `craft=hvac`,
   `amenity=dentist`, `office=lawyer`, `shop=clothes`) or a name-regex match
   for the two categories with no dedicated tag (solar, moving).
   `OSM_QUERIES_PER_RUN` (default 4) caps how many query×city combos run per
   call; `OSM_RADIUS_METERS` (default 12000) sets the search radius around
   each city center; `OSM_ELEMENTS_PER_RUN` (default 25) caps how many
   returned businesses get processed for owner-contact lookup per call.
2. **Independent-business filter** — OSM carries no review/rating data the
   way Places did, so the heuristic instead checks OSM's `brand` tag (the
   standard convention for chain/franchise locations, e.g. `brand=Starbucks`)
   — its absence is the proxy for "independently owned". No website at all
   is skipped, not flagged — there's no domain to derive or verify an email
   against, so nothing downstream is actionable. **Caveat found during
   testing**: OSM tagging is contributor-driven and inconsistent — e.g.
   individual State Farm insurance agents showed up untagged with `brand`
   even though "State Farm" is in the business name, so they passed this
   filter. The heuristic catches obvious chains, not every franchise
   arrangement; it's a proxy, not a guarantee.
3. **Owner contact** — Hunter.io domain search first (25 free searches/month
   **total**, so it's spent only on businesses that already cleared the
   filter above, capped per run by `HUNTER_MAX_CALLS_PER_RUN` (default 1)
   and by the account's live remaining quota via Hunter's `/account`
   endpoint), filtered to results with `seniority: executive` or a
   CEO/founder/owner/president/principal/managing-partner title. If Hunter
   finds nothing (or is unset/exhausted), falls back to pattern-guessing
   `owner@domain`, then `<guessed-first-name>@domain` (only when the
   business name looks personal, e.g. "Dave's Plumbing"), then `info@domain`
   as a last resort — each guess run through the existing `/verify` logic
   (MX check, Reoon fallback if `REOON_API_KEY` is set) before being
   accepted.
4. **Dedupe** — skipped if the business (name+city) or domain already exists
   in `leads`, or the domain already appears in `suppression`.
5. **Signal tagging** — `leads.signal` is populated with why the lead was
   picked (e.g. `"independent solar companies — no major brand/chain
   affiliation found (OpenStreetMap)"`), which is what the drafting prompt
   grounds copy in.
6. **Auto-creates a campaign for brand-new niches** — right before inserting
   a lead, if `campaigns` has no row at all for that niche (any status),
   one is created: `name = "<query label> — Auto"`, `status = 'active'`,
   `daily_send_limit = AUTO_CAMPAIGN_DAILY_SEND_LIMIT` (default 20). Logged
   via `console.log` and listed in the response's `campaigns_auto_created`
   array. This is what keeps sourcing and sending fully hands-off — a newly
   discovered niche starts getting emailed by the next `/agent/run` without
   you manually inserting a campaign row. If a campaign for that niche
   already exists (even paused), no duplicate is created.
7. No fixed target count — it runs the capped batch of query×city combos for
   that call.

### Why this endpoint is asynchronous

Overpass's latency is too unpredictable to fit reliably inside a single
request/response cycle — the exact same query has been observed returning
`200`, then `504`, then `200` again within seconds of each other during
testing. A synchronous version of this endpoint hit real 502s in production
once Overpass had a slow run: the request/response socket got killed by
Node's own default 5-minute `http.Server` request timeout partway through
(not Railway's edge — Railway's platform max is a documented 15 minutes),
and Railway's proxy surfaced that as a 502 to the caller. No fixed batch
size can *reliably* dodge this, since even one Overpass query can take over
a minute once retries kick in, and a "safe" batch size today could still
blow the same budget on a worse day.

So `POST /leads/source` responds immediately —
`202 {"status": "started", ...}` — and does the actual discovery/verify/
insert work in the background after responding. There's deliberately no
separate status-polling endpoint: check the `leads`/`campaigns` tables for
results, or `railway logs` for the full per-run summary (logged as
`[leads/source] run complete: {...}` with the same fields the old synchronous
response used to return directly). A second call while one is already
running gets `200 {"status": "already_running"}` instead of starting an
overlapping job — this relies on a single in-memory flag, which only works
correctly because this service runs as one Railway replica; if it's ever
scaled horizontally, that guard needs to move to a DB-backed lock.

**n8n side**: no timeout tuning needed for this specific 502 anymore (the
call returns in milliseconds either way), but the workflow shouldn't expect
the response to reflect finished work — treat `POST /leads/source` as
"kick off today's sourcing run," not "wait for today's yield."

### Known gap: seniority confidence varies by contact method

`leads.title` is populated when Hunter returns one (Hunter has actual title
data), but the **pattern-guessing fallback path never confirms a real
person or title** — `owner@domain` and `info@domain` are just plausible
addresses that passed a mail-server-exists check, not evidence the mailbox
belongs to an actual owner. `enrichment.contact_method` on each lead records
which path found it (`"hunter"` vs `"pattern_guess"`), so you can see which
leads have real seniority confidence and which are inferred from the
brand-tag heuristic alone. The drafting prompt still writes
founder-to-founder copy for every lead regardless of `contact_method` —
tightening that (e.g. softer tone for `pattern_guess` leads, or skipping
`info@` contacts from the founder-to-founder framing entirely) is a
reasonable next step once you see real yield data.

**Important caveat on pattern-guessed emails**: MX-only verification (no
`REOON_API_KEY` set) only confirms the *domain* accepts mail — it cannot
tell you a specific guessed mailbox like `owner@acme.com` actually exists.
Nearly every guess will "pass" MX check even when wrong, which will surface
later as bounces rather than upfront rejections. Setting `REOON_API_KEY`
(power/SMTP-level verification) meaningfully tightens this and is strongly
recommended before scaling up pattern-guessed volume.

### Other free tools considered, not yet wired in

- **Google Custom Search JSON API** (100 free queries/day) to detect hiring
  signals directly (e.g. `site:indeed.com "front desk" "[company]"`) instead
  of only inferring signal from OSM tags — highest-value addition, but needs
  its own API key + Custom Search Engine setup (no billing account required
  at this quota). Recommend adding as a follow-up once you've seen real
  yield/quality from the OSM+Hunter pipeline, not bundled into this first
  version.
- **Yelp Fusion API** (free tier) as a second discovery source alongside
  OSM — some independent businesses have a Yelp presence without an OSM
  listing (OSM coverage is contributor-driven and uneven by region), or vice
  versa. Worth adding for coverage once OSM's yield plateaus.
- **OpenCorporates API** (free tier, rate-limited) to sharpen the
  independent-vs-franchise heuristic beyond the brand-tag proxy — lower
  priority; the current heuristic is workable to start.

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

## Bounce handling

Gmail bounce notifications (DSNs) land in the same inbox the sending account
uses — they're mail *to* the sender, not from the lead. If `/webhook/inbound`
treated them like ordinary replies, they'd get run through sentiment
classification (garbage in, garbage out) and mark a dead lead as
`needs_human_reply` instead of suppressing it. Instead `backend/src/lib/bounce.js`
detects them first via `looksLikeBounce()` — sender matches
`mailer-daemon@`/`postmaster@`, or the subject matches common DSN patterns
("Delivery Status Notification", "undelivered mail", etc.) — and branches to
`handleBounce()` in `webhook.js` instead of the reply path.

**Identifying which lead/message bounced**, in order of reliability:
1. If n8n forwarded the raw `.eml` (so mailparser could see attachments):
   Gmail typically embeds the original outbound message as a
   `message/rfc822` attachment inside the DSN. `extractOriginalMessageId()`
   scans it for our own `Message-ID` header and matches it directly against
   `messages.message_id` — exact, no guessing.
2. Otherwise (n8n sent already-flattened fields, or no attachment found):
   `extractRecipientFromBounceText()` scans the bounce's free-text body for
   an email address that isn't the bounce sender itself (Gmail's bounce text
   typically reads "Your message wasn't delivered to x@y.com because...").
   Weaker — could misfire if the body mentions a different address first —
   but better than discarding the bounce.

**On a resolved bounce**: `messages.status = 'bounced'`, `leads.status =
'bounced'`, a `bounced` event is logged, and the address is added to
`suppression` (reason `hard_bounce`) — this last part is what actually stops
`/agent/run` from emailing it again, checked before every send regardless of
`leads.status`. If neither extraction method resolves a lead (e.g. the
bounce is for an address never in `leads` at all), the event is still logged
with `lead_id`/`message_id` null for manual triage, and the response has
`resolved: false`.

**Caveat**: pattern-guessed emails from `/leads/source` (see **Lead
sourcing** above) bounce more often than Hunter-sourced ones — MX-only
verification only confirms the domain accepts mail, not that a specific
guessed mailbox exists. This bounce handling is what closes that loop:
every bounce a guessed address produces gets it suppressed automatically
instead of silently wasting future sends.

## Connecting to n8n Cloud

Once the backend has a public Railway domain, n8n has two cron workflows —
both trivial, since the backend owns all the actual logic:

**1. Daily send** — decides who to email, drafts copy, sends, schedules
follow-ups, all server-side:
- **Schedule Trigger** node — once daily (pick whatever time you want sends
  to go out).
- **HTTP Request** node — `POST https://<backend-domain>/agent/run`, header
  `x-webhook-secret: <your WEBHOOK_SECRET>`, no body needed.

**2. Daily lead sourcing** — discovers new leads via OpenStreetMap/Hunter and
upserts qualifying ones:
- **Schedule Trigger** node — once daily, ideally *before* the send cron so
  freshly sourced leads are eligible for that day's send run.
- **HTTP Request** node — `POST https://<backend-domain>/leads/source`,
  header `x-webhook-secret: <your WEBHOOK_SECRET>`, no body needed.

That's it for both. The backend decides everything — n8n just has to fire
two crons.

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
