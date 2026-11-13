import { EstimateInput } from '../../enterprise/entities/estimate.entity';
import { EstimateDecision } from '../usecases/decide-estimate.usecase';

export type EstimateWriteResult =
    | { kind: 'ok'; data: unknown; created?: boolean }
    | { kind: 'unavailable' | 'error' | 'not_found' | 'superseded' | 'cannot_decide' };

export interface EstimateGatewayPort {
    create(input: EstimateInput, hash: string): Promise<EstimateWriteResult>;
    isApproved(orderId: string): Promise<boolean>;
    decide(id: string, decision: EstimateDecision): Promise<EstimateWriteResult>;
}
