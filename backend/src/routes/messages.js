import { Router } from 'express';
import { query } from '../lib/db.js';

const router = Router();

// POST /messages - create a scheduled/sent message record
router.post('/messages', async (req, res) => {
  const {
    lead_id, campaign_id, step, subject, body,
    inbox_used, message_id, thread_id, scheduled_at, status,
  } = req.body || {};

  if (!lead_id || !campaign_id) {
    return res.status(400).json({ error: 'lead_id and campaign_id are required' });
  }

  try {
    const { rows } = await query(
      `INSERT INTO messages
        (lead_id, campaign_id, step, subject, body, inbox_used, message_id, thread_id, scheduled_at, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,COALESCE($10,'scheduled'))
       RETURNING *`,
      [lead_id, campaign_id, step ?? null, subject ?? null, body ?? null,
        inbox_used ?? null, message_id ?? null, thread_id ?? null,
        scheduled_at ?? null, status ?? null]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /messages/:id/sent - mark sent, optionally set provider message_id/thread_id
router.patch('/messages/:id/sent', async (req, res) => {
  const { message_id, thread_id, sent_at } = req.body || {};

  try {
    const { rows } = await query(
      `UPDATE messages
       SET status = 'sent',
           sent_at = COALESCE($1, now()),
           message_id = COALESCE($2, message_id),
           thread_id = COALESCE($3, thread_id)
       WHERE id = $4
       RETURNING *`,
      [sent_at ?? null, message_id ?? null, thread_id ?? null, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'message not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /messages/:id/bounced - mark bounced and log a bounce event
router.patch('/messages/:id/bounced', async (req, res) => {
  const { reason } = req.body || {};

  try {
    const { rows } = await query(
      `UPDATE messages SET status = 'bounced' WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'message not found' });

    const message = rows[0];
    await query(
      `INSERT INTO events (message_id, lead_id, type, raw, occurred_at)
       VALUES ($1, $2, 'bounced', $3, now())`,
      [message.id, message.lead_id, JSON.stringify({ reason: reason ?? null })]
    );

    res.json(message);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
