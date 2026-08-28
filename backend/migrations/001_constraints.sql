-- Run once against your existing Railway Postgres DB.
-- Adds the unique constraints the API's upsert logic depends on.
-- Safe to re-run (guarded with IF NOT EXISTS checks).

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'leads_email_key'
  ) THEN
    ALTER TABLE leads ADD CONSTRAINT leads_email_key UNIQUE (email);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'suppression_email_key'
  ) THEN
    ALTER TABLE suppression ADD CONSTRAINT suppression_email_key UNIQUE (email);
  END IF;
END $$;

-- Helpful indexes for the dashboard's aggregate queries.
CREATE INDEX IF NOT EXISTS idx_messages_campaign_id ON messages (campaign_id);
CREATE INDEX IF NOT EXISTS idx_messages_status ON messages (status);
CREATE INDEX IF NOT EXISTS idx_events_type ON events (type);
CREATE INDEX IF NOT EXISTS idx_events_message_id ON events (message_id);
CREATE INDEX IF NOT EXISTS idx_leads_niche ON leads (niche);
