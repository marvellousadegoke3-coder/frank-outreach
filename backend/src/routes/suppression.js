import { Router } from 'express';
import { query } from '../lib/db.js';

const router = Router();

// GET /suppression/check?email=
router.get('/suppression/check', async (req, res) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: 'email query param is required' });

  try {
    const { rows } = await query(`SELECT * FROM suppression WHERE email = $1 LIMIT 1`, [email]);
    res.json({ suppressed: rows.length > 0, record: rows[0] ?? null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /suppression
router.post('/suppression', async (req, res) => {
  const { email, reason } = req.body || {};
  if (!email) return res.status(400).json({ error: 'email is required' });

  try {
    const { rows } = await query(
      `INSERT INTO suppression (email, reason)
       VALUES ($1, $2)
       ON CONFLICT (email) DO UPDATE SET reason = EXCLUDED.reason
       RETURNING *`,
      [email, reason ?? null]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
