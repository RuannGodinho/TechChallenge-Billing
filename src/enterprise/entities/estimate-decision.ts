export type EstimateDecision = 'APPROVED' | 'REJECTED';
export type DecisionResult = 'superseded' | 'unchanged' | 'unavailable' | 'update';

export function assessEstimateDecision(estimate: { id: string; status: string; expiresAt: Date }, latestId: string | undefined, decision: EstimateDecision, now: Date): DecisionResult {
    if (latestId !== estimate.id) return 'superseded';
    if (estimate.status === decision) return 'unchanged';
    if (estimate.status !== 'PENDING' || estimate.expiresAt.getTime() <= now.getTime()) return 'unavailable';
    return 'update';
}
