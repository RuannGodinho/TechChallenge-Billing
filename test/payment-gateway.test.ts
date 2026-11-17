import { Pool } from 'pg';
import { PaymentPostgresGateway } from '../src/Adapters/gateways/payment.postgres.gateway';

const order = { id: 'provider', external_reference: 'attempt', total_amount: '12.50', total_paid_amount: '12.50',
    currency: 'BRL', status: 'processed', status_detail: 'accredited', checkout_url: 'https://checkout.test' };
function setup(options: { completed?: 'duplicate' | 'conflict'; pendingEstimate?: boolean; missingGate?: boolean;
    existingAttempt?: 'same' | 'other'; active?: boolean; fail?: string; missingAttempt?: boolean; notification?: string } = {}) {
    const attempt = { id: 'attempt', order_id: 'order', estimate_id: 'estimate', status: 'CREATING',
        amount_cents: '1250', checkout_url: null, provider_order_id: 'provider', items: [{ nome: 'Troca', quantidade: 1, precoCents: 1250 }] };
    const estimate = { id: 'estimate', status: options.pendingEstimate ? 'PENDING' : 'APPROVED', total_cents: 1250,
        items: attempt.items, created_at: new Date('2026-01-01'), decision_at: new Date('2026-01-02') };
    const client = { query: jest.fn(async (sql: string, _values?: unknown[]) => {
        if (options.fail && sql.startsWith(options.fail)) throw new Error('database failure');
        let rows: object[] = [];
        if (sql.startsWith('SELECT order_id,message_id')) rows = options.completed ? [{ order_id: options.completed === 'duplicate' ? 'order' : 'another', message_id: 'message' }] : [];
        else if (sql.startsWith('SELECT id,status,created_at') || sql.startsWith('SELECT * FROM estimates')) rows = [estimate];
        else if (sql.startsWith('SELECT p.*')) rows = options.existingAttempt ? [{ ...attempt, order_id: options.existingAttempt === 'same' ? 'order' : 'another' }] : [];
        else if (sql.startsWith('SELECT estimate_id')) rows = options.missingGate ? [] : [{ estimate_id: 'estimate' }];
        else if (sql.startsWith('SELECT id FROM payment_attempts')) rows = options.active ? [{ id: 'existing' }] : [];
        else if (sql.startsWith('INSERT INTO payment_attempts')) rows = [attempt];
        else if (sql.startsWith('SELECT * FROM payment_attempts')) rows = options.missingAttempt ? [] : [attempt];
        else if (sql.startsWith('SELECT provider_order_id FROM processed_notifications')) rows = options.notification ? [{ provider_order_id: options.notification }] : [];
        return { rows, rowCount: rows.length };
    }), release: jest.fn() };
    const pool = { connect: jest.fn().mockResolvedValue(client), query: jest.fn().mockResolvedValue({ rows: [attempt] }) };
    return { attempt, client, pool, gateway: new PaymentPostgresGateway(pool as unknown as Pool) };
}
beforeEach(() => jest.spyOn(console, 'error').mockImplementation(() => undefined));
afterEach(() => jest.restoreAllMocks());

test('records execution only after checking the approved estimate and commits before releasing', async () => {
    const c = setup();
    expect(await c.gateway.registerExecution('order', 'message', new Date('2026-01-03'))).toBe('ok');
    expect(c.client.query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO completed_executions'), ['order', 'message', 'estimate']);
    expect(c.client.query).toHaveBeenLastCalledWith('COMMIT');
    expect(c.client.release).toHaveBeenCalledTimes(1);
});
test.each(['duplicate', 'conflict'] as const)('handles a %s execution without inserting another completion', async completed => {
    const c = setup({ completed });
    expect(await c.gateway.registerExecution('order', 'message')).toBe(completed === 'duplicate' ? 'ok' : 'conflict');
    expect(c.client.query.mock.calls.some(([sql]) => sql.startsWith('INSERT INTO completed'))).toBe(false);
});
test('refuses execution that happened before estimate approval', async () => {
    const c = setup();
    expect(await c.gateway.registerExecution('order', 'message', new Date('2026-01-01'))).toBe('approval_required');
    expect(c.client.query).toHaveBeenLastCalledWith('ROLLBACK');
});
test('does not register execution for a pending estimate', async () => {
    const c = setup({ pendingEstimate: true });
    expect(await c.gateway.registerExecution('order', 'message')).toBe('approval_required');
});
test('builds checkout from the approved snapshot in the same transaction', async () => {
    const c = setup();
    expect(await c.gateway.prepareCheckout('order', 'stable-key')).toEqual({ kind: 'ok', attempt: {
        id: 'attempt', status: 'CREATING', checkoutUrl: null, amountCents: 1250, items: c.attempt.items,
    } });
    expect(c.client.query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO payment_attempts'),
        [expect.any(String), 'order', 'estimate', 'stable-key', 1250]);
    expect(c.client.query).toHaveBeenLastCalledWith('COMMIT');
});
test.each(['same', 'other'] as const)('checks order ownership when reusing an idempotency key: %s', async existingAttempt => {
    const c = setup({ existingAttempt });
    expect((await c.gateway.prepareCheckout('order', 'key')).kind).toBe(existingAttempt === 'same' ? 'ok' : 'wrong_order');
    expect(c.client.query.mock.calls.some(([sql]) => sql.startsWith('INSERT INTO payment_attempts'))).toBe(false);
});
test.each([
    [{ missingGate: true }, 'approval_required'], [{ pendingEstimate: true }, 'approval_required'], [{ active: true }, 'attempt_exists'],
] as const)('rejects an ineligible checkout without creating an attempt: %p', async (options, kind) => {
    const c = setup(options);
    expect(await c.gateway.prepareCheckout('order', 'key')).toEqual({ kind });
    expect(c.client.query.mock.calls.some(([sql]) => sql.startsWith('INSERT INTO payment_attempts'))).toBe(false);
    expect(c.client.query).toHaveBeenLastCalledWith('ROLLBACK');
});
test.each(['execution', 'checkout'])('reports connection and transactional failures during %s', async operation => {
    const c = setup({ fail: 'SELECT pg_advisory' });
    const run = () => operation === 'execution' ? c.gateway.registerExecution('order', 'message') : c.gateway.prepareCheckout('order', 'key');
    expect(await run()).toEqual(operation === 'execution' ? 'execution_unavailable' : { kind: 'preparation_failed' });
    expect(c.client.query).toHaveBeenLastCalledWith('ROLLBACK');
    expect(c.client.release).toHaveBeenCalledTimes(1);
    c.pool.connect.mockRejectedValue(new Error('offline'));
    expect(await run()).toEqual(operation === 'execution' ? 'database_unavailable' : { kind: 'database_unavailable' });
});
test('maps stored payment references and distinguishes absent rows', async () => {
    const c = setup();
    expect(await c.gateway.saveCheckout('attempt', order)).toEqual({ id: 'attempt', status: 'CREATING', checkoutUrl: null });
    expect(await c.gateway.findPaidAttempt('order')).toEqual({ id: 'attempt', providerOrderId: 'provider' });
    expect(await c.gateway.findPayment('attempt')).toEqual(c.attempt);
    expect(await c.gateway.findProviderReference('attempt')).toEqual({ providerOrderId: 'provider' });
    expect(await c.gateway.readPaymentStatus('attempt')).toBe('CREATING');
    expect(await c.gateway.readReconciledPayment('attempt')).toEqual(c.attempt);
    c.pool.query.mockResolvedValue({ rows: [] });
    expect(await c.gateway.saveCheckout('attempt', order)).toBeNull();
    expect(await c.gateway.findPaidAttempt('order')).toBeNull();
    expect(await c.gateway.findPayment('attempt')).toBeNull();
    expect(await c.gateway.findProviderReference('attempt')).toBeNull();
    expect(await c.gateway.readPaymentStatus('attempt')).toBeUndefined();
    expect(await c.gateway.readReconciledPayment('attempt')).toBeUndefined();
});
test('reconciles payment and its notification atomically', async () => {
    const c = setup();
    await c.gateway.reconcile(order, 'notification');
    expect(c.client.query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO processed_notifications'), ['notification', 'provider']);
    expect(c.client.query).toHaveBeenLastCalledWith('COMMIT');
    expect(c.client.release).toHaveBeenCalledTimes(1);
});
test('an already processed notification produces no additional payment write', async () => {
    const c = setup({ notification: 'provider' });
    await c.gateway.reconcile(order, 'notification');
    expect(c.client.query.mock.calls.some(([sql]) => sql.startsWith('UPDATE payment_attempts') || sql.startsWith('INSERT INTO outbox'))).toBe(false);
});
test.each([{ missingAttempt: true }, { notification: 'another' }, { fail: 'INSERT INTO outbox' }])('rolls back rejected reconciliation: %p', async options => {
    const c = setup(options);
    await expect(c.gateway.reconcile(order, 'notification')).rejects.toThrow();
    expect(c.client.query).toHaveBeenLastCalledWith('ROLLBACK');
    expect(c.client.release).toHaveBeenCalledTimes(1);
});
