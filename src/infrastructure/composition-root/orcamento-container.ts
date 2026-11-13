import { Pool } from 'pg';
import { OrcamentoController } from '../../Adapters/controllers/orcamento.controller';
import { OrcamentoPostgresGateway } from '../../Adapters/gateways/orcamento.postgres.gateway';
import { AtualizarOrcamentoUseCase } from '../../application/usecases/atualizar-orcamento.usecase';
import { ListarOrcamentosPorOrdemUseCase } from '../../application/usecases/listar-orcamentos-por-ordem.usecase';
export function createOrcamentoController(pool: Pool) {
    const repository = new OrcamentoPostgresGateway(pool);
    return new OrcamentoController(new ListarOrcamentosPorOrdemUseCase(repository), new AtualizarOrcamentoUseCase(repository));
}
