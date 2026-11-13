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

    canRegister(estimate: { status: string } | undefined): boolean {
        return !!estimate && estimate.status === 'APPROVED';
    }
}
