import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { PrepareEstimateUseCase } from '../../application/usecases/prepare-estimate.usecase';
import { SagaMessage } from '../../infrastructure/messaging/saga';
import { EventOutbox } from '../../application/ports/integration-event';
export class SagaPostgresGateway implements EventOutbox {
    private readonly owner = randomUUID();
    constructor(private readonly pool: Pool) { }
    async execute(m: SagaMessage) {
        const c = await this.pool.connect();
        try {
            await c.query('BEGIN');
            await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [m.orderId]);
            const previous = await c.query('SELECT result FROM saga_inbox WHERE command_id=$1', [m.data.commandId]);
            if (previous.rowCount) {
                await c.query('COMMIT');
                return;
            }
            await c.query('INSERT INTO saga_participations(saga_id,order_id,attempt) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [m.data.sagaId, m.orderId, m.data.attempt]);
            const p = (await c.query('SELECT * FROM saga_participations WHERE saga_id=$1 FOR UPDATE', [m.data.sagaId])).rows[0];
            if (p.order_id !== m.orderId || p.attempt !== m.data.attempt)
                throw Error('Saga identity mismatch');
            let data: any = { ...m.data, ok: true };
            if (m.eventType === 'billing.CancelarOrcamento') {
                await c.query('UPDATE saga_participations SET cancelled=true WHERE saga_id=$1', [m.data.sagaId]);
                await c.query("UPDATE estimates SET status='CANCELLED' WHERE id=$1 AND status IN ('PENDING','APPROVED')", [p.estimate_id]);
            }
            else if (p.cancelled) {
                data = { ...data, ok: false, error: 'Tentativa cancelada' };
            }
            else if (!p.estimate_id) {
                try {
                    const { input, hash } = new PrepareEstimateUseCase().execute(m.data.snapshot);
                    if (input.orderId !== m.orderId)
                        throw Error('Order mismatch');
                    const id = randomUUID();
                    const version = (await c.query('SELECT COALESCE(MAX(version),0)::int+1 AS v FROM estimates WHERE order_id=$1', [m.orderId])).rows[0].v;
                    // Saga identity distinguishes a legitimate new attempt with identical items.
                    const result = await c.query("INSERT INTO estimates(id,order_id,version,request_hash,status,total_cents,items,expires_at) VALUES($1,$2,$3,$4,'PENDING',$5,$6,now()+interval '7 days') RETURNING *", [id, m.orderId, version, `${hash}:${m.data.sagaId}`, input.total, JSON.stringify(input.items)]);
                    await c.query('UPDATE saga_participations SET estimate_id=$2 WHERE saga_id=$1', [m.data.sagaId, id]);
                    await c.query('INSERT INTO outbox(id,aggregate_id,kind,payload) VALUES($1,$2,$3,$4)', [randomUUID(), id, 'estimate.created', JSON.stringify({ estimateId: id, orderId: m.orderId })]);
                    data = { ...data, estimateId: id, estimateVersion: version, expiresAt: result.rows[0].expires_at.toISOString() };
                }
                catch (e) {
                    if (e instanceof Error && !('code' in e))
                        data = { ...data, ok: false, error: e.message };
                    else
                        throw e;
                }
            }
            else {
                const row = (await c.query('SELECT * FROM estimates WHERE id=$1', [p.estimate_id])).rows[0];
                data = { ...data, estimateId: row.id, estimateVersion: row.version, expiresAt: row.expires_at.toISOString() };
            }
            delete data.snapshot;
            const id = randomUUID();
            const event = { messageId: id, eventType: 'saga.result', eventVersion: 1, orderId: m.orderId, occurredAt: new Date().toISOString(), data };
            await c.query('INSERT INTO saga_inbox VALUES($1,$2)', [m.data.commandId, event]);
            await c.query('INSERT INTO saga_outbox(id,event) VALUES($1,$2)', [id, event]);
            await c.query('COMMIT');
        }
        catch (e) {
            await c.query('ROLLBACK');
            throw e;
        }
        finally {
            c.release();
        }
    }
    async expire() { await this.pool.query("UPDATE estimates SET status='EXPIRED' WHERE status='PENDING' AND expires_at<=now() AND id IN (SELECT estimate_id FROM saga_participations WHERE NOT cancelled)"); }
    async claim() { const r = await this.pool.query(`WITH a AS(SELECT id FROM saga_outbox WHERE published_at IS NULL AND next_attempt_at<=now() AND (lease_until IS NULL OR lease_until<now()) ORDER BY next_attempt_at FOR UPDATE SKIP LOCKED LIMIT 1) UPDATE saga_outbox o SET owner=$1,lease_until=now()+interval '30 seconds',attempts=o.attempts+1 FROM a WHERE o.id=a.id RETURNING o.*`, [this.owner]); return r.rows[0] ? { id: r.rows[0].id, event: r.rows[0].event } : null; }
    async markPublished(id: string) { await this.pool.query('UPDATE saga_outbox SET published_at=now(),lease_until=NULL WHERE id=$1 AND owner=$2', [id, this.owner]); }
    async markFailed(id: string, error: string) { await this.pool.query("UPDATE saga_outbox SET lease_until=NULL,next_attempt_at=now()+LEAST(60,power(2,LEAST(attempts,6)))*interval '1 second',last_error=$3 WHERE id=$1 AND owner=$2", [id, this.owner, error.slice(0, 1000)]); }
}
