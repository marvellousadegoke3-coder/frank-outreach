import { Router } from 'express';
import { query } from '../lib/db.js';
import { verifyEmail } from '../lib/verify.js';

const router = Router();

// POST /verify { email, lead_id? } - MX check w/ optional Reoon fallback.
// If lead_id (or a matching lead by email) exists, persists verified/catch_all.
router.post('/verify', async (req, res) => {
  const { email, lead_id } = req.body || {};
  if (!email) return res.status(400).json({ error: 'email is required' });

  try {
    const result = await verifyEmail(email);

    if (lead_id) {
      await query(
        `UPDATE leads SET verified = $1, catch_all = $2, updated_at = now() WHERE id = $3`,
        [result.verified, result.catchAll, lead_id]
      );
    } else {
      await query(
        `UPDATE leads SET verified = $1, catch_all = $2, updated_at = now() WHERE email = $3`,
        [result.verified, result.catchAll, email]
      );
    }

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
