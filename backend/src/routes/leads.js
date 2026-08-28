import { Router } from 'express';
import { query } from '../lib/db.js';

const router = Router();

const LEAD_FIELDS = [
  'email', 'first_name', 'last_name', 'title', 'company', 'domain', 'niche',
  'city', 'country', 'source', 'signal', 'verified', 'catch_all',
  'status', 'enrichment',
];

// POST /leads - upsert on email
router.post('/leads', async (req, res) => {
  const body = req.body || {};
  if (!body.email) {
    return res.status(400).json({ error: 'email is required' });
  }

  const values = LEAD_FIELDS.map((f) => (f === 'enrichment' ? JSON.stringify(body.enrichment ?? {}) : body[f] ?? null));

  const setClause = LEAD_FIELDS.filter((f) => f !== 'email')
    .map((f) => `${f} = COALESCE(EXCLUDED.${f}, leads.${f})`)
    .join(', ');

  const sql = `
    INSERT INTO leads (${LEAD_FIELDS.join(', ')})
    VALUES (${LEAD_FIELDS.map((_, i) => `$${i + 1}`).join(', ')})
    ON CONFLICT (email) DO UPDATE SET ${setClause}, updated_at = now()
    RETURNING *
  `;

  try {
    const { rows } = await query(sql, values);
    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /leads?niche=&status=&limit=&offset=
router.get('/leads', async (req, res) => {
  const { niche, status, limit = 100, offset = 0 } = req.query;
  const conditions = [];
  const params = [];

  if (niche) {
    params.push(niche);
    conditions.push(`niche = $${params.length}`);
  }
  if (status) {
    params.push(status);
    conditions.push(`status = $${params.length}`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  params.push(Number(limit), Number(offset));

  const sql = `
    SELECT * FROM leads
    ${where}
    ORDER BY created_at DESC
    LIMIT $${params.length - 1} OFFSET $${params.length}
  `;

  try {
    const { rows } = await query(sql, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /leads/:id/status
router.patch('/leads/:id/status', async (req, res) => {
  const { status } = req.body || {};
  if (!status) return res.status(400).json({ error: 'status is required' });

  try {
    const { rows } = await query(
      `UPDATE leads SET status = $1, updated_at = now() WHERE id = $2 RETURNING *`,
      [status, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'lead not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
