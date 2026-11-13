import { OrcamentoContext, OrcamentoSnapshot } from '../../enterprise/entities/orcamento.entity';

export interface LockedOrcamento {
    current: OrcamentoSnapshot;
    context: OrcamentoContext;
    save(snapshot: OrcamentoSnapshot, decisionChanged: boolean): Promise<OrcamentoSnapshot>;
}
export interface OrcamentoRepository {
    findByOrderId(orderId: string): Promise<OrcamentoSnapshot[]>;
    withLockedEstimate<T>(id: string, targetOrderId: string | undefined, operation: (unit: LockedOrcamento) => Promise<T>): Promise<T | null>;
}
