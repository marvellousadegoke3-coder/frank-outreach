// Best-effort fallback when Hunter isn't available/exhausted: guesses a
// plausible owner email from common patterns and the business's own domain.
// Callers MUST still run the guess through verifyEmail() before accepting
// it — see the caveat in the /leads/source route comment about what MX-only
// verification can and can't confirm.

const GENERIC_NAME_WORDS = new Set([
  'the', 'a', 'an', 'and', 'of', 'llc', 'inc', 'co', 'company', 'group',
  'services', 'solutions', 'shop', 'store', 'studio', 'agency',
]);

// Heuristic: businesses named after a person ("Dave's Plumbing", "Maria
// Garcia Realty") often use that first name in their email. Returns null
// when the business name doesn't look personal — this guess is skipped
// far more often than it fires, which is the intent.
export function guessFirstNameFromBusinessName(name) {
  if (!name) return null;
  const firstWord = name.trim().split(/\s+/)[0]?.replace(/['’]s$/i, '').toLowerCase();
  if (!firstWord || firstWord.length < 3) return null;
  if (GENERIC_NAME_WORDS.has(firstWord)) return null;
  if (!/^[a-z]+$/.test(firstWord)) return null;
  return firstWord;
}

// Ordered cheapest/most-likely first: owner@, guessed-first-name@, info@ as
// last resort (spec explicitly ranks these in this order).
export function candidateEmails(domain, businessName) {
  const candidates = [`owner@${domain}`];

  const guessedFirstName = guessFirstNameFromBusinessName(businessName);
  if (guessedFirstName) candidates.push(`${guessedFirstName}@${domain}`);

  candidates.push(`info@${domain}`);
  return candidates;
}
