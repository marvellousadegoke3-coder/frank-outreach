import { Router } from 'express';
import { simpleParser } from 'mailparser';
import { query } from '../lib/db.js';
import { classifySentiment } from '../lib/sentiment.js';
import { looksLikeBounce, extractOriginalMessageId, extractRecipientFromBounceText } from '../lib/bounce.js';

const router = Router();

function extractEmail(addressField) {
  if (!addressField) return null;
  if (typeof addressField === 'string') {
    const match = addressField.match(/<([^>]+)>/);
    return (match ? match[1] : addressField).trim().toLowerCase();
  }
  // mailparser AddressObject shape
  return addressField.value?.[0]?.address?.toLowerCase() ?? null;
}

// Marks the bounced message/lead and adds the dead address to suppression,
// so /agent/run stops wasting sends on it. Note: this handles the message
// row's status directly (unlike PATCH /messages/:id/bounced, which requires
// knowing the message id already) because a bounce arrives with only an
// email/thread to go on, not a message id.
async function handleBounce({ res, parsedMail, subject, textBody, fromEmail }) {
  try {
    let message = null;
    let lead = null;
    let guessedEmail = null;

    const originalMessageId = extractOriginalMessageId(parsedMail);
    if (originalMessageId) {
      const { rows } = await query(`SELECT * FROM messages WHERE message_id = $1 LIMIT 1`, [originalMessageId]);
      message = rows[0] ?? null;
    }

    if (message) {
      const { rows } = await query(`SELECT * FROM leads WHERE id = $1`, [message.lead_id]);
      lead = rows[0] ?? null;
    } else {
      // No embedded original message to key off — fall back to guessing the
      // recipient from the bounce's free-text body (see bounce.js caveat).
      guessedEmail = extractRecipientFromBounceText(textBody, fromEmail);
      if (guessedEmail) {
        const { rows } = await query(`SELECT * FROM leads WHERE email = $1`, [guessedEmail]);
        lead = rows[0] ?? null;
        if (lead) {
          const msgRows = await query(
            `SELECT * FROM messages WHERE lead_id = $1 ORDER BY sent_at DESC NULLS LAST LIMIT 1`,
            [lead.id]
          );
          message = msgRows.rows[0] ?? null;
        }
      }
    }

    const event = await query(
      `INSERT INTO events (message_id, lead_id, type, raw, occurred_at)
       VALUES ($1, $2, 'bounced', $3, now())
       RETURNING *`,
      [
        message?.id ?? null,
        lead?.id ?? null,
        JSON.stringify({ from: fromEmail, subject, body: textBody, resolved: Boolean(lead) }),
      ]
    );

    if (message) {
      await query(`UPDATE messages SET status = 'bounced' WHERE id = $1`, [message.id]);
    }
    if (lead) {
      await query(`UPDATE leads SET status = 'bounced', updated_at = now() WHERE id = $1`, [lead.id]);
    }

    // Suppression is what actually stops future sends (checked by
    // /agent/run before every send) — add it even if we only recovered an
    // email guess and never matched a lead row, so a bounce for an address
    // that isn't in `leads` yet still can't get emailed later.
    const suppressEmail = lead?.email ?? guessedEmail;
    let suppressed = false;
    if (suppressEmail) {
      await query(
        `INSERT INTO suppression (email, reason) VALUES ($1, 'hard_bounce') ON CONFLICT (email) DO NOTHING`,
        [suppressEmail]
      );
      suppressed = true;
    }

    return res.status(201).json({
      type: 'bounce',
      resolved: Boolean(lead),
      event: event.rows[0],
      message_id: message?.id ?? null,
      lead_id: lead?.id ?? null,
      suppressed_email: suppressEmail ?? null,
      suppressed,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// POST /webhook/inbound
// Called by n8n whenever anything lands in the monitored (sending) inbox —
// a genuine reply, or a bounce/DSN notification (bounces come back to the
// sender, i.e. this same inbox). Detects which case it is via
// looksLikeBounce() and branches accordingly; see handleBounce() above.
// Accepts either:
//   { raw: "<full .eml source>" }                     -- parsed with mailparser
//   { from, subject, text, html, in_reply_to, references, message_id }
// Requires header `x-webhook-secret` to match WEBHOOK_SECRET when set.
router.post('/webhook/inbound', async (req, res) => {
  if (process.env.WEBHOOK_SECRET) {
    if (req.get('x-webhook-secret') !== process.env.WEBHOOK_SECRET) {
      return res.status(401).json({ error: 'invalid webhook secret' });
    }
  }

  try {
    let fromEmail, subject, textBody, inReplyTo, references, parsedMail;

    if (req.body?.raw) {
      parsedMail = await simpleParser(req.body.raw);
      fromEmail = extractEmail(parsedMail.from);
      subject = parsedMail.subject ?? '';
      textBody = parsedMail.text ?? parsedMail.html ?? '';
      inReplyTo = parsedMail.inReplyTo ?? null;
      references = Array.isArray(parsedMail.references) ? parsedMail.references : (parsedMail.references ? [parsedMail.references] : []);
    } else {
      const b = req.body || {};
      fromEmail = extractEmail(b.from);
      subject = b.subject ?? '';
      textBody = b.text ?? b.body ?? b.html ?? '';
      inReplyTo = b.in_reply_to ?? b.message_id ?? null;
      references = b.references ? (Array.isArray(b.references) ? b.references : [b.references]) : [];
    }

    if (!fromEmail) {
      return res.status(400).json({ error: 'could not determine sender email' });
    }

    // Bounce/DSN notifications land in the same monitored inbox as real
    // replies, so this has to branch before the reply-handling path below —
    // otherwise a bounce gets run through sentiment classification like a
    // genuine human reply, corrupting events with junk sentiment and (worse)
    // marking the dead lead as needing a human follow-up instead of
    // suppressing it.
    if (looksLikeBounce({ fromEmail, subject })) {
      return handleBounce({ res, parsedMail, subject, textBody, fromEmail });
    }

    // Try to find the outbound message this is a reply to, by thread/message id.
    const candidateIds = [inReplyTo, ...references].filter(Boolean);
    let message = null;

    if (candidateIds.length) {
      const { rows } = await query(
        `SELECT * FROM messages WHERE message_id = ANY($1::text[]) OR thread_id = ANY($1::text[])
         ORDER BY sent_at DESC NULLS LAST LIMIT 1`,
        [candidateIds]
      );
      message = rows[0] ?? null;
    }

    // Fall back to matching by lead email (most recent sent message to this lead).
    let lead = null;
    if (message) {
      const { rows } = await query(`SELECT * FROM leads WHERE id = $1`, [message.lead_id]);
      lead = rows[0] ?? null;
    } else {
      const { rows } = await query(`SELECT * FROM leads WHERE email = $1`, [fromEmail]);
      lead = rows[0] ?? null;
      if (lead) {
        const msgRows = await query(
          `SELECT * FROM messages WHERE lead_id = $1 ORDER BY sent_at DESC NULLS LAST LIMIT 1`,
          [lead.id]
        );
        message = msgRows.rows[0] ?? null;
      }
    }

    const { sentiment, method } = await classifySentiment({ subject, body: textBody });

    const event = await query(
      `INSERT INTO events (message_id, lead_id, type, sentiment, raw, occurred_at)
       VALUES ($1,$2,'reply',$3,$4, now())
       RETURNING *`,
      [
        message?.id ?? null,
        lead?.id ?? null,
        sentiment,
        JSON.stringify({ from: fromEmail, subject, body: textBody, classified_by: method }),
      ]
    );

    if (message) {
      await query(`UPDATE messages SET status = 'replied' WHERE id = $1`, [message.id]);
    }

    // Any reply, regardless of sentiment, hands the lead to a human and
    // permanently excludes it from /agent/run's follow-up selection (that
    // query checks for the presence of a reply event on the lead).
    if (lead) {
      await query(
        `UPDATE leads SET status = 'needs_human_reply', updated_at = now() WHERE id = $1`,
        [lead.id]
      );
    }

    let suppressed = false;
    if (sentiment === 'unsubscribe') {
      await query(
        `INSERT INTO suppression (email, reason) VALUES ($1, 'unsubscribe_reply')
         ON CONFLICT (email) DO NOTHING`,
        [fromEmail]
      );
      suppressed = true;
    }

    res.status(201).json({ event: event.rows[0], sentiment, lead_id: lead?.id ?? null, message_id: message?.id ?? null, suppressed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
