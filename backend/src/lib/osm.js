// Thin wrapper around OpenStreetMap's Overpass API — free, no API key, no
// billing account. Replaces the earlier Google Places integration (Places
// dropped its free tier and now requires a $275/month minimum commitment).
//
// A single Overpass query returns everything Places needed two calls for
// (search + details): name, website, phone, and coordinates, via tags.

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
// Overpass has no auth, but identifying via User-Agent is standard etiquette
// for OSM's free public infrastructure.
const USER_AGENT = 'frank-outreach-lead-sourcing/1.0 (marvellousadegoke3@gmail.com)';

function buildQuery({ osmFilter, lat, lon, radius }) {
  return `[out:json][timeout:40];\n${osmFilter}(around:${radius},${lat},${lon});\nout center tags;`;
}

const RETRY_DELAYS_MS = [3000, 8000]; // Overpass is a free shared instance and occasionally 504s/rate-limits under load

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Node's fetch throws a bare "fetch failed" for network-level errors (DNS,
// TLS, connection refused) with the actual reason nested in `.cause` — and
// that cause is often a system error (ENOTFOUND/ECONNREFUSED/ETIMEDOUT)
// whose useful info is in `.code`/`.errno`/`.syscall`, not `.message` (which
// can be empty). Without this, failures show up in logs as an undiagnosable
// "fetch failed: ".
function describeFetchError(err) {
  if (!err.cause) return err.message;
  const c = err.cause;
  const parts = [c.code, c.syscall, c.address, c.port].filter(Boolean);
  if (parts.length) return `${err.message}: ${parts.join(' ')}`;
  if (c.message) return `${err.message}: ${c.message}`;
  // Last resort — some undici/TLS error shapes carry nothing in the fields
  // above, so dump whatever's on the object rather than going back to a
  // blank, undiagnosable reason.
  try {
    return `${err.message}: ${c.name ?? 'unknown'} ${JSON.stringify(c, Object.getOwnPropertyNames(c))}`;
  } catch {
    return `${err.message}: ${String(c)}`;
  }
}

// Returns normalized candidates: { name, website, phone, lat, lon, brand, osmId }
export async function searchBusinesses({ osmFilter, lat, lon, radius }) {
  const query = buildQuery({ osmFilter, lat, lon, radius });

  let lastError;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      const res = await fetch(OVERPASS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain', 'User-Agent': USER_AGENT },
        body: query,
        // Without this, a network-level stall (not an HTTP error — the
        // connection just never responds) hangs forever, since fetch has no
        // default timeout. Observed exactly this in production: a run sat
        // in "already_running" for 12+ minutes on one stuck query. Overpass's
        // own [timeout:40] only bounds ITS processing time, not the network
        // round-trip, so this needs to be slightly longer, not the same.
        signal: AbortSignal.timeout(45000),
      });
      if (!res.ok) throw new Error(`Overpass query failed: ${res.status}`);
      const data = await res.json();
      return normalizeElements(data.elements);
    } catch (err) {
      lastError = new Error(describeFetchError(err));
      if (attempt < RETRY_DELAYS_MS.length) await sleep(RETRY_DELAYS_MS[attempt]);
    }
  }
  throw lastError;
}

function normalizeElements(elements) {
  return (elements ?? [])
    .filter((el) => el.tags?.name)
    .map((el) => ({
      name: el.tags.name,
      website: el.tags.website || el.tags['contact:website'] || null,
      phone: el.tags.phone || el.tags['contact:phone'] || null,
      lat: el.lat ?? el.center?.lat ?? null,
      lon: el.lon ?? el.center?.lon ?? null,
      brand: el.tags.brand || null,
      osmId: `${el.type}/${el.id}`,
    }));
}

// OSM's `brand` tag is the standard convention for chain/franchise locations
// (e.g. brand=Starbucks) — its absence is our proxy for "independently
// owned", since OSM carries no review-count/rating data to filter on the
// way Places did.
export function looksLikeIndependentBusiness(business) {
  return !business.brand;
}
