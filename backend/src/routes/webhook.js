import { Router } from 'express';
import { simpleParser } from 'mailparser';
import { query } from '../lib/db.js';
import { classifySentiment } from '../lib/sentiment.js';

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

// POST /webhook/inbound
// Called by n8n whenever a reply lands in a monitored inbox. Accepts either:
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
    let fromEmail, subject, textBody, inReplyTo, references;

    if (req.body?.raw) {
      const parsed = await simpleParser(req.body.raw);
      fromEmail = extractEmail(parsed.from);
      subject = parsed.subject ?? '';
      textBody = parsed.text ?? parsed.html ?? '';
      inReplyTo = parsed.inReplyTo ?? null;
      references = Array.isArray(parsed.references) ? parsed.references : (parsed.references ? [parsed.references] : []);
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
