import { Router, Request, Response, NextFunction } from 'express';
import { OrcamentoController } from '../../Adapters/controllers/orcamento.controller';
import { OrcamentoRuleError } from '../../enterprise/entities/orcamento.entity';
import { apiAuth } from './api-auth';

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
    router.use((error: Error, _req: Request, res: Response, _next: NextFunction) => res.status(error instanceof OrcamentoRuleError ? (error.kind === 'invalid' ? 400 : 409) : 503).json({ error: error instanceof OrcamentoRuleError ? error.message : 'database unavailable' }));
    return router;
}
