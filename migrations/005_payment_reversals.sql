ALTER TABLE payment_attempts DROP CONSTRAINT IF EXISTS payment_attempts_status_check;
ALTER TABLE payment_attempts ADD CONSTRAINT payment_attempts_status_check CHECK (status IN ('CREATING','PENDING','PAID','FAILED','CANCELLED','REVERSED'));
DROP INDEX IF EXISTS one_open_payment_per_order;
CREATE UNIQUE INDEX one_open_payment_per_order ON payment_attempts(order_id) WHERE status IN ('CREATING','PENDING','PAID','REVERSED');
