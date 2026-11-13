import { Router } from 'express';
import { EstimateController } from '../../Adapters/controllers/estimate.controller';

export function createEstimateRoutes(controller: EstimateController): Router {
    const router = Router();
    router.post('/estimates', controller.create);
    router.get('/orders/:id/estimate-approval', controller.checkApproval);
    router.post('/estimates/:id/decision', controller.decide);
    return router;
}
