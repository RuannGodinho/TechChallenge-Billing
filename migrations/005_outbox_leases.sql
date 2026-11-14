ALTER TABLE outbox ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS lease_until timestamptz;
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS lease_owner uuid;
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS last_error text;
CREATE INDEX IF NOT EXISTS outbox_available ON outbox(next_attempt_at,created_at) WHERE published_at IS NULL;
