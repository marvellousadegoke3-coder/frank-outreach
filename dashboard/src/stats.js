import { query } from './db.js';

// Per-message rollup: for each message, was it sent/bounced, and did it get
// a delivered/reply/positive-reply/meeting-booked event. Computed once as a
// CTE so joining events (which can be many-per-message) never double-counts.
const MSG_STATS_CTE = `
  WITH msg_stats AS (
    SELECT
      m.id,
      m.campaign_id,
      m.status,
      m.sent_at,
      bool_or(e.type = 'delivered') AS delivered,
      bool_or(e.type = 'reply') AS replied,
      bool_or(e.type = 'reply' AND e.sentiment = 'positive') AS positive,
      bool_or(e.sentiment = 'meeting_booked') AS meeting
    FROM messages m
    LEFT JOIN events e ON e.message_id = m.id
    GROUP BY m.id
  )
`;

export async function getTotals() {
  const sql = `
    ${MSG_STATS_CTE}
    SELECT
      COUNT(*) FILTER (WHERE status = 'sent' OR sent_at IS NOT NULL) AS sent,
      COUNT(*) FILTER (WHERE delivered) AS delivered,
      COUNT(*) FILTER (WHERE status = 'bounced') AS bounced,
      COUNT(*) FILTER (WHERE replied) AS replied,
      COUNT(*) FILTER (WHERE positive) AS positive,
      COUNT(*) FILTER (WHERE meeting) AS meetings
    FROM msg_stats
  `;
  const { rows } = await query(sql);
  return normalizeRow(rows[0]);
}

export async function getByCampaign() {
  const sql = `
    ${MSG_STATS_CTE}
    SELECT
      c.id AS campaign_id,
      c.name AS campaign_name,
      c.niche,
      COUNT(ms.id) FILTER (WHERE ms.status = 'sent' OR ms.sent_at IS NOT NULL) AS sent,
      COUNT(ms.id) FILTER (WHERE ms.delivered) AS delivered,
      COUNT(ms.id) FILTER (WHERE ms.status = 'bounced') AS bounced,
      COUNT(ms.id) FILTER (WHERE ms.replied) AS replied,
      COUNT(ms.id) FILTER (WHERE ms.positive) AS positive,
      COUNT(ms.id) FILTER (WHERE ms.meeting) AS meetings
    FROM campaigns c
    LEFT JOIN msg_stats ms ON ms.campaign_id = c.id
    GROUP BY c.id, c.name, c.niche
    ORDER BY c.name
  `;
  const { rows } = await query(sql);
  return rows.map(normalizeRow);
}

export async function getByNiche() {
  const sql = `
    ${MSG_STATS_CTE}
    SELECT
      COALESCE(c.niche, 'unknown') AS niche,
      COUNT(ms.id) FILTER (WHERE ms.status = 'sent' OR ms.sent_at IS NOT NULL) AS sent,
      COUNT(ms.id) FILTER (WHERE ms.delivered) AS delivered,
      COUNT(ms.id) FILTER (WHERE ms.status = 'bounced') AS bounced,
      COUNT(ms.id) FILTER (WHERE ms.replied) AS replied,
      COUNT(ms.id) FILTER (WHERE ms.positive) AS positive,
      COUNT(ms.id) FILTER (WHERE ms.meeting) AS meetings
    FROM campaigns c
    LEFT JOIN msg_stats ms ON ms.campaign_id = c.id
    GROUP BY c.niche
    ORDER BY niche
  `;
  const { rows } = await query(sql);
  return rows.map(normalizeRow);
}

function normalizeRow(row) {
  if (!row) return row;
  const out = { ...row };
  for (const k of ['sent', 'delivered', 'bounced', 'replied', 'positive', 'meetings']) {
    if (k in out) out[k] = Number(out[k] ?? 0);
  }
  return out;
}
