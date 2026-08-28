// Thin wrapper around Hunter.io's free tier (25 domain searches/month
// total, shared across everything using this key). Treated as scarce:
// callers should check quota before spending a search, and /leads/source
// caps how many it will spend per run via HUNTER_MAX_CALLS_PER_RUN.

function getApiKey() {
  return process.env.HUNTER_API_KEY || null;
}

export function hunterConfigured() {
  return Boolean(getApiKey());
}

const DECISION_MAKER_PATTERN = /\b(ceo|founder|co-founder|owner|president|principal|managing partner)\b/i;

// Hunter's /account endpoint reports quota and does not itself consume a
// search credit, so it's safe to call before every run.
export async function getHunterQuota() {
  const apiKey = getApiKey();
  if (!apiKey) return null;

  const res = await fetch(`https://api.hunter.io/v2/account?api_key=${encodeURIComponent(apiKey)}`);
  if (!res.ok) return null;
  const data = await res.json();

  const searches = data?.data?.requests?.searches;
  if (!searches) return null;
  return { available: searches.available, used: searches.used };
}

// Spends one Hunter search credit. Returns the best decision-maker contact
// found on the domain, or null if none qualifies. Never throws on a normal
// "no result" response — only on a transport/API failure.
export async function hunterDomainSearch(domain) {
  const apiKey = getApiKey();
  if (!apiKey) return null;

  const url = `https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(domain)}&api_key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url);
  if (!res.ok) {
    if (res.status === 429 || res.status === 403) return null; // quota exhausted mid-run
    throw new Error(`Hunter domain search failed: ${res.status}`);
  }
  const data = await res.json();
  const emails = data?.data?.emails ?? [];

  const decisionMaker = emails.find(
    (e) => e.seniority === 'executive' || DECISION_MAKER_PATTERN.test(e.position || '')
  );
  if (!decisionMaker) return null;

  return {
    email: decisionMaker.value,
    firstName: decisionMaker.first_name || null,
    lastName: decisionMaker.last_name || null,
    title: decisionMaker.position || null,
    confidence: decisionMaker.confidence ?? null,
  };
}
