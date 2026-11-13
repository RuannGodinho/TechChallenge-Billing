import { determinePaymentStatus, matchesAmount } from '../../enterprise/value-objects/payment-status';

export interface PaymentAttemptSnapshot {
    status: string;
    amountCents: number;
    providerOrderId: string | null;
}

export interface ProviderPaymentSnapshot {
    id: string;
    status: string;
    status_detail?: string;
    total_amount: string;
    total_paid_amount?: string;
    currency: string;
}

export class ReconcilePaymentUseCase {
    validate(attempt: PaymentAttemptSnapshot, order: ProviderPaymentSnapshot): void {
        if (attempt.providerOrderId && attempt.providerOrderId !== order.id) throw new Error('provider id mismatch');
        if (order.currency !== 'BRL' || !matchesAmount(order.total_amount, attempt.amountCents)) {
            throw new Error('provider amount or currency mismatch');
        }
    }

    execute(attempt: PaymentAttemptSnapshot, order: ProviderPaymentSnapshot): { status: string; event: string | null } {
        const paid = order.status === 'processed' && order.status_detail === 'accredited' &&
            matchesAmount(order.total_paid_amount, attempt.amountCents);
        const reversed = order.status === 'refunded' || order.status === 'charged_back' ||
            order.status_detail === 'partially_refunded';
        const status = determinePaymentStatus(attempt.status, order.status, paid, reversed);
        let event: string | null = null;
        if (status === 'PAID' && attempt.status !== 'PAID') event = 'payment.confirmed';
        if (status === 'REVERSED' && attempt.status === 'PAID') event = 'payment.reversed';
        return { status, event };
    }
}
