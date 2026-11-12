import { strict as assert } from 'node:assert';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { MercadoPagoClient, verifyWebhookSignature } from '../src/mercado-pago';

test('validates a webhook signature and rejects tampering', () => {
 const secret = 'test-secret';
 const digest = createHmac('sha256', secret).update('id:ord123;request-id:req-1;ts:12345;').digest('hex');
 assert.equal(verifyWebhookSignature(secret, `ts=12345,v1=${digest}`, 'req-1', 'ORD123'), true);
 assert.equal(verifyWebhookSignature(secret, `ts=12345,v1=${digest}`, 'req-2', 'ORD123'), false);
 assert.equal(verifyWebhookSignature(secret, 'ts=12345,v1=bad', 'req-1', 'ORD123'), false);
});

test('checkout request uses the stable attempt id and provider idempotency key', async () => {
 const original = globalThis.fetch;
 let captured: RequestInit | undefined;
 globalThis.fetch = async (_input, options) => {
  captured = options;
  return new Response(JSON.stringify({ id: 'ORD123', status: 'created', checkout_url: 'https://example.com/checkout' }), { status: 201 });
 };
 try {
  const client = new MercadoPagoClient('test-token');
  await client.createOrder({ attemptId: 'attempt-1', idempotencyKey: 'key-1', amountCents: 1234, items: [{ title: 'Service', quantity: 1, unit_price: '12.34' }] });
  assert.equal((captured?.headers as Record<string, string>)['X-Idempotency-Key'], 'key-1');
  assert.equal(JSON.parse(String(captured?.body)).external_reference, 'attempt-1');
  assert.equal(JSON.parse(String(captured?.body)).total_amount, '12.34');
 } finally { globalThis.fetch = original; }
});
