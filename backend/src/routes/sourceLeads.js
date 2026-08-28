import { Router } from 'express';
import { query } from '../lib/db.js';
import { searchBusinesses, looksLikeIndependentBusiness } from '../lib/osm.js';
import { getHunterQuota, hunterDomainSearch, hunterConfigured } from '../lib/hunter.js';
import { candidateEmails } from '../lib/emailGuess.js';
import { verifyEmail } from '../lib/verify.js';

const router = Router();

// Business-type queries, not tied to one niche — cast wide. `niche` is the
// slug stored on the lead row. `osmFilter` is an Overpass QL selector body
// (missing the trailing `(around:...)` clause, added at query time) — tag
// matches where a standard OSM tag exists, name-regex matches otherwise
// (solar/moving have no widely-adopted dedicated OSM tag).
const QUERY_TEMPLATES = [
  { niche: 'solar', label: 'solar companies', osmFilter: 'nwr["name"~"solar",i]' },
  { niche: 'moving', label: 'moving companies', osmFilter: 'nwr["name"~"moving|movers",i]' },
  { niche: 'insurance', label: 'insurance agencies', osmFilter: 'nwr["office"="insurance"]' },
  { niche: 'real_estate', label: 'real estate agents', osmFilter: 'nwr["office"="estate_agent"]' },
  { niche: 'plumbing', label: 'plumbing companies', osmFilter: 'nwr["craft"="plumber"]' },
  { niche: 'landscaping', label: 'landscaping companies', osmFilter: 'nwr["craft"="gardener"]' },
  { niche: 'hvac', label: 'hvac companies', osmFilter: 'nwr["craft"="hvac"]' },
  { niche: 'dental', label: 'dental clinics', osmFilter: 'nwr["amenity"="dentist"]' },
  { niche: 'law', label: 'law firms', osmFilter: 'nwr["office"="lawyer"]' },
  { niche: 'ecommerce', label: 'boutique clothing store', osmFilter: 'nwr["shop"="clothes"]' },
];

// Mix of US/UK cities with hardcoded centers (no geocoding call needed).
// Rotated by day-of-year so a daily cron works through the full set over
// time instead of hammering the same cities every run.
const CITIES = [
  { city: 'Austin', country: 'US', label: 'Austin, TX', lat: 30.2672, lon: -97.7431 },
  { city: 'Denver', country: 'US', label: 'Denver, CO', lat: 39.7392, lon: -104.9903 },
  { city: 'Phoenix', country: 'US', label: 'Phoenix, AZ', lat: 33.4484, lon: -112.0740 },
  { city: 'Charlotte', country: 'US', label: 'Charlotte, NC', lat: 35.2271, lon: -80.8431 },
  { city: 'Manchester', country: 'UK', label: 'Manchester, UK', lat: 53.4808, lon: -2.2426 },
  { city: 'Bristol', country: 'UK', label: 'Bristol, UK', lat: 51.4545, lon: -2.5879 },
  { city: 'Leeds', country: 'UK', label: 'Leeds, UK', lat: 53.8008, lon: -1.5491 },
  { city: 'Nottingham', country: 'UK', label: 'Nottingham, UK', lat: 52.9548, lon: -1.1581 },
];

function envInt(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

const QUERIES_PER_RUN = envInt('OSM_QUERIES_PER_RUN', 4);
const ELEMENTS_PER_RUN = envInt('OSM_ELEMENTS_PER_RUN', 25);
const RADIUS_METERS = envInt('OSM_RADIUS_METERS', 12000);
const HUNTER_MAX_CALLS_PER_RUN = envInt('HUNTER_MAX_CALLS_PER_RUN', 1);
const AUTO_CAMPAIGN_DAILY_SEND_LIMIT = envInt('AUTO_CAMPAIGN_DAILY_SEND_LIMIT', 20);

// /agent/run only sends into a niche if an active campaign row exists for
// it. Without this, a newly sourced niche would sit unsent until someone
// manually adds a campaign — defeating the point of an unattended pipeline.
// Only creates one when NO campaign row exists for the niche at all (any
// status), so a deliberately paused/manual campaign is never shadowed by an
// auto-created duplicate.
async function ensureCampaignForNiche(niche, label, ensuredNiches, summary) {
  if (ensuredNiches.has(niche)) return;
  ensuredNiches.add(niche);

  const { rows } = await query(`SELECT 1 FROM campaigns WHERE niche = $1 LIMIT 1`, [niche]);
  if (rows.length) return;

  const name = `${label.charAt(0).toUpperCase()}${label.slice(1)} — Auto`;
  await query(
    `INSERT INTO campaigns (name, niche, status, daily_send_limit) VALUES ($1, $2, 'active', $3)`,
    [name, niche, AUTO_CAMPAIGN_DAILY_SEND_LIMIT]
  );
  const note = `auto-created campaign "${name}" for niche "${niche}" (daily_send_limit=${AUTO_CAMPAIGN_DAILY_SEND_LIMIT})`;
  console.log(`[leads/source] ${note}`);
  summary.campaigns_auto_created.push(note);
}

function dayOfYear() {
  const now = new Date();
  const start = Date.UTC(now.getUTCFullYear(), 0, 0);
  return Math.floor((Date.now() - start) / 86400000);
}

// Deterministically rotates through query x city combos using the day of
// year as an offset, so consecutive daily runs cover new ground.
function pickCombosForToday(count) {
  const all = [];
  for (const q of QUERY_TEMPLATES) {
    for (const c of CITIES) all.push({ query: q, city: c });
  }
  const offset = dayOfYear() % all.length;
  const combos = [];
  for (let i = 0; i < count; i++) combos.push(all[(offset + i) % all.length]);
  return combos;
}

function extractDomain(website) {
  if (!website) return null;
  try {
    const host = new URL(website).hostname.replace(/^www\./, '');
    return host || null;
  } catch {
    return null;
  }
}

function buildSignal(queryLabel) {
  return `independent ${queryLabel} — no major brand/chain affiliation found (OpenStreetMap)`;
}

// Overpass's latency is too unpredictable to fit any fixed batch size inside
// a request/response cycle reliably (the exact same query has been observed
// returning 200, then 504, then 200 within seconds of each other) — so this
// runs as a fire-and-forget background job instead of a synchronous request.
// A single in-memory flag is enough to prevent overlapping runs because this
// service runs as one Railway replica; if it's ever scaled horizontally,
// this needs to move to a DB-backed lock instead.
let sourcingInProgress = false;

async function runSourcingJob() {
  const summary = {
    queries_run: 0,
    businesses_found: 0,
    businesses_checked: 0,
    skipped_likely_chain: 0,
    skipped_no_website: 0,
    skipped_duplicate: 0,
    hunter_calls_used: 0,
    hunter_quota_remaining: null,
    pattern_guesses_tried: 0,
    verified: 0,
    skipped_no_email_found: 0,
    inserted: 0,
    campaigns_auto_created: [],
    errors: [],
  };
  const ensuredNiches = new Set();

  let hunterCallsRemainingThisRun = HUNTER_MAX_CALLS_PER_RUN;
  if (hunterConfigured()) {
    const quota = await getHunterQuota();
    if (quota) {
      summary.hunter_quota_remaining = quota.available;
      hunterCallsRemainingThisRun = Math.min(hunterCallsRemainingThisRun, quota.available);
    }
  }

  const combos = pickCombosForToday(QUERIES_PER_RUN);
  let checked = 0;

  for (const { query: q, city } of combos) {
    summary.queries_run++;

    let businesses;
    try {
      businesses = await searchBusinesses({ osmFilter: q.osmFilter, lat: city.lat, lon: city.lon, radius: RADIUS_METERS });
    } catch (err) {
      summary.errors.push({ query: `${q.label} in ${city.label}`, error: err.message });
      continue;
    }
    summary.businesses_found += businesses.length;

    for (const business of businesses) {
      if (checked >= ELEMENTS_PER_RUN) break;
      checked++;
      summary.businesses_checked++;

      try {
        const { rows: existingByName } = await query(
          `SELECT 1 FROM leads WHERE company = $1 AND city = $2 LIMIT 1`,
          [business.name, city.city]
        );
        if (existingByName.length) {
          summary.skipped_duplicate++;
          continue;
        }

        if (!looksLikeIndependentBusiness(business)) {
          summary.skipped_likely_chain++;
          continue;
        }

        const domain = extractDomain(business.website);
        if (!domain) {
          // No website means no domain to derive or verify an email against
          // — nothing actionable via this pipeline, so skip rather than guess.
          summary.skipped_no_website++;
          continue;
        }

        const { rows: existingByDomain } = await query(
          `SELECT 1 FROM leads WHERE domain = $1
           UNION SELECT 1 FROM suppression WHERE email LIKE '%@' || $1 LIMIT 1`,
          [domain]
        );
        if (existingByDomain.length) {
          summary.skipped_duplicate++;
          continue;
        }

        const signal = buildSignal(q.label);

        let contact = null;
        let verification = null; // set inline when the pattern-guess loop already verified it

        // Hunter is scarce (25/month total) — only spend it on businesses
        // that already cleared the independent-business filter above, and
        // only while this run's budget and the account's live quota allow.
        // Hunter-found addresses are data-mined, not verified, so they still
        // need the verifyEmail() call below.
        if (hunterConfigured() && hunterCallsRemainingThisRun > 0) {
          hunterCallsRemainingThisRun--;
          summary.hunter_calls_used++;
          const hunterResult = await hunterDomainSearch(domain);
          if (hunterResult) {
            contact = {
              email: hunterResult.email,
              firstName: hunterResult.firstName,
              lastName: hunterResult.lastName,
              title: hunterResult.title,
            };
          }
        }

        // Fall back to pattern guessing when Hunter found nothing (or was
        // skipped/exhausted). Each guess still has to pass verifyEmail() —
        // MX-only confirms the *domain* accepts mail, not that this specific
        // mailbox exists; setting REOON_API_KEY upgrades this same call to
        // real SMTP-level mailbox verification (verifyEmail() already tries
        // Reoon automatically whenever that key is set — no extra wiring).
        if (!contact) {
          for (const guess of candidateEmails(domain, business.name)) {
            summary.pattern_guesses_tried++;
            const result = await verifyEmail(guess);
            if (result.verified) {
              contact = { email: guess, firstName: null, lastName: null, title: null };
              verification = result; // already verified above — don't spend a second (Reoon, paid) call on it below
              break;
            }
          }
        }

        if (!contact) {
          summary.skipped_no_email_found++;
          continue;
        }

        // Hunter-sourced contacts reach here unverified; pattern-guessed
        // ones were already verified in the loop above and shouldn't pay
        // for a redundant second Reoon call on the same address.
        if (!verification) {
          verification = await verifyEmail(contact.email);
        }
        if (!verification.verified) {
          summary.skipped_no_email_found++;
          continue;
        }
        summary.verified++;

        await ensureCampaignForNiche(q.niche, q.label, ensuredNiches, summary);

        await query(
          `INSERT INTO leads
            (email, first_name, last_name, title, company, domain, niche, city, country, source, signal, verified, catch_all, status, enrichment)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'osm_scrape',$10,$11,$12,'new',$13)
           ON CONFLICT (email) DO NOTHING`,
          [
            contact.email,
            contact.firstName,
            contact.lastName,
            contact.title,
            business.name,
            domain,
            q.niche,
            city.city,
            city.country,
            signal,
            verification.verified,
            verification.catchAll,
            JSON.stringify({
              osm_id: business.osmId,
              website: business.website,
              phone: business.phone,
              lat: business.lat,
              lon: business.lon,
              discovery_query: `${q.label} in ${city.label}`,
              contact_method: contact.title ? 'hunter' : 'pattern_guess',
            }),
          ]
        );
        summary.inserted++;
      } catch (err) {
        summary.errors.push({ business: business.name, error: err.message });
      }
    }
  }

  return summary;
}

// POST /leads/source — n8n's daily scraping cron calls this. Discovers small
// businesses via OpenStreetMap's Overpass API (free, no key/billing), filters
// for a plausible independent-owner profile, finds a decision-maker email
// (Hunter first when it clears the quality bar and quota allows, else
// pattern-guessing verified via MX/Reoon), and upserts qualifying leads. No
// fixed target count — runs a capped batch of query x city combos per call.
//
// Responds immediately (202) and runs the actual sourcing work in the
// background — see the comment on `sourcingInProgress` above for why.
// There is no separate status endpoint by design: check `leads`/`campaigns`
// for results, or `railway logs` for the full per-run summary (logged as
// "[leads/source] run complete").
router.post('/leads/source', async (req, res) => {
  if (process.env.WEBHOOK_SECRET) {
    if (req.get('x-webhook-secret') !== process.env.WEBHOOK_SECRET) {
      return res.status(401).json({ error: 'invalid webhook secret' });
    }
  }

  if (sourcingInProgress) {
    return res.status(200).json({
      status: 'already_running',
      message: 'A /leads/source run is already in progress. Check the leads/campaigns tables or Railway logs once it finishes.',
    });
  }

  sourcingInProgress = true;
  res.status(202).json({
    status: 'started',
    message: 'Lead sourcing started in the background. Overpass latency varies run to run — check the leads/campaigns tables afterward, or `railway logs` for the full per-run summary.',
  });

  runSourcingJob()
    .then((summary) => console.log('[leads/source] run complete:', JSON.stringify(summary)))
    .catch((err) => console.error('[leads/source] run failed:', err))
    .finally(() => {
      sourcingInProgress = false;
    });
});

export default router;
