export interface CompletedExecution {
    order_id: string;
    message_id: string;
}

export class RegisterExecutionUseCase {
    checkExisting(orderId: string, messageId: string, executions: CompletedExecution[]): 'new' | 'duplicate' | 'conflict' {
        if (executions.length === 0) return 'new';
        return executions.some(execution => execution.order_id !== orderId || execution.message_id !== messageId)
            ? 'conflict'
            : 'duplicate';
    }

    canRegister(estimate: { status: string; createdAt?: Date; decisionAt?: Date | null } | undefined, occurredAt?: Date): boolean {
        if (!estimate || estimate.status !== 'APPROVED') return false;
        if (!occurredAt) return true;
        // A delayed event must not authorize a newer estimate created/approved after execution.
        return (!estimate.createdAt || estimate.createdAt.getTime() <= occurredAt.getTime())
            && (!estimate.decisionAt || estimate.decisionAt.getTime() <= occurredAt.getTime());
    }
}
