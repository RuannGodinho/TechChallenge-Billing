import { Router, Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiAuth } from './infrastructure/http/api-auth';

type EstimateRow = { id: string; order_id: string; version: number; status: string; total_cents: string | number; items: Array<{ id: string; kind: string; nome: string; descricao: string; tipo: string | null; quantidade: number; precoCents: number }>; expires_at: Date; created_at: Date; decision_at: Date | null };
const statusToLegacy: Record<string, string> = { PENDING: 'PENDENTE', APPROVED: 'APROVADO', REJECTED: 'REPROVADO', EXPIRED: 'EXPIRADO' };
const statusToStorage = Object.fromEntries(Object.entries(statusToLegacy).map(([key, value]) => [value, key]));
export class OrcamentoError extends Error { constructor(public readonly status: number, message: string) { super(message); } }

export function presentOrcamento(row: EstimateRow) {
    const presentItem = (item: EstimateRow['items'][number]) => ({ id: item.id, nome: item.nome, descricao: item.descricao, preco: item.precoCents / 100, quantidade: item.quantidade, ...(item.kind === 'part' ? { tipo: item.tipo } : {}) });
    return { id: row.id, ordemServicoId: row.order_id, versao: row.version, status: statusToLegacy[row.status], valorTotal: Number(row.total_cents) / 100, pecas: row.items.filter(item => item.kind === 'part').map(presentItem), itensServicos: row.items.filter(item => item.kind === 'service').map(presentItem), validadeEm: row.expires_at, criadoEm: row.created_at };
}

export class OrcamentoController {
    constructor(private readonly pool: Pool) {}
    async getOrcamentosByOrdemServicoId(ordemServicoId: string) {
        const result = await this.pool.query('SELECT * FROM estimates WHERE order_id=$1 ORDER BY version DESC', [ordemServicoId]);
        return result.rows.map(presentOrcamento);
    }
    async updateOrcamento(id: string, updates: Record<string, unknown>) {
        const allowed = ['ordemServicoId', 'versao', 'status', 'valorTotal', 'validadeEm'];
        if (!updates || !Object.keys(updates).length || Object.keys(updates).some(key => !allowed.includes(key))) throw new OrcamentoError(400, 'Campos de atualização inválidos');
        if (updates.status !== undefined && (typeof updates.status !== 'string' || !statusToStorage[updates.status.trim().toUpperCase()])) throw new OrcamentoError(400, 'Status inválido. Use PENDENTE, APROVADO, REPROVADO ou EXPIRADO');
        if (updates.ordemServicoId !== undefined && (typeof updates.ordemServicoId !== 'string' || !updates.ordemServicoId.trim())) throw new OrcamentoError(400, 'Ordem de serviço inválida');
        if (updates.versao !== undefined && (!Number.isSafeInteger(updates.versao) || Number(updates.versao) <= 0)) throw new OrcamentoError(400, 'Versão inválida');
        const expires = updates.validadeEm === undefined ? undefined : new Date(String(updates.validadeEm));
        if (expires && !Number.isFinite(expires.getTime())) throw new OrcamentoError(400, 'Validade inválida');
        const total = updates.valorTotal;
        if (total !== undefined && (typeof total !== 'number' || !Number.isFinite(total) || total < 0 || !Number.isSafeInteger(Math.round(total * 100)) || Math.abs(total * 100 - Math.round(total * 100)) > 1e-6)) throw new OrcamentoError(400, 'Valor total inválido');
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            const initial = await client.query<EstimateRow>('SELECT * FROM estimates WHERE id::text=$1', [id]);
            if (!initial.rowCount) { await client.query('ROLLBACK'); return null; }
            const previousOrder = initial.rows[0].order_id;
            const targetOrder = updates.ordemServicoId === undefined ? previousOrder : String(updates.ordemServicoId).trim();
            for (const orderId of [...new Set([previousOrder, targetOrder])].sort()) await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [orderId]);
            const found = await client.query<EstimateRow>('SELECT * FROM estimates WHERE id::text=$1 FOR UPDATE', [id]);
            const row = found.rows[0];
            if (!row || row.order_id !== previousOrder) throw new OrcamentoError(409, 'Orçamento alterado; repita a operação');
            const latest = await client.query('SELECT id FROM estimates WHERE order_id=$1 ORDER BY version DESC LIMIT 1', [row.order_id]);
            if (latest.rows[0]?.id !== row.id) throw new OrcamentoError(409, 'Orçamento substituído por uma nova versão');
            const status = updates.status === undefined ? row.status : statusToStorage[String(updates.status).trim().toUpperCase()];
            const version = updates.versao === undefined ? row.version : Number(updates.versao);
            const amount = total === undefined ? Number(row.total_cents) : Math.round(Number(total) * 100);
            const expiry = expires ?? new Date(row.expires_at);
            const metadataChanged = targetOrder !== row.order_id || version !== row.version || amount !== Number(row.total_cents) || expiry.getTime() !== new Date(row.expires_at).getTime();
            const statusChanged = status !== row.status;
            if (!metadataChanged && !statusChanged) { await client.query('COMMIT'); return presentOrcamento(row); }
            const payment = await client.query("SELECT id FROM payment_attempts WHERE estimate_id=$1 AND status IN ('CREATING','PENDING','PAID','REVERSED') LIMIT 1", [id]);
            const execution = await client.query('SELECT order_id FROM completed_executions WHERE estimate_id=$1 LIMIT 1', [id]);
            if (payment.rowCount || execution.rowCount) throw new OrcamentoError(409, 'Orçamento vinculado à execução ou pagamento não pode ser alterado');
            if (row.status !== 'PENDING') throw new OrcamentoError(409, 'Somente orçamento pendente pode ser alterado');
            if (statusChanged && ['APPROVED','REJECTED'].includes(status) && (new Date(row.expires_at).getTime() <= Date.now() || expiry.getTime() <= Date.now())) throw new OrcamentoError(409, 'Orçamento expirado');
            const itemsTotal = row.items.reduce((sum, item) => sum + item.precoCents * item.quantidade, 0);
            if (amount !== itemsTotal) throw new OrcamentoError(400, 'Valor total deve corresponder aos itens do orçamento');
            const result = await client.query<EstimateRow>('UPDATE estimates SET order_id=$2,version=$3,status=$4,total_cents=$5,expires_at=$6,decision_at=CASE WHEN $7 THEN now() ELSE decision_at END WHERE id=$1 RETURNING *', [id,targetOrder,version,status,amount,expiry,statusChanged && ['APPROVED','REJECTED'].includes(status)]);
            if (targetOrder !== previousOrder) await client.query("UPDATE outbox SET payload=jsonb_set(payload,'{orderId}',to_jsonb($2::text)) WHERE aggregate_id=$1 AND published_at IS NULL", [id,targetOrder]);
            if (statusChanged && ['APPROVED','REJECTED'].includes(status)) await client.query('INSERT INTO outbox(id,aggregate_id,kind,payload) VALUES($1,$2,$3,$4)', [randomUUID(),id,`estimate.${status.toLowerCase()}`,JSON.stringify({estimateId:id,orderId:targetOrder})]);
            await client.query('COMMIT');
            return presentOrcamento(result.rows[0]);
        } catch (error) {
            await client.query('ROLLBACK');
            if (error && typeof error === 'object' && 'code' in error && error.code === '23505') throw new OrcamentoError(409, 'Versão ou conteúdo já existente para a ordem');
            throw error;
        } finally { client.release(); }
    }
}

export function createOrcamentoRoutes(controller: OrcamentoController, create?: (req: Request, res: Response, next: NextFunction) => unknown) {
    const router = Router();
    router.use(apiAuth);
    if (create) router.post('/orcamentos', create);
    router.get('/orcamentos/:ordemServicoId', async (req, res, next) => {
        try { const items = await controller.getOrcamentosByOrdemServicoId(String(req.params.ordemServicoId)); return items.length ? res.json(items) : res.status(404).json({ error: 'Orçamento não encontrado para a ordem informada' }); } catch (error) { return next(error); }
    });
    router.put('/orcamentos/:id', async (req, res, next) => {
        try { const item = await controller.updateOrcamento(String(req.params.id), req.body); return item ? res.json(item) : res.status(404).json({ error: 'Orçamento não encontrado' }); } catch (error) { return next(error); }
    });
    router.use((error: Error, _req: Request, res: Response, _next: NextFunction) => res.status(error instanceof OrcamentoError ? error.status : 503).json({ error: error instanceof OrcamentoError ? error.message : 'database unavailable' }));
    return router;
}
