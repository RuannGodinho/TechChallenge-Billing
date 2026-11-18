import { Pool } from 'pg';
import { EstimatePostgresGateway } from '../src/Adapters/gateways/estimate.postgres.gateway';

const input = { orderId: 'order', total: 1250, items: [] };
function setup(options: { existing?: boolean; missing?: boolean; latest?: string; status?: string; expired?: boolean; fail?: string } = {}) {
    const row = { id: 'estimate', order_id: 'order', status: options.status ?? 'PENDING',
        expires_at: new Date(Date.now() + (options.expired ? -1 : 1) * 86400000) };
    const client = { query: jest.fn(async (sql: string, values?: unknown[]) => {
        if (options.fail && sql.startsWith(options.fail)) throw new Error('database write failed');
        let rows: object[] = [];
        if (sql.includes('request_hash=$2')) rows = options.existing ? [row] : [];
        else if (sql.includes('MAX(version)')) rows = [{ version: 3 }];
        else if (sql.startsWith('SELECT * FROM estimates WHERE id')) rows = options.missing ? [] : [row];
        else if (sql.startsWith('SELECT id FROM estimates')) rows = [{ id: options.latest ?? row.id }];
        else if (sql.startsWith('INSERT INTO estimates') || sql.startsWith('UPDATE estimates')) rows = [{ ...row, status: values?.[1] ?? 'PENDING' }];
        return { rows, rowCount: rows.length };
    }), release: jest.fn() };
    const pool = { connect: jest.fn().mockResolvedValue(client), query: jest.fn().mockResolvedValue({ rows: [row] }) };
    return { row, client, pool, gateway: new EstimatePostgresGateway(pool as unknown as Pool) };
}
beforeEach(() => jest.spyOn(console, 'error').mockImplementation(() => undefined));
afterEach(() => jest.restoreAllMocks());

test('creates the next version and its outbox event before committing the transaction', async () => {
    const c = setup();
    expect(await c.gateway.create(input, 'hash')).toMatchObject({ kind: 'ok', created: true });
    const writes = c.client.query.mock.calls;
    const insert = writes.find(([sql]) => sql.startsWith('INSERT INTO estimates'))!;
    expect(insert[1]).toEqual([expect.any(String), 'order', 4, 'hash', 1250, '[]']);
    const event = writes.find(([sql]) => sql.startsWith('INSERT INTO outbox'))!;
    expect(event[1]?.[2]).toBe('estimate.created');
    expect(writes.at(-1)?.[0]).toBe('COMMIT');
    expect(c.client.release).toHaveBeenCalledTimes(1);
});
test('returns the existing quote for a repeated payload without creating another event', async () => {
    const c = setup({ existing: true });
    expect(await c.gateway.create(input, 'hash')).toEqual({ kind: 'ok', data: c.row, created: false });
    expect(c.client.query.mock.calls.some(([sql]) => sql.startsWith('INSERT'))).toBe(false);
});
test.each(['create', 'decide'] as const)('returns unavailable when %s cannot obtain a connection', async operation => {
    const c = setup(); c.pool.connect.mockRejectedValue(new Error('offline'));
    expect(await (operation === 'create' ? c.gateway.create(input, 'hash') : c.gateway.decide('estimate', 'APPROVED'))).toEqual({ kind: 'unavailable' });
});
test.each(['INSERT INTO estimates', 'INSERT INTO outbox'])('rolls back creation when %s fails', async fail => {
    const c = setup({ fail });
    expect(await c.gateway.create(input, 'hash')).toEqual({ kind: 'error' });
    expect(c.client.query).toHaveBeenLastCalledWith('ROLLBACK');
    expect(c.client.query.mock.calls.some(([sql]) => sql === 'COMMIT')).toBe(false);
    expect(c.client.release).toHaveBeenCalledTimes(1);
});
test.each([
    [{ missing: true }, 'not_found'], [{ latest: 'newer' }, 'superseded'],
    [{ expired: true }, 'cannot_decide'], [{ status: 'REJECTED' }, 'cannot_decide'],
] as const)('rejects an unavailable estimate without decision events: %p', async (options, kind) => {
    const c = setup(options);
    expect(await c.gateway.decide('estimate', 'APPROVED')).toEqual({ kind });
    expect(c.client.query.mock.calls.some(([sql]) => sql.startsWith('INSERT INTO outbox'))).toBe(false);
    expect(c.client.release).toHaveBeenCalledTimes(1);
});
test('repeated approval is idempotent and emits no duplicate event', async () => {
    const c = setup({ status: 'APPROVED' });
    expect(await c.gateway.decide('estimate', 'APPROVED')).toEqual({ kind: 'ok', data: c.row });
    expect(c.client.query.mock.calls.some(([sql]) => sql.startsWith('UPDATE') || sql.startsWith('INSERT'))).toBe(false);
    expect(c.client.query).toHaveBeenLastCalledWith('COMMIT');
});
test('publishes a decision event atomically with the new status', async () => {
    const c = setup();
    expect(await c.gateway.decide('estimate', 'REJECTED')).toMatchObject({ kind: 'ok', data: { status: 'REJECTED' } });
    const event = c.client.query.mock.calls.find(([sql]) => sql.startsWith('INSERT INTO outbox'))!;
    expect(event[1]?.[2]).toBe('estimate.rejected');
    expect(c.client.query).toHaveBeenLastCalledWith('COMMIT');
});
test('rolls back a decision when its event cannot be saved', async () => {
    const c = setup({ fail: 'INSERT INTO outbox' });
    expect(await c.gateway.decide('estimate', 'APPROVED')).toEqual({ kind: 'error' });
    expect(c.client.query).toHaveBeenLastCalledWith('ROLLBACK');
    expect(c.client.release).toHaveBeenCalledTimes(1);
});
test.each(['PENDING', 'APPROVED'])('checks the latest estimate approval: %s', async status => {
    const c = setup({ status });
    expect(await c.gateway.isApproved('order')).toBe(status === 'APPROVED');
    expect(c.pool.query).toHaveBeenCalledWith(expect.stringContaining('ORDER BY version DESC LIMIT 1'), ['order']);
});
