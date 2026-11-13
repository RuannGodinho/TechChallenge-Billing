import { cents } from '../../enterprise/entities/estimate.entity';
import { Orcamento, OrcamentoPatch, OrcamentoRuleError, OrcamentoStatus } from '../../enterprise/entities/orcamento.entity';
import { OrcamentoRepository } from '../ports/orcamento-repository.port';

const statuses: Record<string, OrcamentoStatus> = { PENDENTE: 'PENDING', APROVADO: 'APPROVED', REPROVADO: 'REJECTED', EXPIRADO: 'EXPIRED' };
export function prepareOrcamentoUpdate(input: unknown): OrcamentoPatch {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new OrcamentoRuleError('invalid', 'Campos de atualização inválidos');
    const updates = input as Record<string, unknown>;
    const allowed = ['ordemServicoId', 'versao', 'status', 'valorTotal', 'validadeEm'];
    if (!Object.keys(updates).length || Object.keys(updates).some(key => !allowed.includes(key))) throw new OrcamentoRuleError('invalid', 'Campos de atualização inválidos');
    const patch: OrcamentoPatch = {};
    if (updates.status !== undefined) {
        if (typeof updates.status !== 'string' || !statuses[updates.status.trim().toUpperCase()]) throw new OrcamentoRuleError('invalid', 'Status inválido. Use PENDENTE, APROVADO, REPROVADO ou EXPIRADO');
        patch.status = statuses[updates.status.trim().toUpperCase()];
    }
    if (updates.ordemServicoId !== undefined) {
        if (typeof updates.ordemServicoId !== 'string' || !updates.ordemServicoId.trim()) throw new OrcamentoRuleError('invalid', 'Ordem de serviço inválida');
        patch.orderId = updates.ordemServicoId.trim();
    }
    if (updates.versao !== undefined) {
        if (!Number.isSafeInteger(updates.versao) || Number(updates.versao) <= 0) throw new OrcamentoRuleError('invalid', 'Versão inválida');
        patch.version = Number(updates.versao);
    }
    if (updates.validadeEm !== undefined) {
        patch.expiresAt = new Date(String(updates.validadeEm));
        if (!Number.isFinite(patch.expiresAt.getTime())) throw new OrcamentoRuleError('invalid', 'Validade inválida');
    }
    if (updates.valorTotal !== undefined) {
        try { patch.totalCents = cents(updates.valorTotal); }
        catch { throw new OrcamentoRuleError('invalid', 'Valor total inválido'); }
    }
    return patch;
}

export class AtualizarOrcamentoUseCase {
    constructor(private readonly repository: OrcamentoRepository, private readonly clock = () => new Date()) {}
    execute(id: string, updates: unknown) {
        const patch = prepareOrcamentoUpdate(updates);
        return this.repository.withLockedEstimate(id, patch.orderId, async unit => {
            const result = new Orcamento(unit.current).revise(patch, unit.context, this.clock());
            return result.changed ? unit.save(result.snapshot, result.decisionChanged) : result.snapshot;
        });
    }
}
