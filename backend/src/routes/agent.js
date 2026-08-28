import { Router } from 'express';
import { query } from '../lib/db.js';
import { draftMessage } from '../lib/draftCopy.js';
import { sendMail } from '../lib/gmail.js';

const router = Router();

const FIVE_DAYS_MS = 5 * 24 * 60 * 60 * 1000;

// Candidate leads: not suppressed, never replied, and due for either the
// initial send (step 1), follow-up 1 (step 1 sent 2+ days ago, no step 2
// yet), or follow-up 2 (step 1 sent 5+ days ago, no step 3 yet).
const CANDIDATES_SQL = `
  WITH lead_msg AS (
    SELECT
      lead_id,
      MAX(sent_at) FILTER (WHERE step = 1) AS step1_sent_at,
      bool_or(step = 2) AS has_step2,
      bool_or(step = 3) AS has_step3
    FROM messages
    GROUP BY lead_id
  ),
  lead_reply AS (
    SELECT DISTINCT lead_id FROM events WHERE type = 'reply' AND lead_id IS NOT NULL
  )
  SELECT
    l.*,
    lm.step1_sent_at,
    COALESCE(lm.has_step2, false) AS has_step2,
    COALESCE(lm.has_step3, false) AS has_step3
  FROM leads l
  LEFT JOIN lead_msg lm ON lm.lead_id = l.id
  LEFT JOIN lead_reply lr ON lr.lead_id = l.id
  WHERE l.status IS DISTINCT FROM 'suppressed'
    AND lr.lead_id IS NULL
    AND (
      lm.step1_sent_at IS NULL
      OR (lm.step1_sent_at <= now() - interval '5 days' AND NOT COALESCE(lm.has_step3, false))
      OR (lm.step1_sent_at <= now() - interval '2 days' AND NOT COALESCE(lm.has_step2, false))
    )
`;

function pickStep(lead) {
  if (!lead.step1_sent_at) return 1;
  if (new Date(lead.step1_sent_at).getTime() <= Date.now() - FIVE_DAYS_MS && !lead.has_step3) return 3;
  return 2;
}

// POST /agent/run — the single endpoint n8n's daily cron calls. Selects due
// leads, checks suppression, drafts copy, sends via the Gmail API (or logs a
// stub if Google OAuth env vars aren't configured yet), and logs the
// message + a 'sent' event.
router.post('/agent/run', async (req, res) => {
  if (process.env.WEBHOOK_SECRET) {
    if (req.get('x-webhook-secret') !== process.env.WEBHOOK_SECRET) {
      return res.status(401).json({ error: 'invalid webhook secret' });
    }
  }

  const summary = {
    processed: 0,
    sent: 0,
    skipped_suppressed: 0,
    skipped_no_campaign: 0,
    skipped_daily_limit: 0,
    errors: [],
  };

  try {
    const { rows: candidates } = await query(CANDIDATES_SQL);

    for (const lead of candidates) {
      summary.processed++;
      try {
        const step = pickStep(lead);
        if ((step === 2 && lead.has_step2) || (step === 3 && lead.has_step3)) continue;

        const { rows: supRows } = await query(
          `SELECT 1 FROM suppression WHERE email = $1 LIMIT 1`,
          [lead.email]
        );
        if (supRows.length) {
          summary.skipped_suppressed++;
          continue;
        }

        const { rows: campaignRows } = await query(
          `SELECT * FROM campaigns WHERE niche = $1 AND status = 'active' ORDER BY created_at LIMIT 1`,
          [lead.niche]
        );
        const campaign = campaignRows[0];
        if (!campaign) {
          summary.skipped_no_campaign++;
          continue;
        }

        if (campaign.daily_send_limit) {
          const { rows: countRows } = await query(
            `SELECT count(*)::int AS c FROM messages
             WHERE campaign_id = $1 AND sent_at >= date_trunc('day', now())`,
            [campaign.id]
          );
          if (countRows[0].c >= campaign.daily_send_limit) {
            summary.skipped_daily_limit++;
            continue;
          }
        }

        // For follow-ups, thread off the immediately prior message: its
        // RFC822 Message-ID drives In-Reply-To/References, and its Gmail
        // threadId keeps the new send in the same Gmail conversation.
        let prevMessage = null;
        if (step > 1) {
          const { rows: prevRows } = await query(
            `SELECT message_id, thread_id FROM messages
             WHERE lead_id = $1 ORDER BY sent_at DESC NULLS LAST LIMIT 1`,
            [lead.id]
          );
          prevMessage = prevRows[0] ?? null;
        }

        const draft = await draftMessage({ step, lead });
        const fromAddress = campaign.from_inbox || process.env.GOOGLE_SEND_AS || 'noreply@example.com';

        const mailResult = await sendMail({
          from: fromAddress,
          to: lead.email,
          subject: draft.subject,
          text: draft.body,
          inReplyTo: prevMessage?.message_id ?? undefined,
          references: prevMessage?.message_id ?? undefined,
          threadId: prevMessage?.thread_id ?? undefined,
        });

        const { rows: msgRows } = await query(
          `INSERT INTO messages
            (lead_id, campaign_id, step, subject, body, inbox_used, message_id, thread_id, sent_at, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now(), 'sent')
           RETURNING *`,
          [lead.id, campaign.id, step, draft.subject, draft.body, fromAddress, mailResult.messageId, mailResult.threadId]
        );
        const message = msgRows[0];

        await query(
          `INSERT INTO events (message_id, lead_id, type, raw, occurred_at)
           VALUES ($1,$2,'sent',$3, now())`,
          [message.id, lead.id, JSON.stringify({ step, stubbed: mailResult.stubbed })]
        );

        summary.sent++;
      } catch (err) {
        summary.errors.push({ lead_id: lead.id, error: err.message });
      }
    }

    res.json(summary);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
