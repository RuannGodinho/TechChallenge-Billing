import { strict as assert } from 'node:assert';
import { createHmac } from 'node:crypto';
import { MercadoPagoClient, MercadoPagoError, verifyWebhookSignature } from '../src/mercado-pago';

test('validates a webhook signature and rejects tampering', () => {
 const secret = 'test-secret';
 const digest = createHmac('sha256', secret).update('id:ord123;request-id:req-1;ts:12345;').digest('hex');
 assert.equal(verifyWebhookSignature(secret, `ts=12345,v1=${digest}`, 'req-1', 'ORD123'), true);
 assert.equal(verifyWebhookSignature(secret, `ts=12345,v1=${digest}`, 'req-2', 'ORD123'), false);
 assert.equal(verifyWebhookSignature(secret, 'ts=12345,v1=bad', 'req-1', 'ORD123'), false);
});

describe('Mercado Pago provider failures', () => {
 afterEach(() => jest.restoreAllMocks());
 test('fetches an encoded provider order ID with authenticated headers', async () => {
  const fetch = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ id: 'ORD/123', status: 'processed' })));
  expect(await new MercadoPagoClient('test-token').getOrder('ORD/123')).toMatchObject({ id: 'ORD/123', status: 'processed' });
  expect(fetch).toHaveBeenCalledWith('https://api.mercadopago.com/v1/orders/ORD%2F123', expect.objectContaining({
   headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' }, signal: expect.anything(),
  }));
 });
 test('reports network failures as provider unavailability', async () => {
  jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('timeout'));
  await expect(new MercadoPagoClient('test-token').getOrder('provider')).rejects.toBeInstanceOf(MercadoPagoError);
 });
 test('preserves the provider failure status', async () => {
  jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 503 }));
  await expect(new MercadoPagoClient('test-token').getOrder('provider')).rejects.toMatchObject({ name: 'MercadoPagoError', status: 503 });
 });
 test.each(['{', 'null', '"order"', '{"id":1,"status":"created"}', '{"id":"provider"}'])(
  'rejects malformed or incomplete provider payloads: %s', async body => {
   jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body));
   await expect(new MercadoPagoClient('test-token').getOrder('provider')).rejects.toBeInstanceOf(MercadoPagoError);
  });
 test('refuses insecure checkout URLs', async () => {
  jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ id: 'provider', status: 'created', checkout_url: 'http://checkout.test' })));
  await expect(new MercadoPagoClient('test-token').createOrder({ attemptId: 'attempt', idempotencyKey: 'key', amountCents: 1000, items: [] }))
   .rejects.toThrow('invalid checkout URL');
 });
 test.each([0, -1, 1.5])('rejects invalid checkout amounts before contacting the provider: %s', async amountCents => {
  const fetch = jest.spyOn(globalThis, 'fetch');
  await expect(new MercadoPagoClient('test-token').createOrder({ attemptId: 'attempt', idempotencyKey: 'key', amountCents, items: [] })).rejects.toThrow('Invalid amount');
  expect(fetch).not.toHaveBeenCalled();
 });
 test('requires a provider access token', () => expect(() => new MercadoPagoClient('')).toThrow('MERCADO_PAGO_ACCESS_TOKEN is required'));
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
