import { matchesAmount } from '../../enterprise/value-objects/payment-status';

export interface CheckoutEstimateItem {
    nome: string;
    quantidade: number;
    precoCents: number;
}

export class PrepareCheckoutUseCase {
    execute(attemptId: string, idempotencyKey: string, amountCents: number, items: CheckoutEstimateItem[]) {
        return {
            attemptId,
            idempotencyKey,
            amountCents,
            items: items.map(item => ({
                title: item.nome,
                quantity: item.quantidade,
                unit_price: (item.precoCents / 100).toFixed(2),
            })),
        };
    }

    validateProviderOrder(order: { external_reference: string; total_amount: string; currency: string }, attemptId: string, amountCents: number): void {
        if (order.external_reference !== attemptId || !matchesAmount(order.total_amount, amountCents) || order.currency !== 'BRL') {
            throw new Error('provider order does not match attempt');
        }
    }
}
