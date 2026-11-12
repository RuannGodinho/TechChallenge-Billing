CREATE TABLE IF NOT EXISTS payment_attempts (
 id uuid PRIMARY KEY,
 order_id text NOT NULL,
 estimate_id uuid NOT NULL REFERENCES estimates(id),
 idempotency_key uuid NOT NULL UNIQUE,
 amount_cents bigint NOT NULL CHECK (amount_cents > 0),
 currency char(3) NOT NULL DEFAULT 'BRL' CHECK (currency = 'BRL'),
 status text NOT NULL CHECK (status IN ('CREATING','PENDING','PAID','FAILED','CANCELLED')),
 provider_order_id text UNIQUE,
 checkout_url text,
 provider_status text,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payment_attempts_order_idx ON payment_attempts(order_id, created_at DESC);
CREATE TABLE IF NOT EXISTS processed_notifications (
 notification_id text PRIMARY KEY,
 provider_order_id text NOT NULL,
 processed_at timestamptz NOT NULL DEFAULT now()
);
