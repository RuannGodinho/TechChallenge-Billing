import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { SagaPostgresGateway } from '../src/Adapters/gateways/saga.postgres.gateway';
import { OutboxPostgresGateway } from '../src/Adapters/gateways/outbox.postgres.gateway';
import { SagaMessage } from '../src/infrastructure/messaging/saga';

const command: SagaMessage = { messageId: randomUUID(), eventType: 'billing.CriarOrcamento', eventVersion: 1,
    orderId: '000000000000000000000001', occurredAt: '2026-01-01T00:00:00Z', data: {
        sagaId: randomUUID(), commandId: randomUUID(), attempt: 1, commandType: 'billing.CriarOrcamento',
        snapshot: { ordemServicoId: '000000000000000000000001', valorTotal: 10, pecas: [],
            servicos: [{ id: 'service', nome: 'Troca', descricao: 'Óleo', preco: 10 }] },
    } };
const expires = new Date('2026-12-01T00:00:00Z');
function setup(options: { duplicate?: boolean; cancelled?: boolean; existing?: boolean; mismatch?: boolean; fail?: boolean } = {}) {
    const client = { query: jest.fn(async (sql: string, _values?: unknown[]) => {
        if (options.fail && sql.startsWith('INSERT INTO estimates')) throw Object.assign(new Error('database write failed'), { code: '23505' });
        let rows: object[] = [];
        if (sql.startsWith('SELECT result FROM saga_inbox')) rows = options.duplicate ? [{ result: {} }] : [];
        else if (sql.startsWith('SELECT * FROM saga_participations')) rows = [{ order_id: options.mismatch ? 'another' : command.orderId,
            attempt: 1, cancelled: options.cancelled, estimate_id: options.existing ? 'estimate' : null }];
        else if (sql.includes('MAX(version)')) rows = [{ v: 3 }];
        else if (sql.startsWith('INSERT INTO estimates') || sql.startsWith('SELECT * FROM estimates WHERE id')) rows = [{ id: 'estimate', version: 3, expires_at: expires }];
        return { rows, rowCount: rows.length };
    }), release: jest.fn() };
    const pool = { connect: jest.fn().mockResolvedValue(client), query: jest.fn().mockResolvedValue({ rows: [], rowCount: 1 }) };
    return { client, pool, gateway: new SagaPostgresGateway(pool as unknown as Pool) };
}
function savedResult(c: ReturnType<typeof setup>) {
    return c.client.query.mock.calls.find(([sql]) => sql.startsWith('INSERT INTO saga_outbox'))?.[1]?.[1] as SagaMessage;
}
test('creates a Saga-specific estimate and commits its result and notification atomically', async () => {
    const c = setup(); await c.gateway.execute(command);
    const insert = c.client.query.mock.calls.find(([sql]) => sql.startsWith('INSERT INTO estimates'))!;
    expect(insert[1]).toEqual([expect.any(String), command.orderId, 3, expect.stringContaining(`:${command.data.sagaId}`), 1000, expect.any(String)]);
    const result = savedResult(c);
    expect(result).toMatchObject({ eventType: 'saga.result', orderId: command.orderId,
        data: { ok: true, estimateId: expect.any(String), estimateVersion: 3, expiresAt: expires.toISOString() } });
    expect(result.data.snapshot).toBeUndefined();
    expect(c.client.query).toHaveBeenCalledWith('INSERT INTO saga_inbox VALUES($1,$2)', [command.data.commandId, result]);
    expect(c.client.query).toHaveBeenLastCalledWith('COMMIT');
    expect(c.client.release).toHaveBeenCalledTimes(1);
});
test('deduplicates a command without issuing another estimate or Saga result', async () => {
    const c = setup({ duplicate: true }); await c.gateway.execute(command);
    expect(c.client.query.mock.calls.some(([sql]) => sql.startsWith('INSERT'))).toBe(false);
    expect(c.client.query).toHaveBeenLastCalledWith('COMMIT');
});
test('cancels only pending or approved estimates and records compensation success', async () => {
    const c = setup({ existing: true });
    await c.gateway.execute({ ...command, eventType: 'billing.CancelarOrcamento' });
    expect(c.client.query).toHaveBeenCalledWith(expect.stringContaining("status IN ('PENDING','APPROVED')"), ['estimate']);
    expect(savedResult(c).data.ok).toBe(true);
});
test('does not resurrect an already cancelled participation', async () => {
    const c = setup({ cancelled: true }); await c.gateway.execute(command);
    expect(savedResult(c).data).toMatchObject({ ok: false, error: 'Tentativa cancelada' });
    expect(c.client.query.mock.calls.some(([sql]) => sql.startsWith('INSERT INTO estimates'))).toBe(false);
});
test('reuses the participation estimate without creating a new version', async () => {
    const c = setup({ existing: true }); await c.gateway.execute(command);
    expect(savedResult(c).data).toMatchObject({ ok: true, estimateId: 'estimate', estimateVersion: 3 });
    expect(c.client.query.mock.calls.some(([sql]) => sql.startsWith('INSERT INTO estimates'))).toBe(false);
});
test.each([{ valorTotal: 9 }, { ordemServicoId: 'another-order' }])('persists a business refusal for invalid snapshots: %p', async patch => {
    const c = setup(); await c.gateway.execute({ ...command, data: { ...command.data, snapshot: { ...command.data.snapshot, ...patch } } });
    expect(savedResult(c).data).toMatchObject({ ok: false, error: expect.any(String) });
    expect(c.client.query.mock.calls.some(([sql]) => sql.startsWith('INSERT INTO estimates'))).toBe(false);
    expect(c.client.query).toHaveBeenLastCalledWith('COMMIT');
});
test.each([{ mismatch: true }, { fail: true }])('rolls back infrastructure or identity failures without acknowledging the command: %p', async options => {
    const c = setup(options);
    await expect(c.gateway.execute(command)).rejects.toThrow();
    expect(c.client.query).toHaveBeenLastCalledWith('ROLLBACK');
    expect(savedResult(c)).toBeUndefined();
    expect(c.client.release).toHaveBeenCalledTimes(1);
});
test('claims and acknowledges Saga results using their lease owner and bounds retry errors', async () => {
    const c = setup(); c.pool.query.mockResolvedValue({ rows: [{ id: 'event', event: command }], rowCount: 1 });
    expect(await c.gateway.claim()).toEqual({ id: 'event', event: command });
    const owner = c.pool.query.mock.calls[0][1][0];
    await c.gateway.markPublished('event');
    expect(c.pool.query).toHaveBeenLastCalledWith(expect.stringContaining('owner=$2'), ['event', owner]);
    await c.gateway.markFailed('event', 'x'.repeat(1500));
    expect(c.pool.query).toHaveBeenLastCalledWith(expect.stringContaining('next_attempt_at'), ['event', owner, 'x'.repeat(1000)]);
    c.pool.query.mockResolvedValue({ rows: [], rowCount: 0 });
    expect(await c.gateway.claim()).toBeNull();
    await c.gateway.expire();
    expect(c.pool.query).toHaveBeenLastCalledWith(expect.stringContaining("status='PENDING' AND expires_at<=now()"));
});
test('claims a Billing event preserving its identity, payload and occurrence time', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rows: [{ id: 'event', kind: 'estimate.created',
        payload: { orderId: 'order', estimateId: 'estimate' }, created_at: expires }], rowCount: 1 }) };
    const gateway = new OutboxPostgresGateway(pool as unknown as Pool);
    expect(await gateway.claim()).toEqual({ id: 'event', event: { messageId: 'event', eventType: 'estimate.created',
        eventVersion: 1, orderId: 'order', occurredAt: expires.toISOString(), data: { orderId: 'order', estimateId: 'estimate' } } });
    const owner = pool.query.mock.calls[0][1][0];
    await gateway.markPublished('event');
    expect(pool.query).toHaveBeenLastCalledWith(expect.stringContaining('lease_owner=$2'), ['event', owner]);
    await gateway.markFailed('event', 'x'.repeat(1500));
    expect(pool.query).toHaveBeenLastCalledWith(expect.stringContaining('next_attempt_at'), ['event', owner, 'x'.repeat(1000)]);
    pool.query.mockResolvedValue({ rows: [], rowCount: 0 });
    expect(await gateway.claim()).toBeNull();
    await expect(gateway.markPublished('event')).rejects.toThrow('Outbox lease no longer owned');
});
