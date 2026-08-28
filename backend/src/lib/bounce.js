// Best-effort Gmail/SMTP bounce (DSN) detection and recipient extraction.
// There's no single machine-readable bounce format guaranteed to survive
// n8n's Gmail Trigger -> webhook path intact, so this layers a few
// heuristics rather than depending on one.

const BOUNCE_SENDER_PATTERN = /^(mailer-daemon|postmaster|mail-daemon)@/i;
const BOUNCE_SUBJECT_PATTERN =
  /(delivery status notification|undelivered mail|mail delivery failed|delivery (has )?failed|returned mail|delivery incomplete|message (could not|wasn'?t) be delivered|delivery notification)/i;

export function looksLikeBounce({ fromEmail, subject }) {
  if (fromEmail && BOUNCE_SENDER_PATTERN.test(fromEmail)) return true;
  if (subject && BOUNCE_SUBJECT_PATTERN.test(subject)) return true;
  return false;
}

// Gmail typically packages the original outbound message as a message/rfc822
// attachment inside the bounce DSN. If n8n forwarded the raw .eml (so
// mailparser could see attachments), scanning that embedded copy for our own
// Message-ID is the most reliable way to identify exactly which send
// bounced — far better than guessing from the bounce's free-text body.
export function extractOriginalMessageId(parsedMail) {
  const attachment = (parsedMail?.attachments ?? []).find(
    (a) => a.contentType === 'message/rfc822' || a.contentType === 'text/rfc822-headers'
  );
  if (!attachment?.content) return null;

  const text = attachment.content.toString('utf8');
  const match = text.match(/^Message-ID:\s*(<[^>]+>)/im);
  return match ? match[1] : null;
}

const EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

// Last-resort extraction when there's no embedded original message to key
// off of (e.g. n8n sent already-flattened fields, not the raw .eml): scan
// the bounce body for an email address that isn't the sending account
// itself. Gmail's bounce text typically reads like "Your message wasn't
// delivered to x@y.com because...". Weak compared to the Message-ID path
// above — can misfire if the bounce body happens to mention another address
// first — but better than discarding the bounce entirely.
export function extractRecipientFromBounceText(text, excludeEmail) {
  if (!text) return null;
  const matches = text.match(EMAIL_PATTERN) ?? [];
  const candidate = matches.find((m) => m.toLowerCase() !== (excludeEmail ?? '').toLowerCase());
  return candidate ? candidate.toLowerCase() : null;
}
