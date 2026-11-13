import { AtualizarOrcamentoUseCase } from '../../application/usecases/atualizar-orcamento.usecase';
import { ListarOrcamentosPorOrdemUseCase } from '../../application/usecases/listar-orcamentos-por-ordem.usecase';
import { presentOrcamento } from '../presenters/orcamento.presenter';

export class OrcamentoController {
    constructor(private readonly list: Pick<ListarOrcamentosPorOrdemUseCase, 'execute'>, private readonly update: Pick<AtualizarOrcamentoUseCase, 'execute'>) {}
    async getOrcamentosByOrdemServicoId(orderId: string) { return (await this.list.execute(orderId)).map(presentOrcamento); }
    async updateOrcamento(id: string, input: unknown) {
        const result = await this.update.execute(id, input);
        return result ? presentOrcamento(result) : null;
    }
}
