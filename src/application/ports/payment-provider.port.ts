export interface ProviderOrder {
    id: string;
    checkout_url: string;
    status: string;
    status_detail?: string;
    external_reference: string;
    total_amount: string;
    currency: string;
    total_paid_amount?: string;
}

export interface PaymentProviderPort {
    createOrder(input: {
        attemptId: string;
        idempotencyKey: string;
        amountCents: number;
        items: Array<{ title: string; quantity: number; unit_price: string }>;
    }): Promise<ProviderOrder>;
    getOrder(providerOrderId: string): Promise<ProviderOrder>;
}
