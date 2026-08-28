// Thin wrapper around the Google Places API (Text Search + Place Details).
// Both endpoints are billed against the same Google Cloud project as the
// Gmail OAuth client, under Google's standard $200/month Maps credit.

const TEXT_SEARCH_URL = 'https://maps.googleapis.com/maps/api/place/textsearch/json';
const DETAILS_URL = 'https://maps.googleapis.com/maps/api/place/details/json';

function getApiKey() {
  return process.env.GOOGLE_PLACES_API_KEY || null;
}

export function placesConfigured() {
  return Boolean(getApiKey());
}

// Text Search does NOT return `website` — only Details does, so this is
// intentionally two calls per candidate business.
export async function searchPlaces(query) {
  const apiKey = getApiKey();
  if (!apiKey) return [];

  const url = `${TEXT_SEARCH_URL}?query=${encodeURIComponent(query)}&key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Places text search failed: ${res.status}`);
  const data = await res.json();

  if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
    throw new Error(`Places text search error: ${data.status} ${data.error_message ?? ''}`);
  }

  return data.results ?? [];
}

const DETAIL_FIELDS = ['name', 'website', 'formatted_phone_number', 'rating', 'user_ratings_total', 'business_status', 'formatted_address'];

export async function getPlaceDetails(placeId) {
  const apiKey = getApiKey();
  if (!apiKey) return null;

  const url = `${DETAILS_URL}?place_id=${encodeURIComponent(placeId)}&fields=${DETAIL_FIELDS.join(',')}&key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Places details failed: ${res.status}`);
  const data = await res.json();

  if (data.status !== 'OK') return null;
  return data.result ?? null;
}
