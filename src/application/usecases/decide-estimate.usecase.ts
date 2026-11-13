import { assessEstimateDecision, EstimateDecision } from '../../enterprise/entities/estimate-decision';
export { EstimateDecision, DecisionResult } from '../../enterprise/entities/estimate-decision';

export class DecideEstimateUseCase {
    execute(estimate: { id: string; status: string; expiresAt: Date }, latestId: string | undefined, decision: EstimateDecision, now: Date) {
        return assessEstimateDecision(estimate, latestId, decision, now);
    }
}
