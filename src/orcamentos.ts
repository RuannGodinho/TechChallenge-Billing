// Compatibility exports; implementations live in their respective architecture layers.
export { OrcamentoController } from './Adapters/controllers/orcamento.controller';
export { presentOrcamento } from './Adapters/presenters/orcamento.presenter';
export { createOrcamentoRoutes } from './infrastructure/http/orcamento-routes';
