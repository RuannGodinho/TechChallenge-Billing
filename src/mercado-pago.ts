import { createHmac, timingSafeEqual } from 'node:crypto';

export interface CheckoutOrder {
 id: string;
 checkout_url: string;
 status: string;
 status_detail?: string;
 external_reference: string;
 total_amount: string;
 currency: string;
 total_paid_amount?: string;
}
export interface CheckoutItem { title: string; quantity: number; unit_price: string; }

export class MercadoPagoError extends Error {
 constructor(message: string, public readonly status?: number) { super(message); this.name = 'MercadoPagoError'; }
}

/** The same idempotency key and body must be used when retrying a checkout attempt. */
export class MercadoPagoClient {
 constructor(private readonly accessToken: string) {
  if (!accessToken) throw new Error('MERCADO_PAGO_ACCESS_TOKEN is required');
 }
 private async request(path: string, options: RequestInit = {}): Promise<CheckoutOrder> {
  let response: Response;
  try {
   response = await fetch(`https://api.mercadopago.com${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${this.accessToken}`, 'Content-Type': 'application/json', ...(options.headers ?? {}) },
    signal: AbortSignal.timeout(10000),
   });
  } catch { throw new MercadoPagoError('Mercado Pago is unavailable'); }
  if (!response.ok) throw new MercadoPagoError('Mercado Pago request failed', response.status);
  let data: unknown;
  try { data = await response.json(); } catch { throw new MercadoPagoError('Mercado Pago returned invalid JSON'); }
  if (!data || typeof data !== 'object' || typeof (data as CheckoutOrder).id !== 'string' || typeof (data as CheckoutOrder).status !== 'string') throw new MercadoPagoError('Mercado Pago returned an invalid order');
  return data as CheckoutOrder;
 }
 async createOrder(input: { attemptId: string; idempotencyKey: string; amountCents: number; items: CheckoutItem[] }): Promise<CheckoutOrder> {
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) throw new Error('Invalid amount');
  const result = await this.request('/v1/orders', { method: 'POST', headers: { 'X-Idempotency-Key': input.idempotencyKey }, body: JSON.stringify({ type: 'online', processing_mode: 'manual', external_reference: input.attemptId, total_amount: (input.amountCents / 100).toFixed(2), items: input.items }) });
  if (typeof result.checkout_url !== 'string' || !result.checkout_url.startsWith('https://')) throw new MercadoPagoError('Mercado Pago returned an invalid checkout URL');
  return result;
 }
 getOrder(providerOrderId: string): Promise<CheckoutOrder> {
  return this.request(`/v1/orders/${encodeURIComponent(providerOrderId)}`);
 }
}

/** Verify the provider signature before reading authoritative order status. */
export function verifyWebhookSignature(secret: string, signature: string, requestId: string, dataId: string): boolean {
 if (!secret || !signature || !requestId || !dataId) return false;
 const parts = Object.fromEntries(signature.split(',').map(part => part.trim().split('=', 2)));
 if (!parts.ts || !/^\d+$/.test(parts.ts) || !parts.v1 || !/^[0-9a-f]{64}$/i.test(parts.v1)) return false;
 const normalizedId = /^[a-z0-9]+$/i.test(dataId) ? dataId.toLowerCase() : dataId;
 const manifest = `id:${normalizedId};request-id:${requestId};ts:${parts.ts};`;
 const expected = createHmac('sha256', secret).update(manifest).digest();
 const received = Buffer.from(parts.v1, 'hex');
 return received.length === expected.length && timingSafeEqual(received, expected);
}
