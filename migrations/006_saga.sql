ALTER TABLE estimates DROP CONSTRAINT IF EXISTS estimates_status_check;
ALTER TABLE estimates ADD CONSTRAINT estimates_status_check CHECK(status IN ('PENDING','APPROVED','REJECTED','EXPIRED','CANCELLED'));
CREATE TABLE IF NOT EXISTS saga_participations(saga_id uuid PRIMARY KEY,order_id text NOT NULL,attempt int NOT NULL,estimate_id uuid REFERENCES estimates(id),cancelled boolean NOT NULL DEFAULT false);
CREATE TABLE IF NOT EXISTS saga_inbox(command_id uuid PRIMARY KEY,result jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS saga_outbox(id uuid PRIMARY KEY,event jsonb NOT NULL,published_at timestamptz,next_attempt_at timestamptz NOT NULL DEFAULT now(),lease_until timestamptz,owner uuid,attempts int NOT NULL DEFAULT 0,last_error text);
CREATE OR REPLACE FUNCTION saga_estimate_decision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p saga_participations; mid uuid; cmd uuid;
BEGIN
 SELECT * INTO p FROM saga_participations WHERE estimate_id=NEW.id;
 IF FOUND AND NOT p.cancelled AND OLD.status<>NEW.status AND NEW.status IN ('APPROVED','REJECTED','EXPIRED') THEN
 mid:=gen_random_uuid();cmd:=gen_random_uuid();
 INSERT INTO saga_outbox(id,event) VALUES(mid,jsonb_build_object('messageId',mid,'eventType','saga.result','eventVersion',1,'orderId',p.order_id,'occurredAt',now(),'data',jsonb_build_object('sagaId',p.saga_id,'attempt',p.attempt,'commandId',cmd,'commandType','billing.CriarOrcamento','ok',true,'decision',NEW.status,'estimateId',NEW.id,'estimateVersion',NEW.version,'expiresAt',NEW.expires_at)));
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS saga_estimate_decision ON estimates;
CREATE TRIGGER saga_estimate_decision AFTER UPDATE ON estimates FOR EACH ROW EXECUTE FUNCTION saga_estimate_decision();
CREATE OR REPLACE FUNCTION saga_estimate_freeze() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM saga_participations WHERE estimate_id=OLD.id) AND
 (NEW.order_id,NEW.version,NEW.total_cents,NEW.items,NEW.expires_at) IS DISTINCT FROM
 (OLD.order_id,OLD.version,OLD.total_cents,OLD.items,OLD.expires_at) THEN
 RAISE EXCEPTION 'Orçamento da Saga não pode ser alterado' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS saga_estimate_freeze ON estimates;
CREATE TRIGGER saga_estimate_freeze BEFORE UPDATE ON estimates FOR EACH ROW EXECUTE FUNCTION saga_estimate_freeze();
CREATE OR REPLACE FUNCTION saga_estimate_exclusive() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM saga_participations WHERE order_id=NEW.order_id AND NOT cancelled AND estimate_id IS NOT NULL) THEN
 RAISE EXCEPTION 'Ordem com orçamento gerenciado pela Saga' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS saga_estimate_exclusive ON estimates;
CREATE TRIGGER saga_estimate_exclusive BEFORE INSERT ON estimates FOR EACH ROW EXECUTE FUNCTION saga_estimate_exclusive();
