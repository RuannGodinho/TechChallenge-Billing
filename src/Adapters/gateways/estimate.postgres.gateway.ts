import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { EstimateGatewayPort, EstimateWriteResult } from '../../application/ports/estimate-gateway.port';
import { EstimateInput } from '../../enterprise/entities/estimate.entity';
import { CheckEstimateApprovalUseCase } from '../../application/usecases/check-estimate-approval.usecase';
import { DecideEstimateUseCase, EstimateDecision } from '../../application/usecases/decide-estimate.usecase';

export class EstimatePostgresGateway implements EstimateGatewayPort {
    constructor(private readonly pool: Pool) {}

    async create(input: EstimateInput, hash: string): Promise<EstimateWriteResult> {
        const client = await this.pool.connect().catch(() => null);
        if (!client) return { kind: 'unavailable' };
        try {
            await client.query('BEGIN');
            await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [input.orderId]);
            const existing = await client.query('SELECT * FROM estimates WHERE order_id=$1 AND request_hash=$2', [input.orderId, hash]);
            if (existing.rowCount) {
                await client.query('COMMIT');
                return { kind: 'ok', data: existing.rows[0], created: false };
            }
            const previous = await client.query('SELECT COALESCE(MAX(version),0)::int AS version FROM estimates WHERE order_id=$1', [input.orderId]);
            const id = randomUUID();
            const result = await client.query("INSERT INTO estimates(id,order_id,version,request_hash,status,total_cents,items,expires_at) VALUES($1,$2,$3,$4,'PENDING',$5,$6,now()+interval '7 days') RETURNING *", [id, input.orderId, previous.rows[0].version + 1, hash, input.total, JSON.stringify(input.items)]);
            await client.query('INSERT INTO outbox(id,aggregate_id,kind,payload) VALUES($1,$2,$3,$4)', [randomUUID(), id, 'estimate.created', JSON.stringify({ estimateId: id, orderId: input.orderId })]);
            await client.query('COMMIT');
            return { kind: 'ok', data: result.rows[0], created: true };
        } catch (error) {
            await client.query('ROLLBACK');
            console.error('estimate creation failed', error);
            return { kind: 'error' };
        } finally {
            client.release();
        }
    }

    async isApproved(orderId: string): Promise<boolean> {
        const result = await this.pool.query('SELECT status,expires_at FROM estimates WHERE order_id=$1 ORDER BY version DESC LIMIT 1', [orderId]);
        return new CheckEstimateApprovalUseCase().execute(result.rows[0]);
    }

    async decide(id: string, decision: EstimateDecision): Promise<EstimateWriteResult> {
        const client = await this.pool.connect().catch(() => null);
        if (!client) return { kind: 'unavailable' };
        try {
            await client.query('BEGIN');
            const found = await client.query('SELECT * FROM estimates WHERE id::text=$1 FOR UPDATE', [id]);
            if (!found.rowCount) { await client.query('ROLLBACK'); return { kind: 'not_found' }; }
            const row = found.rows[0];
            await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [row.order_id]);
            const latest = await client.query('SELECT id FROM estimates WHERE order_id=$1 ORDER BY version DESC LIMIT 1', [row.order_id]);
            const result = new DecideEstimateUseCase().execute({ id: row.id, status: row.status, expiresAt: new Date(row.expires_at) }, latest.rows[0]?.id, decision, new Date());
            if (result === 'superseded') { await client.query('ROLLBACK'); return { kind: 'superseded' }; }
            if (result === 'unchanged') { await client.query('COMMIT'); return { kind: 'ok', data: row }; }
            if (result === 'unavailable') { await client.query('ROLLBACK'); return { kind: 'cannot_decide' }; }
            const updated = await client.query('UPDATE estimates SET status=$2,decision_at=now() WHERE id=$1 RETURNING *', [row.id, decision]);
            await client.query('INSERT INTO outbox(id,aggregate_id,kind,payload) VALUES($1,$2,$3,$4)', [randomUUID(), row.id, `estimate.${decision.toLowerCase()}`, JSON.stringify({ estimateId: row.id, orderId: row.order_id })]);
            await client.query('COMMIT');
            return { kind: 'ok', data: updated.rows[0] };
        } catch (error) {
            await client.query('ROLLBACK');
            console.error('decision failed', error);
            return { kind: 'error' };
        } finally {
            client.release();
        }
    }
}
