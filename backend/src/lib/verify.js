import dns from 'node:dns/promises';

async function mxCheck(email) {
  const domain = email.split('@')[1];
  if (!domain) return { valid: false, catchAll: false, reason: 'malformed_email' };

  try {
    const records = await dns.resolveMx(domain);
    if (!records || records.length === 0) {
      return { valid: false, catchAll: false, reason: 'no_mx_records' };
    }
    return { valid: true, catchAll: false, reason: 'mx_found', domain };
  } catch (err) {
    return { valid: false, catchAll: false, reason: 'dns_lookup_failed' };
  }
}

async function reoonCheck(email) {
  const apiKey = process.env.REOON_API_KEY;
  if (!apiKey) return null;

  const url = `https://emailverifier.reoon.com/api/v1/verify?email=${encodeURIComponent(
    email
  )}&key=${encodeURIComponent(apiKey)}&mode=power`;

  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();

  return {
    valid: data.status === 'safe' || data.status === 'valid',
    catchAll: Boolean(data.is_catch_all ?? data.catch_all),
    reason: data.status ?? 'reoon_unknown',
    raw: data,
  };
}

// Runs MX check first (cheap). If MX passes but domain could be catch-all,
// or MX fails outright, falls back to Reoon when configured for a
// more conclusive verdict.
export async function verifyEmail(email) {
  const mxResult = await mxCheck(email);

  if (!mxResult.valid) {
    const fallback = await reoonCheck(email);
    if (fallback) {
      return { email, verified: fallback.valid, catchAll: fallback.catchAll, method: 'reoon', detail: fallback.reason };
    }
    return { email, verified: false, catchAll: false, method: 'mx', detail: mxResult.reason };
  }

  const fallback = await reoonCheck(email);
  if (fallback) {
    return { email, verified: fallback.valid, catchAll: fallback.catchAll, method: 'reoon', detail: fallback.reason };
  }

  return { email, verified: true, catchAll: false, method: 'mx', detail: mxResult.reason };
}
