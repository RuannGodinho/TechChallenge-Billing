import { EstimateItem } from './estimate.entity';
import { assessEstimateDecision } from './estimate-decision';

export type OrcamentoStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED';
export interface OrcamentoSnapshot {
    id: string;
    orderId: string;
    version: number;
    status: OrcamentoStatus;
    totalCents: number;
    items: EstimateItem[];
    expiresAt: Date;
    createdAt: Date;
    decisionAt: Date | null;
}
export type OrcamentoPatch = Partial<Pick<OrcamentoSnapshot, 'orderId' | 'version' | 'status' | 'totalCents' | 'expiresAt'>>;
export interface OrcamentoContext { latestId: string | undefined; blocked: boolean; }
export class OrcamentoRuleError extends Error {
    constructor(readonly kind: 'invalid' | 'conflict', message: string) { super(message); }
}

/** Estimate invariants are independent of HTTP, SQL and the storage schema. */
export class Orcamento {
    constructor(private readonly state: OrcamentoSnapshot) {}
    snapshot(): OrcamentoSnapshot { return { ...this.state, items: this.state.items.map(item => ({ ...item })) }; }
    revise(patch: OrcamentoPatch, context: OrcamentoContext, now: Date): { snapshot: OrcamentoSnapshot; changed: boolean; decisionChanged: boolean } {
        const current = this.state;
        if (context.latestId !== current.id) throw new OrcamentoRuleError('conflict', 'Orçamento substituído por uma nova versão');
        const next = { ...current, ...patch };
        if (!next.orderId.trim()) throw new OrcamentoRuleError('invalid', 'Ordem de serviço inválida');
        if (!Number.isSafeInteger(next.version) || next.version <= 0) throw new OrcamentoRuleError('invalid', 'Versão inválida');
        if (!(next.expiresAt instanceof Date) || !Number.isFinite(next.expiresAt.getTime())) throw new OrcamentoRuleError('invalid', 'Validade inválida');
        if (!Number.isSafeInteger(next.totalCents) || next.totalCents < 0) throw new OrcamentoRuleError('invalid', 'Valor total inválido');
        const decisionChanged = next.status !== current.status;
        const changed = decisionChanged || next.orderId !== current.orderId || next.version !== current.version || next.totalCents !== current.totalCents || next.expiresAt.getTime() !== current.expiresAt.getTime();
        if (!changed) return { snapshot: this.snapshot(), changed: false, decisionChanged: false };
        if (context.blocked) throw new OrcamentoRuleError('conflict', 'Orçamento vinculado à execução ou pagamento não pode ser alterado');
        if (current.status !== 'PENDING') throw new OrcamentoRuleError('conflict', 'Somente orçamento pendente pode ser alterado');
        if (decisionChanged && (next.status === 'APPROVED' || next.status === 'REJECTED')) {
            const decision = assessEstimateDecision(current, context.latestId, next.status, now);
            if (decision === 'unavailable' || next.expiresAt.getTime() <= now.getTime()) throw new OrcamentoRuleError('conflict', 'Orçamento expirado');
        }
        if (next.totalCents !== current.items.reduce((sum, item) => sum + item.precoCents * item.quantidade, 0)) throw new OrcamentoRuleError('invalid', 'Valor total deve corresponder aos itens do orçamento');
        if (decisionChanged && (next.status === 'APPROVED' || next.status === 'REJECTED')) next.decisionAt = now;
        return { snapshot: next, changed, decisionChanged: decisionChanged && (next.status === 'APPROVED' || next.status === 'REJECTED') };
    }
}
