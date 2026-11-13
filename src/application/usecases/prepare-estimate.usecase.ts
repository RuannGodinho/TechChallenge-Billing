import { createHash } from 'node:crypto';
import { EstimateInput, validateEstimate } from '../../enterprise/entities/estimate.entity';

export class PrepareEstimateUseCase {
    execute(body: unknown): { input: EstimateInput; hash: string } {
        const input = validateEstimate(body);
        const hash = createHash('sha256').update(JSON.stringify({ total: input.total, items: input.items })).digest('hex');
        return { input, hash };
    }
}
