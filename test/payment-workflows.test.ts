import { PaymentWorkflows } from '../src/application/usecases/payment-workflows.usecase';
import { PaymentGatewayPort } from '../src/application/ports/payment-gateway.port';
import { PaymentProviderPort } from '../src/application/ports/payment-provider.port';

function setup() {
    const gateway: jest.Mocked<PaymentGatewayPort> = {
        registerExecution: jest.fn(), prepareCheckout: jest.fn(), saveCheckout: jest.fn(),
        findPaidAttempt: jest.fn(), findPayment: jest.fn(), findProviderReference: jest.fn(),
        readPaymentStatus: jest.fn(), readReconciledPayment: jest.fn(), reconcile: jest.fn(),
    };
    const order = { id: 'provider', external_reference: 'attempt', total_amount: '12.50',
        currency: 'BRL', status: 'processed', status_detail: 'accredited', checkout_url: 'https://checkout.test' };
    const provider: jest.Mocked<PaymentProviderPort> = {
        createOrder: jest.fn().mockResolvedValue(order), getOrder: jest.fn().mockResolvedValue(order),
    };
    gateway.prepareCheckout.mockResolvedValue({ kind: 'ok', attempt: {
        id: 'attempt', status: 'CREATING', checkoutUrl: null, amountCents: 1250,
        items: [{ nome: 'Troca', quantidade: 1, precoCents: 1250 }],
    } });
    gateway.saveCheckout.mockResolvedValue({ id: 'attempt', status: 'PENDING', checkoutUrl: order.checkout_url });
    const workflows = new PaymentWorkflows(gateway, () => provider);
    return { gateway, provider, order, workflows };
}

afterEach(() => jest.restoreAllMocks());

test.each(['database_unavailable', 'preparation_failed', 'wrong_order', 'approval_required', 'attempt_exists'] as const)(
    'does not contact the provider when checkout preparation returns %s', async kind => {
        const c = setup(); c.gateway.prepareCheckout.mockResolvedValue({ kind });
        expect(await c.workflows.checkout('order', 'key')).toEqual({ kind });
        expect(c.provider.createOrder).not.toHaveBeenCalled();
    });

test('reuses an existing checkout without issuing another provider order', async () => {
    const c = setup();
    c.gateway.prepareCheckout.mockResolvedValue({ kind: 'ok', attempt: {
        id: 'attempt', status: 'PAID', checkoutUrl: 'https://existing.test', amountCents: 1250, items: [],
    } });
    expect(await c.workflows.checkout('order', 'key')).toEqual({ kind: 'success', payment: {
        id: 'attempt', status: 'PAID', checkoutUrl: 'https://existing.test',
    } });
    expect(c.provider.createOrder).not.toHaveBeenCalled();
    expect(c.gateway.saveCheckout).not.toHaveBeenCalled();
});

test('creates and saves a checkout with its original idempotency key and amount', async () => {
    const c = setup();
    expect((await c.workflows.checkout('order', 'stable-key')).kind).toBe('success');
    expect(c.provider.createOrder).toHaveBeenCalledWith({ attemptId: 'attempt', idempotencyKey: 'stable-key',
        amountCents: 1250, items: [{ title: 'Troca', quantity: 1, unit_price: '12.50' }] });
    expect(c.gateway.saveCheckout).toHaveBeenCalledWith('attempt', c.order);
});

test('reports a conflicting provider order instead of claiming it was saved', async () => {
    const c = setup(); c.gateway.saveCheckout.mockResolvedValue(null);
    expect(await c.workflows.checkout('order', 'key')).toEqual({ kind: 'provider_conflict' });
});

test.each(['timeout', 'mismatched amount'])('keeps the original attempt recoverable after %s', async failure => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const c = setup();
    if (failure === 'timeout') c.provider.createOrder.mockRejectedValue(new Error('timeout'));
    else c.provider.createOrder.mockResolvedValue({ ...c.order, total_amount: '0.01' });
    expect(await c.workflows.checkout('order', 'key')).toEqual({ kind: 'provider_unavailable', attemptId: 'attempt' });
    expect(c.gateway.saveCheckout).not.toHaveBeenCalled();
});

test.each([null, { id: 'attempt', providerOrderId: null }])('does not confirm payment without a provider reference: %p', async attempt => {
    const c = setup(); c.gateway.findPaidAttempt.mockResolvedValue(attempt);
    expect(await c.workflows.isPaid('order')).toBe(false);
    expect(c.provider.getOrder).not.toHaveBeenCalled();
});

test.each([
    ['PAID', 'processed', 'accredited', true],
    ['REVERSED', 'processed', 'accredited', false],
    ['PAID', 'created', 'accredited', false],
    ['PAID', 'processed', 'pending', false],
] as const)('requires stored %s and provider %s/%s for delivery eligibility', async (stored, status, detail, paid) => {
    const c = setup(); c.gateway.findPaidAttempt.mockResolvedValue({ id: 'attempt', providerOrderId: 'provider' });
    c.gateway.readPaymentStatus.mockResolvedValue(stored);
    c.provider.getOrder.mockResolvedValue({ ...c.order, status, status_detail: detail });
    expect(await c.workflows.isPaid('order')).toBe(paid);
    expect(c.gateway.reconcile).toHaveBeenCalledWith(expect.objectContaining({ id: 'provider' }), expect.stringMatching(/^check:/));
});

test.each(['id', 'external_reference'] as const)('rejects a mismatched provider %s before reconciling payment', async field => {
    const c = setup(); c.gateway.findPaidAttempt.mockResolvedValue({ id: 'attempt', providerOrderId: 'provider' });
    c.provider.getOrder.mockResolvedValue({ ...c.order, [field]: 'another' });
    await expect(c.workflows.isPaid('order')).rejects.toThrow('provider order mismatch');
    expect(c.gateway.reconcile).not.toHaveBeenCalled();
});

test.each([
    [null, 'not_found'], [{ providerOrderId: null }, 'provider_missing'],
] as const)('reports unavailable manual reconciliation references: %p', async (reference, kind) => {
    const c = setup(); c.gateway.findProviderReference.mockResolvedValue(reference);
    expect(await c.workflows.reconcileManually('attempt')).toEqual({ kind });
    expect(c.provider.getOrder).not.toHaveBeenCalled();
});

test('manual reconciliation returns the freshly persisted payment', async () => {
    const c = setup(); c.gateway.findProviderReference.mockResolvedValue({ providerOrderId: 'provider' });
    c.gateway.readReconciledPayment.mockResolvedValue({ id: 'attempt', status: 'PAID' });
    expect(await c.workflows.reconcileManually('attempt')).toEqual({ kind: 'ok', payment: { id: 'attempt', status: 'PAID' } });
    expect(c.gateway.reconcile).toHaveBeenCalledWith(c.order, expect.stringMatching(/^manual:/));
});

test('accepts provider notification IDs case insensitively while preserving deduplication identity', async () => {
    const c = setup();
    await c.workflows.processNotification('PROVIDER', 'stable-notification');
    expect(c.gateway.reconcile).toHaveBeenCalledWith(c.order, 'stable-notification');
});

test.each([{ id: 'another' }, { external_reference: '' }])('rejects an unrelated or unbound notification: %p', async patch => {
    const c = setup(); c.provider.getOrder.mockResolvedValue({ ...c.order, ...patch });
    await expect(c.workflows.processNotification('provider', 'notification')).rejects.toThrow('provider order mismatch');
    expect(c.gateway.reconcile).not.toHaveBeenCalled();
});
