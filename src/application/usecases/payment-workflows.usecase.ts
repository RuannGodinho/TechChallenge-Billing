import { randomUUID } from 'node:crypto';
import { CheckoutSummary, PaymentGatewayPort } from '../ports/payment-gateway.port';
import { PaymentProviderPort } from '../ports/payment-provider.port';
import { PrepareCheckoutUseCase } from './prepare-checkout.usecase';

export class PaymentWorkflows {
    private readonly prepare = new PrepareCheckoutUseCase();

    constructor(readonly gateway: PaymentGatewayPort, private readonly provider: () => PaymentProviderPort) {}

    async checkout(orderId: string, key: string) {
        const result = await this.gateway.prepareCheckout(orderId, key);
        if (result.kind !== 'ok') return result;
        const { id, status, checkoutUrl, items, amountCents } = result.attempt;
        if (status !== 'CREATING') return { kind: 'success', payment: { id, status, checkoutUrl } } as const;
        try {
            const order = await this.provider().createOrder(this.prepare.execute(id, key, amountCents, items));
            this.prepare.validateProviderOrder(order, id, amountCents);
            const payment: CheckoutSummary | null = await this.gateway.saveCheckout(id, order);
            return payment ? { kind: 'success', payment } as const : { kind: 'provider_conflict' } as const;
        } catch (error) {
            console.error('checkout provider request failed', error);
            return { kind: 'provider_unavailable', attemptId: id } as const;
        }
    }

    async isPaid(orderId: string): Promise<boolean> {
        const attempt = await this.gateway.findPaidAttempt(orderId);
        if (!attempt?.providerOrderId) return false;
        const order = await this.findOrder(attempt.providerOrderId, attempt.id);
        await this.gateway.reconcile(order, `check:${randomUUID()}`);
        const status = await this.gateway.readPaymentStatus(attempt.id);
        return status === 'PAID' && order.status === 'processed' && order.status_detail === 'accredited';
    }

    async reconcileManually(id: string) {
        const attempt = await this.gateway.findProviderReference(id);
        if (!attempt) return { kind: 'not_found' } as const;
        if (!attempt.providerOrderId) return { kind: 'provider_missing' } as const;
        const order = await this.findOrder(attempt.providerOrderId, id);
        await this.gateway.reconcile(order, `manual:${randomUUID()}`);
        return { kind: 'ok', payment: await this.gateway.readReconciledPayment(id) } as const;
    }

    async processNotification(providerOrderId: string, notificationId: string): Promise<void> {
        const order = await this.provider().getOrder(providerOrderId);
        if (order.id.toLowerCase() !== providerOrderId.toLowerCase() || !order.external_reference) {
            throw new Error('provider order mismatch');
        }
        await this.gateway.reconcile(order, notificationId);
    }

    private async findOrder(providerOrderId: string, attemptId: string) {
        const order = await this.provider().getOrder(providerOrderId);
        if (order.id !== providerOrderId || order.external_reference !== attemptId) {
            throw new Error('provider order mismatch');
        }
        return order;
    }
}
