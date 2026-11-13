import { Request, Response } from 'express';
import { EstimateGatewayPort } from '../../application/ports/estimate-gateway.port';
import { EstimateDecision } from '../../application/usecases/decide-estimate.usecase';
import { PrepareEstimateUseCase } from '../../application/usecases/prepare-estimate.usecase';

export class EstimateController {
    constructor(private readonly gateway: EstimateGatewayPort, private readonly prepare = new PrepareEstimateUseCase()) {}

    create = async (req: Request, res: Response) => {
        let prepared: ReturnType<PrepareEstimateUseCase['execute']>;
        try { prepared = this.prepare.execute(req.body); }
        catch { return res.status(400).json({ error: 'invalid estimate or total' }); }
        const result = await this.gateway.create(prepared.input, prepared.hash);
        if (result.kind === 'unavailable') return res.status(503).json({ error: 'database unavailable' });
        if (result.kind !== 'ok') return res.status(500).json({ error: 'estimate creation failed' });
        return res.status(result.created ? 201 : 200).json(result.data);
    };

    checkApproval = async (req: Request, res: Response) => {
        try { return res.json({ approved: await this.gateway.isApproved(req.params.id) }); }
        catch { return res.status(503).json({ error: 'database unavailable' }); }
    };

    decide = async (req: Request, res: Response) => {
        if (!['APPROVED', 'REJECTED'].includes(req.body?.decision)) return res.status(400).json({ error: 'invalid decision' });
        const result = await this.gateway.decide(req.params.id, req.body.decision as EstimateDecision);
        if (result.kind === 'not_found') return res.status(404).json({ error: 'estimate not found' });
        if (result.kind === 'superseded') return res.status(409).json({ error: 'estimate superseded' });
        if (result.kind === 'cannot_decide') return res.status(409).json({ error: 'estimate cannot be decided' });
        if (result.kind === 'unavailable') return res.status(503).json({ error: 'database unavailable' });
        if (result.kind !== 'ok') return res.status(500).json({ error: 'decision failed' });
        return res.json(result.data);
    };
}
