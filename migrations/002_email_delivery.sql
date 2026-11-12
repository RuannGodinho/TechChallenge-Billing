ALTER TABLE outbox ADD COLUMN IF NOT EXISTS email_sent_at timestamptz;
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS email_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS email_last_error text;
