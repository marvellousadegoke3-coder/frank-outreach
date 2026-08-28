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
      });
      if (!res.ok) throw new Error(`Overpass query failed: ${res.status}`);
      const data = await res.json();
      return normalizeElements(data.elements);
    } catch (err) {
      // `fetch` throws a generic "fetch failed" for network-level errors
      // (DNS, TLS, connection refused) with the real reason nested in
      // `.cause` — surface it, since "fetch failed" alone isn't
      // diagnosable from logs.
      lastError = err.cause ? new Error(`${err.message}: ${err.cause.message ?? err.cause}`) : err;
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
