import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { PoolClient } from 'pg';
import { reconcile } from '../src/payments';
import { CheckoutOrder } from '../src/mercado-pago';

function stub(attemptStatus = 'PENDING') {
 const commands: Array<{ sql: string; values: unknown[] }> = [];
 const client = { query: async (sql: string, values: unknown[]) => {
  commands.push({ sql, values });
  if (sql.startsWith('SELECT * FROM payment_attempts')) return { rowCount: 1, rows: [{ id: 'attempt', order_id: 'order', estimate_id: 'estimate', amount_cents: '1000', provider_order_id: 'provider', status: attemptStatus }] };
  if (sql.startsWith('SELECT provider_order_id FROM processed_notifications')) return { rowCount: 0, rows: [] };
  return { rowCount: 1, rows: [] };
 } } as unknown as PoolClient;
 return { client, commands };
}
const order = { id: 'provider', external_reference: 'attempt', status: 'processed', status_detail: 'accredited', total_amount: '10.00', total_paid_amount: '10.00', currency: 'BRL', checkout_url: 'https://example.com' } as CheckoutOrder;
test('confirmed matching payment produces one paid event', async () => {
 const { client, commands } = stub(); await reconcile(client, order, 'event');
 assert.equal(commands.find(c => c.sql.startsWith('UPDATE payment_attempts'))?.values[3], 'PAID');
 assert.equal(commands.filter(c => c.sql.startsWith('INSERT INTO outbox')).length, 1);
});
test('pending or underpaid orders never become paid', async () => {
 for (const value of [{ ...order, status: 'created' }, { ...order, total_paid_amount: '9.99' }]) {
  const { client, commands } = stub(); await reconcile(client, value, 'event');
  assert.equal(commands.find(c => c.sql.startsWith('UPDATE payment_attempts'))?.values[3], 'PENDING');
  assert.equal(commands.some(c => c.sql.startsWith('INSERT INTO outbox')), false);
 }
});
test('duplicate paid state never emits a second event', async () => {
 const { client, commands } = stub('PAID'); await reconcile(client, order, 'event');
 assert.equal(commands.some(c => c.sql.startsWith('INSERT INTO outbox')), false);
});
test('mismatched currency or amount rejects the notification', async () => {
 const { client } = stub(); await assert.rejects(reconcile(client, { ...order, currency: 'USD' }, 'event'));
});

test('provider failure remains unpaid and permits a new attempt', async () => {
 const { client, commands } = stub(); await reconcile(client, { ...order, status: 'failed' }, 'event');
 assert.equal(commands.find(c => c.sql.startsWith('UPDATE payment_attempts'))?.values[3], 'FAILED');
 assert.equal(commands.some(c => c.sql.startsWith('INSERT INTO outbox')), false);
});

test('a refunded payment is reversed and emits a reversal event', async () => {
 const { client, commands } = stub('PAID'); await reconcile(client, { ...order, status: 'refunded', status_detail: 'refunded' }, 'event');
 assert.equal(commands.find(c => c.sql.startsWith('UPDATE payment_attempts'))?.values[3], 'REVERSED');
 assert.equal(commands.find(c => c.sql.startsWith('INSERT INTO outbox'))?.values[2], 'payment.reversed');
});
