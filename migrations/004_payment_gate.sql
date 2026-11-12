CREATE TABLE IF NOT EXISTS completed_executions (
 order_id text PRIMARY KEY,
 message_id uuid NOT NULL UNIQUE,
 estimate_id uuid NOT NULL REFERENCES estimates(id),
 completed_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS one_open_payment_per_order ON payment_attempts(order_id) WHERE status IN ('CREATING','PENDING','PAID');
