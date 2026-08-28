-- Run once against the existing Railway Postgres DB.
-- Adds the `title` column /leads/source populates from Hunter when available
-- (left null when we can't confirm seniority, per spec: never claim a false
-- title in the drafting copy).

ALTER TABLE leads ADD COLUMN IF NOT EXISTS title text;
