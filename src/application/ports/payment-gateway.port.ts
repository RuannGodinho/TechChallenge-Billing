import { CheckoutEstimateItem } from '../usecases/prepare-checkout.usecase';
import { ProviderOrder } from './payment-provider.port';

export interface CheckoutSummary {
    id: string;
    status: string;
    checkoutUrl: string | null;
}

export interface CheckoutAttempt extends CheckoutSummary {
    amountCents: number;
    items: CheckoutEstimateItem[];
}

export type ExecutionResult = 'ok' | 'conflict' | 'approval_required' | 'database_unavailable' | 'execution_unavailable';
export type CheckoutPreparation =
    | { kind: 'ok'; attempt: CheckoutAttempt }
    | { kind: 'database_unavailable' | 'preparation_failed' | 'wrong_order' | 'approval_required' | 'attempt_exists' };

export interface PaymentGatewayPort {
    registerExecution(orderId: string, messageId: string): Promise<ExecutionResult>;
    prepareCheckout(orderId: string, key: string): Promise<CheckoutPreparation>;
    saveCheckout(attemptId: string, order: ProviderOrder): Promise<CheckoutSummary | null>;
    findPaidAttempt(orderId: string): Promise<{ id: string; providerOrderId: string | null } | null>;
    findPayment(id: string): Promise<Record<string, unknown> | null>;
    findProviderReference(id: string): Promise<{ providerOrderId: string | null } | null>;
    readPaymentStatus(id: string): Promise<string | undefined>;
    readReconciledPayment(id: string): Promise<Record<string, unknown> | undefined>;
    reconcile(order: ProviderOrder, notificationId: string): Promise<void>;
}
