import { strict as assert } from 'node:assert';
import { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { EstimateController } from '../src/Adapters/controllers/estimate.controller';
import { createPaymentController } from '../src/Adapters/controllers/payment.controller';
import { CheckoutAttempt, PaymentGatewayPort } from '../src/application/ports/payment-gateway.port';
import { PaymentProviderPort, ProviderOrder } from '../src/application/ports/payment-provider.port';
import { PaymentWorkflows } from '../src/application/usecases/payment-workflows.usecase';
import { ReconcilePaymentUseCase } from '../src/application/usecases/reconcile-payment.usecase';
import { createBillingApp } from '../src/server';

test('fluxo HTTP de orçamento, execução, checkout e confirmação', async t => {
    const orderId = 'order-1';
    const estimateId = 'estimate-1';
    const attemptId = 'attempt-1';
    const key = '7a1fb88b-714d-4350-8abb-e437c441ab31';
    const apiKey = 'billing-e2e-key';
    const oldKey = process.env.INTERNAL_API_KEY;
    process.env.INTERNAL_API_KEY = apiKey;
    t.after(() => {
        if (oldKey === undefined) delete process.env.INTERNAL_API_KEY;
        else process.env.INTERNAL_API_KEY = oldKey;
    });

    let estimateStatus = 'PENDING';
    let executed = false;
    let attempt: CheckoutAttempt | undefined;
    let providerOrder: ProviderOrder | undefined;
    let providerCalls = 0;
    const notifications = new Set<string>();
    const events: string[] = [];
    const reconciliation = new ReconcilePaymentUseCase();

    const gateway: PaymentGatewayPort = {
        async registerExecution(id) {
            assert.equal(id, orderId);
            if (estimateStatus !== 'APPROVED') return 'approval_required';
            executed = true;
            return 'ok';
        },
        async prepareCheckout(id, idempotencyKey) {
            assert.equal(id, orderId);
            assert.equal(idempotencyKey, key);
            if (!executed) return { kind: 'approval_required' };
            attempt ??= {
                id: attemptId, status: 'CREATING', checkoutUrl: null, amountCents: 1250,
                items: [{ nome: 'Servico', quantidade: 1, precoCents: 1250 }],
            };
            return { kind: 'ok', attempt };
        },
        async saveCheckout(id, order) {
            assert.equal(id, attemptId);
            assert.ok(attempt);
            attempt.status = 'PENDING';
            attempt.checkoutUrl = order.checkout_url;
            return { id, status: attempt.status, checkoutUrl: attempt.checkoutUrl };
        },
        async findPaidAttempt(id) {
            assert.equal(id, orderId);
            return attempt?.status === 'PAID' ? { id: attemptId, providerOrderId: providerOrder!.id } : null;
        },
        async findPayment(id) { return id === attemptId && attempt ? { id, status: attempt.status } : null; },
        async findProviderReference() { throw new Error('unexpected manual reconciliation'); },
        async readReconciledPayment() { throw new Error('unexpected manual reconciliation'); },
        async readPaymentStatus() { return attempt?.status; },
        async reconcile(order, notificationId) {
            assert.ok(attempt);
            if (notifications.has(notificationId)) return;
            const snapshot = { status: attempt.status, amountCents: attempt.amountCents, providerOrderId: providerOrder!.id };
            reconciliation.validate(snapshot, order);
            const result = reconciliation.execute(snapshot, order);
            attempt.status = result.status;
            if (result.event) events.push(result.event);
            notifications.add(notificationId);
        },
    };
    const provider: PaymentProviderPort = {
        async createOrder(input) {
            providerCalls++;
            assert.equal(input.idempotencyKey, key);
            assert.equal(input.amountCents, 1250);
            assert.deepEqual(input.items, [{ title: 'Servico', quantity: 1, unit_price: '12.50' }]);
            providerOrder = {
                id: 'provider-1', status: 'created', external_reference: input.attemptId,
                total_amount: '12.50', currency: 'BRL', checkout_url: 'https://example.test/checkout',
            };
            return providerOrder;
        },
        async getOrder(id) {
            assert.ok(providerOrder);
            assert.equal(id, providerOrder.id);
            return providerOrder;
        },
    };
    const estimates = new EstimateController({
        async create(input) {
            assert.equal(input.orderId, orderId);
            assert.equal(input.total, 1250);
            return { kind: 'ok', data: { id: estimateId }, created: true };
        },
        async isApproved() { return estimateStatus === 'APPROVED'; },
        async decide(id, decision) {
            assert.equal(id, estimateId);
            estimateStatus = decision;
            return { kind: 'ok', data: { id, status: decision } };
        },
    });
    const payments = createPaymentController({
        workflows: new PaymentWorkflows(gateway, () => provider),
        providerConfigured: () => true,
        verifyWebhook: (signature, requestId, id) => signature === 'test-signature' && requestId === 'test-request' && id === 'provider-1',
    });

    const app = createBillingApp(payments, estimates);
    const server = await new Promise<ReturnType<typeof app.listen>>(resolve => {
        const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const headers = { 'content-type': 'application/json', 'x-internal-api-key': apiKey };
    const post = (path: string, body: object, extra: Record<string, string> = {}) =>
        fetch(base + path, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) });
    const orders = `/internal/orders/${orderId}`;

    assert.equal((await post('/internal/estimates', {
        ordemServicoId: orderId, valorTotal: 12.5, pecas: [],
        servicos: [{ id: 's1', nome: 'Servico', descricao: '', preco: 12.5 }],
    })).status, 201);
    assert.equal((await post(`${orders}/checkout`, {}, { 'idempotency-key': key })).status, 409);
    assert.equal((await post(`/internal/estimates/${estimateId}/decision`, { decision: 'APPROVED' })).status, 200);
    const approval = await fetch(`${base}${orders}/estimate-approval`, { headers });
    assert.deepEqual(await approval.json(), { approved: true });

    assert.equal((await post(`${orders}/execution-complete`, { messageId: key })).status, 204);
    for (let count = 0; count < 2; count++) {
        const checkout = await post(`${orders}/checkout`, {}, { 'idempotency-key': key });
        assert.equal(checkout.status, 200);
        assert.deepEqual(await checkout.json(), { id: attemptId, status: 'PENDING', checkoutUrl: 'https://example.test/checkout' });
    }
    assert.equal(providerCalls, 1);

    assert.ok(providerOrder);
    Object.assign(providerOrder, { status: 'processed', status_detail: 'accredited', total_paid_amount: '12.50' });
    const webhook = () => fetch(`${base}/webhooks/mercado-pago?data.id=provider-1`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-signature': 'test-signature', 'x-request-id': 'test-request' },
        body: JSON.stringify({ type: 'order', id: 'notification-1' }),
    });
    assert.equal((await webhook()).status, 200);
    assert.equal((await webhook()).status, 200);
    const paid = await fetch(`${base}${orders}/payment-status`, { headers });
    assert.deepEqual(await paid.json(), { paid: true });
    assert.deepEqual(events, ['payment.confirmed']);
});
