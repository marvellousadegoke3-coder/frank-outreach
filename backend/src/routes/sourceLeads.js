import { Router } from 'express';
import { query } from '../lib/db.js';
import { searchPlaces, getPlaceDetails, placesConfigured } from '../lib/places.js';
import { getHunterQuota, hunterDomainSearch, hunterConfigured } from '../lib/hunter.js';
import { candidateEmails } from '../lib/emailGuess.js';
import { verifyEmail } from '../lib/verify.js';

const router = Router();

// Business-type queries, not tied to one niche — cast wide. `niche` is the
// slug stored on the lead row; `label` is what gets interpolated into the
// Places text search.
const QUERY_TEMPLATES = [
  { niche: 'solar', label: 'solar companies' },
  { niche: 'moving', label: 'moving companies' },
  { niche: 'insurance', label: 'insurance agencies' },
  { niche: 'real_estate', label: 'real estate agents' },
  { niche: 'plumbing', label: 'plumbing companies' },
  { niche: 'landscaping', label: 'landscaping companies' },
  { niche: 'hvac', label: 'hvac companies' },
  { niche: 'dental', label: 'dental clinics' },
  { niche: 'law', label: 'law firms' },
  { niche: 'ecommerce', label: 'boutique clothing store' },
];

// Mix of US/UK cities. Rotated by day-of-year so a daily cron works through
// the full set over time instead of hammering the same cities every run.
const CITIES = [
  { city: 'Austin', country: 'US', label: 'Austin, TX' },
  { city: 'Denver', country: 'US', label: 'Denver, CO' },
  { city: 'Phoenix', country: 'US', label: 'Phoenix, AZ' },
  { city: 'Charlotte', country: 'US', label: 'Charlotte, NC' },
  { city: 'Manchester', country: 'UK', label: 'Manchester, UK' },
  { city: 'Bristol', country: 'UK', label: 'Bristol, UK' },
  { city: 'Leeds', country: 'UK', label: 'Leeds, UK' },
  { city: 'Nottingham', country: 'UK', label: 'Nottingham, UK' },
];

// Heuristic bounds for "independently owned small business, not a chain and
// not a ghost listing" — Places doesn't expose ownership structure, so this
// is a proxy: enough reviews to be a real active business, not so many that
// it's obviously a large chain/franchise.
const SMALL_BIZ_MIN_RATINGS = 3;
const SMALL_BIZ_MAX_RATINGS = 400;

function envInt(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

const QUERIES_PER_RUN = envInt('PLACES_QUERIES_PER_RUN', 4);
const DETAILS_PER_RUN = envInt('PLACES_DETAILS_PER_RUN', 25);
const HUNTER_MAX_CALLS_PER_RUN = envInt('HUNTER_MAX_CALLS_PER_RUN', 1);

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

function looksLikeSmallIndependentBusiness(details) {
  const ratings = details.user_ratings_total ?? 0;
  return ratings >= SMALL_BIZ_MIN_RATINGS && ratings <= SMALL_BIZ_MAX_RATINGS;
}

function buildSignal({ queryLabel, details }) {
  const bits = [];
  if (!details.website) bits.push('no website found');
  bits.push(`${queryLabel}, ${details.user_ratings_total ?? 0} reviews`);
  return bits.join(' — ');
}

// POST /leads/source — n8n's daily scraping cron calls this. Discovers small
// businesses via Google Places, filters for a plausible independent-owner
// profile, finds a decision-maker email (Hunter first when it clears the
// quality bar and quota allows, else pattern-guessing verified via MX/Reoon),
// and upserts qualifying leads. No fixed target count — runs a capped batch
// of query x city combos per call and reports real yield.
router.post('/leads/source', async (req, res) => {
  if (process.env.WEBHOOK_SECRET) {
    if (req.get('x-webhook-secret') !== process.env.WEBHOOK_SECRET) {
      return res.status(401).json({ error: 'invalid webhook secret' });
    }
  }

  if (!placesConfigured()) {
    return res.status(400).json({ error: 'GOOGLE_PLACES_API_KEY is not configured' });
  }

  const summary = {
    queries_run: 0,
    places_found: 0,
    places_detail_checked: 0,
    skipped_not_small_business: 0,
    skipped_no_website: 0,
    skipped_duplicate: 0,
    hunter_calls_used: 0,
    hunter_quota_remaining: null,
    pattern_guesses_tried: 0,
    verified: 0,
    skipped_no_email_found: 0,
    inserted: 0,
    errors: [],
  };

  let hunterCallsRemainingThisRun = HUNTER_MAX_CALLS_PER_RUN;
  if (hunterConfigured()) {
    const quota = await getHunterQuota();
    if (quota) {
      summary.hunter_quota_remaining = quota.available;
      hunterCallsRemainingThisRun = Math.min(hunterCallsRemainingThisRun, quota.available);
    }
  }

  const combos = pickCombosForToday(QUERIES_PER_RUN);
  let detailsChecked = 0;

  for (const { query: q, city } of combos) {
    summary.queries_run++;
    const searchText = `${q.label} in ${city.label}`;

    let places;
    try {
      places = await searchPlaces(searchText);
    } catch (err) {
      summary.errors.push({ query: searchText, error: err.message });
      continue;
    }
    summary.places_found += places.length;

    for (const place of places) {
      if (detailsChecked >= DETAILS_PER_RUN) break;

      try {
        // Dedupe on place before spending a Details call: name+city match
        // against existing leads is the closest cheap proxy we have pre-domain.
        const { rows: existingByName } = await query(
          `SELECT 1 FROM leads WHERE company = $1 AND city = $2 LIMIT 1`,
          [place.name, city.city]
        );
        if (existingByName.length) {
          summary.skipped_duplicate++;
          continue;
        }

        const details = await getPlaceDetails(place.place_id);
        detailsChecked++;
        summary.places_detail_checked++;
        if (!details) continue;

        if (!looksLikeSmallIndependentBusiness(details)) {
          summary.skipped_not_small_business++;
          continue;
        }

        const domain = extractDomain(details.website);
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

        const signal = buildSignal({ queryLabel: q.label, details });

        let contact = null;

        // Hunter is scarce (25/month total) — only spend it on businesses
        // that already cleared the small-independent-business bar above,
        // and only while this run's budget and the account's live quota allow.
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
        // note MX-only verification confirms the *domain* accepts mail, not
        // that this specific mailbox exists, so this is weaker signal than a
        // Hunter hit or a Reoon-backed verification (set REOON_API_KEY to
        // tighten this).
        if (!contact) {
          for (const guess of candidateEmails(domain, place.name)) {
            summary.pattern_guesses_tried++;
            const result = await verifyEmail(guess);
            if (result.verified) {
              contact = { email: guess, firstName: null, lastName: null, title: null };
              break;
            }
          }
        }

        if (!contact) {
          summary.skipped_no_email_found++;
          continue;
        }

        const verification = await verifyEmail(contact.email);
        if (!verification.verified) {
          summary.skipped_no_email_found++;
          continue;
        }
        summary.verified++;

        await query(
          `INSERT INTO leads
            (email, first_name, last_name, title, company, domain, niche, city, country, source, signal, verified, catch_all, status, enrichment)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'places_scrape',$10,$11,$12,'new',$13)
           ON CONFLICT (email) DO NOTHING`,
          [
            contact.email,
            contact.firstName,
            contact.lastName,
            contact.title,
            place.name,
            domain,
            q.niche,
            city.city,
            city.country,
            signal,
            verification.verified,
            verification.catchAll,
            JSON.stringify({
              place_id: place.place_id,
              website: details.website,
              rating: details.rating,
              user_ratings_total: details.user_ratings_total,
              formatted_phone_number: details.formatted_phone_number,
              discovery_query: searchText,
              contact_method: contact.title ? 'hunter' : 'pattern_guess',
            }),
          ]
        );
        summary.inserted++;
      } catch (err) {
        summary.errors.push({ place: place.name, error: err.message });
      }
    }
  }

  res.json(summary);
});

export default router;
