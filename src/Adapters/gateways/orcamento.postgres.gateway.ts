import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { LockedOrcamento, OrcamentoRepository } from '../../application/ports/orcamento-repository.port';
import { OrcamentoRuleError, OrcamentoSnapshot } from '../../enterprise/entities/orcamento.entity';
import { mapOrcamento, OrcamentoRow } from './mappers/orcamento.mapper';

export class OrcamentoPostgresGateway implements OrcamentoRepository {
    constructor(private readonly pool: Pool) {}
    async findByOrderId(orderId: string) {
        const result = await this.pool.query<OrcamentoRow>('SELECT * FROM estimates WHERE order_id=$1 ORDER BY version DESC', [orderId]);
        return result.rows.map(mapOrcamento);
    }
    async withLockedEstimate<T>(id: string, targetOrderId: string | undefined, operation: (unit: LockedOrcamento) => Promise<T>): Promise<T | null> {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            const initial = await client.query<OrcamentoRow>('SELECT * FROM estimates WHERE id::text=$1', [id]);
            if (!initial.rowCount) { await client.query('ROLLBACK'); return null; }
            const previousOrder = initial.rows[0].order_id;
            for (const orderId of [...new Set([previousOrder, targetOrderId ?? previousOrder])].sort()) await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [orderId]);
            const found = await client.query<OrcamentoRow>('SELECT * FROM estimates WHERE id::text=$1 FOR UPDATE', [id]);
            const row = found.rows[0];
            if (!row || row.order_id !== previousOrder) throw new OrcamentoRuleError('conflict', 'Orçamento alterado; repita a operação');
            const latest = await client.query('SELECT id FROM estimates WHERE order_id=$1 ORDER BY version DESC LIMIT 1', [row.order_id]);
            const payment = await client.query("SELECT id FROM payment_attempts WHERE estimate_id=$1 AND status IN ('CREATING','PENDING','PAID','REVERSED') LIMIT 1", [id]);
            const execution = await client.query('SELECT order_id FROM completed_executions WHERE estimate_id=$1 LIMIT 1', [id]);
            const result = await operation({
                current: mapOrcamento(row),
                context: { latestId: latest.rows[0]?.id, blocked: !!payment.rowCount || !!execution.rowCount },
                save: async (next: OrcamentoSnapshot, decisionChanged: boolean) => {
                    const saved = await client.query<OrcamentoRow>('UPDATE estimates SET order_id=$2,version=$3,status=$4,total_cents=$5,expires_at=$6,decision_at=$7 WHERE id=$1 RETURNING *', [id,next.orderId,next.version,next.status,next.totalCents,next.expiresAt,next.decisionAt]);
                    if (next.orderId !== previousOrder) await client.query("UPDATE outbox SET payload=jsonb_set(payload,'{orderId}',to_jsonb($2::text)) WHERE aggregate_id=$1 AND published_at IS NULL", [id,next.orderId]);
                    if (decisionChanged) await client.query('INSERT INTO outbox(id,aggregate_id,kind,payload) VALUES($1,$2,$3,$4)', [randomUUID(),id,`estimate.${next.status.toLowerCase()}`,JSON.stringify({estimateId:id,orderId:next.orderId})]);
                    return mapOrcamento(saved.rows[0]);
                },
            });
            await client.query('COMMIT');
            return result;
        } catch (error) {
            await client.query('ROLLBACK');
            if (error && typeof error === 'object' && 'code' in error && error.code === '23505') throw new OrcamentoRuleError('conflict', 'Versão ou conteúdo já existente para a ordem');
            throw error;
        } finally { client.release(); }
    }
}
