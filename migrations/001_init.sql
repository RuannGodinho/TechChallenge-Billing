CREATE TABLE IF NOT EXISTS estimates (
 id uuid PRIMARY KEY, order_id text NOT NULL, version integer NOT NULL,
 request_hash text NOT NULL, status text NOT NULL CHECK (status IN ('PENDING','APPROVED','REJECTED','EXPIRED')),
 total_cents bigint NOT NULL CHECK(total_cents >= 0), items jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
 decision_at timestamptz, UNIQUE(order_id, version), UNIQUE(order_id, request_hash)
);
CREATE TABLE IF NOT EXISTS outbox (
 id uuid PRIMARY KEY, aggregate_id uuid NOT NULL REFERENCES estimates(id),
 kind text NOT NULL, payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 published_at timestamptz, attempts integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS estimates_order_version ON estimates(order_id,version DESC);
CREATE INDEX IF NOT EXISTS outbox_pending ON outbox(created_at) WHERE published_at IS NULL;
