import { OrcamentoSnapshot, OrcamentoStatus } from '../../../enterprise/entities/orcamento.entity';
import { EstimateItem } from '../../../enterprise/entities/estimate.entity';
export interface OrcamentoRow {
    id: string; order_id: string; version: number; status: OrcamentoStatus;
    total_cents: string | number; items: EstimateItem[];
    expires_at: Date; created_at: Date; decision_at: Date | null;
}
export function mapOrcamento(row: OrcamentoRow): OrcamentoSnapshot {
    return { id: row.id, orderId: row.order_id, version: row.version, status: row.status, totalCents: Number(row.total_cents), items: row.items, expiresAt: row.expires_at, createdAt: row.created_at, decisionAt: row.decision_at };
}
