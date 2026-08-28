# Frank Outreach — project context

B2B lead-gen and cold outreach system for Frank Digitals (an AI automation
agency). Deployed on Railway from this GitHub repo
(`marvellousadegoke3-coder/frank-outreach`), connected to n8n Cloud for
scheduling only. Owner's Railway account: `domg1104@gmail.com` (project name
`frank-outreach`, services `frank-outreach` [backend], `dashboard`,
`Postgres`).

**Read this file before making changes.** Update it whenever architecture,
env vars, drafting rules, or known gaps change — it decays fast otherwise.

## Architecture

```
n8n Cloud (2 daily cron triggers, no other logic)
  → POST /leads/source   (backend decides who's a lead, at all)
  → POST /agent/run      (backend decides who to email today, drafts, sends)
       ↓
  backend (Express/ESM, Railway service "frank-outreach")
       ↓
  Postgres (Railway plugin, shared by backend + dashboard)
       ↑
  dashboard (Express + Chart.js, Railway service "dashboard", reads-only)
```

n8n's *only* job is firing two scheduled HTTP requests with the
`x-webhook-secret` header. All decisioning — lead qualification, drafting,
sending, follow-up cadence, suppression, reply handling — lives in the
backend. Do not push logic back into n8n; that was an earlier architecture
this project deliberately moved away from.

## Backend structure

- `src/routes/leads.js` — `POST/GET /leads`, `PATCH /leads/:id/status`
- `src/routes/sourceLeads.js` — `POST /leads/source` (lead discovery)
- `src/routes/agent.js` — `POST /agent/run` (drafting + sending)
- `src/routes/webhook.js` — `POST /webhook/inbound` (reply handling)
- `src/routes/verify.js`, `messages.js`, `events.js`, `suppression.js`, `health.js`
- `src/lib/db.js` — pg pool + `query()` helper
- `src/lib/gmail.js` — Gmail API send (OAuth refresh-token flow)
- `src/lib/draftCopy.js` — Claude drafting prompt + deterministic fallback
- `src/lib/sentiment.js` — Claude reply classification + keyword fallback
- `src/lib/verify.js` — MX check + Reoon fallback
- `src/lib/osm.js`, `hunter.js`, `emailGuess.js` — lead sourcing (OSM
  Overpass API for discovery — free, no key/billing; Google Places was
  dropped after it moved to a $275/month minimum commitment)
- `scripts/gmail-auth.js` — one-time local script to mint `GOOGLE_REFRESH_TOKEN`
- `migrations/*.sql` — additive, idempotent, run manually against Railway
  Postgres (or ask Claude to run them via the public proxy connection string
  if you have it — several have already been applied this way)

Full endpoint table and deploy steps: see [README.md](README.md).

## Sending: Gmail API, not SMTP

`/agent/run` sends via the Gmail API (`users.messages.send` with a raw MIME
message) using OAuth (`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`/
`GOOGLE_REFRESH_TOKEN`). Sending Gmail account: `marvellousadegoke3@gmail.com`.
If any of the three Google env vars are missing, sends are logged (stubbed),
not delivered — the whole pipeline still runs end-to-end safely.

Threading: every send mints its own `Message-ID` header (independent of
Gmail's own message id), stored in `messages.message_id`. Follow-ups set
`In-Reply-To`/`References` to the lead's most recent prior message's
`Message-ID`, and reuse its Gmail `threadId` (stored in `messages.thread_id`)
so replies land in the same Gmail conversation. `/webhook/inbound` matches
inbound replies back via `In-Reply-To`/`References` — don't change the
Message-ID scheme without checking that matching logic.

## Drafting spec (locked in — don't drift from this without being asked)

Every lead is assumed to be a decision-maker (CEO/founder/owner/principal).
Copy is grounded in the lead's `signal` field (why they were sourced), not a
generic industry pitch, written **founder-to-founder** — peer tone, not
vendor-to-employee.

**Subject**: under 4 words, lowercase, no punctuation/emoji, never the words
"AI" or "automation", no sales language. Step 1 = curiosity/observation.
Step 2 = short bump ("following up", "quick bump"). Step 3 = closing-the-loop
tone ("one more thing", "closing the loop").

**Body**: plain text, 50–125 words, no HTML/images. No link in step 1; one
link allowed in step 2/3 if natural. Structure: (1) one concrete observation
tied to `signal`/`company`/`domain`/`niche`, (2) one line reframing the cost
in time/missed revenue, (3) one soft interest-based CTA ("want to see how"
not "book a call"). No flattery, no exclamation points, no emoji. Sign off
`[SENDER_FIRST_NAME], Frank Digitals` (`SENDER_FIRST_NAME=Frank` is set on
the backend Railway service).

**Step angle**: step 1 = cold intro anchored to signal. Step 2 (+2 days) =
add one new value point or proof, not just a bump. Step 3 (+5 days) =
breakup — polite, low-pressure, invites reply if priorities change.

The deterministic fallback template (used when `ANTHROPIC_API_KEY` is unset,
or Claude's response fails validation) must stay consistent with this same
spec — see `src/lib/draftCopy.js`'s `fallbackDraft()`.

If a Claude drafting or classification call silently falls back with no
visible error, check the code hasn't regressed to swallowing errors without
`console.error` — that exact bug (silent fallback, no logging) happened once
already and wasted debugging time. Always log the caught error before
falling back.

## Lead sourcing (`POST /leads/source`)

OpenStreetMap Overpass API (discovery, free/no key) → independent-business
heuristic (no `brand` tag) → owner contact via Hunter.io (decision-maker titles
only) or pattern-guessing (`owner@`/`<guessed-firstname>@`/`info@`,
MX/Reoon-verified) → dedupe → **auto-create an active `campaigns` row if the
lead's niche has none at all** (`name = "<label> — Auto"`,
`daily_send_limit = AUTO_CAMPAIGN_DAILY_SEND_LIMIT`, default 20; logged via
`console.log` and returned in the response's `campaigns_auto_created` array)
→ insert lead with a `signal` describing why it was picked. This is what
keeps `/leads/source` and `/agent/run` fully hands-off — a newly sourced
niche gets an active campaign automatically instead of silently piling up
leads `/agent/run` has nowhere to send (this resolves Known Gap #2 below).
Only skips auto-create when a campaign row for that niche already exists in
**any** status, so a manually paused campaign is never shadowed by a
duplicate. No fixed target count per run; yield is whatever the capped
query×city batch produces. Full pipeline detail: see README's **Lead
sourcing** section — don't duplicate that detail here, keep this file to
what a fresh session needs to orient itself, not the full spec.

**Known reliability issue (observed directly, not fixed — external)**:
overpass-api.de (the free public Overpass instance) is intermittently
overloaded — the exact same cheap query returned 504, then 200, then 504
within a few seconds of each other during testing. `osm.js` already retries
with backoff (2 retries, 3s/8s delays), and each failed query is caught and
logged per-combo without failing the whole run — but a `/leads/source` call
can legitimately take several minutes if Overpass is having a bad day. Make
sure n8n's HTTP Request node timeout for this workflow is generous (10
min+), not the default. If this becomes a persistent problem, consider a
paid/self-hosted Overpass instance — not worth doing preemptively.

**Known gap**: pattern-guessed leads (no Hunter hit) never confirm a real
person exists at that address or their actual title — `leads.title` stays
null and `enrichment.contact_method` records `"pattern_guess"` vs
`"hunter"`. The drafting prompt doesn't currently vary tone by this. Worth
revisiting once real yield data comes in.

## Free-tier constraints — manage credits carefully

This system runs across four external APIs with real quotas/costs. **Before
adding new API calls to any hot path (per-lead, per-run), check whether it
burns one of these budgets:**

| Service | Limit | Where it's spent | Guard rails already in place |
|---|---|---|---|
| **Hunter.io** | 25 domain searches / **month**, total | `/leads/source`, one call per qualifying business | `HUNTER_MAX_CALLS_PER_RUN` (default 1) + live quota check via `/account` before spending; only spent on businesses that already passed the small-business filter |
| **OSM Overpass** | Free, no key, no billing — but a shared public instance with an unwritten fair-use expectation | `/leads/source` | `OSM_QUERIES_PER_RUN` (default 4 queries/run), `OSM_ELEMENTS_PER_RUN` (default 25 businesses processed/run) |
| **Anthropic (Claude)** | Pay-per-token, no hard free quota | `/agent/run` (drafting, ~1 call/send) + `/webhook/inbound` (sentiment, ~1 call/reply) | None beyond natural volume (bounded by lead count + daily send limits per campaign) — if drafting volume grows a lot, consider a cheaper model for sentiment classification specifically |
| **Gmail API** | Google's standard per-user sending limits (~500/day for regular Gmail accounts) | `/agent/run` | `campaigns.daily_send_limit` per campaign, enforced in `/agent/run` before sending |

When debugging or testing changes to any of these paths, prefer stubbed/local
testing over live calls where possible (e.g. temporarily unset the relevant
API key locally, or test against a throwaway campaign/lead you clean up
after — this has been done before via a direct Postgres connection using the
public proxy connection string, insert test rows, verify, then delete them).
Don't burn real Hunter/Claude/Gmail-send quota on routine
verification unless actually confirming an end-to-end behavior change.

## Known gaps (current)

1. **Pattern-guessed leads have no seniority confirmation** — see Lead
   sourcing section above.
2. ~~`/agent/run`'s campaign matching requires an active `campaigns` row per
   niche~~ — **resolved**: `/leads/source` now auto-creates an active
   campaign the first time it sources a lead in a niche with no campaign row
   at all (see Lead sourcing section above). If sourcing yield looks fine
   but send yield doesn't, it's no longer a missing-campaign issue by
   default — check `campaigns.status` (someone may have manually paused it)
   or `campaigns.daily_send_limit` instead.
3. **MX-only email verification** (no `REOON_API_KEY` set) can't confirm a
   specific mailbox exists, only that the domain accepts mail — relevant
   both for pattern-guessed sourcing emails and for `/verify` generally.

## Don't duplicate work already done

Before re-deriving any of the above from source, check this file and
[README.md](README.md) first — they're kept current. If you find either
file is stale relative to the code, fix it as part of whatever change
revealed the drift, not as a separate task.
