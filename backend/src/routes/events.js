import { Router } from 'express';
import { query } from '../lib/db.js';

const router = Router();

// POST /events - generic event log (opened, clicked, delivered, custom types)
router.post('/events', async (req, res) => {
  const { message_id, lead_id, type, sentiment, raw, occurred_at } = req.body || {};

  if (!type) return res.status(400).json({ error: 'type is required' });

  try {
    const { rows } = await query(
      `INSERT INTO events (message_id, lead_id, type, sentiment, raw, occurred_at)
       VALUES ($1,$2,$3,$4,$5,COALESCE($6, now()))
       RETURNING *`,
      [message_id ?? null, lead_id ?? null, type, sentiment ?? null,
        JSON.stringify(raw ?? {}), occurred_at ?? null]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
