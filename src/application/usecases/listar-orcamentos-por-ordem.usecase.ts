import { OrcamentoRepository } from '../ports/orcamento-repository.port';
export class ListarOrcamentosPorOrdemUseCase {
    constructor(private readonly repository: OrcamentoRepository) {}
    execute(orderId: string) { return this.repository.findByOrderId(orderId); }
}
