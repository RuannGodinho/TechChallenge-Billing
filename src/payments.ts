import { Router, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { PoolClient } from 'pg';
import { pool } from './db';
import { CheckoutOrder, MercadoPagoClient, verifyWebhookSignature } from './mercado-pago';

export const internalPayments = Router();
export const publicPayments = Router();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const provider = () => new MercadoPagoClient(process.env.MERCADO_PAGO_ACCESS_TOKEN ?? '');
const money = (n: number) => (n / 100).toFixed(2);
const matchesAmount = (value: unknown, cents: number): boolean => {
 if (typeof value !== 'string' || !/^\d+(?:\.\d{1,2})?$/.test(value)) return false;
 const [whole, fraction = ''] = value.split('.');
 return BigInt(whole) * 100n + BigInt((fraction + '00').slice(0, 2)) === BigInt(cents);
};

// Only the authenticated order orchestrator should call this after execution has completed.
internalPayments.post('/orders/:id/execution-complete', async (req: Request, res: Response) => {
 const messageId = req.body?.messageId;
 if (!uuid.test(messageId ?? '') || !req.params.id.trim()) return res.status(400).json({ error: 'invalid order or messageId' });
 const client = await pool.connect().catch(() => null);
 if (!client) return res.status(503).json({ error: 'database unavailable' });
 try {
  await client.query('BEGIN');
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [req.params.id]);
  const existing = await client.query('SELECT order_id,message_id FROM completed_executions WHERE order_id=$1 OR message_id=$2', [req.params.id, messageId]);
  if (existing.rowCount) {
   if (existing.rows.some(row => row.order_id !== req.params.id || row.message_id !== messageId)) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'execution event conflicts with an existing event' }); }
   await client.query('COMMIT'); return res.status(204).end();
  }
  const estimate = await client.query('SELECT id,status FROM estimates WHERE order_id=$1 ORDER BY version DESC LIMIT 1', [req.params.id]);
  if (!estimate.rowCount || estimate.rows[0].status !== 'APPROVED') { await client.query('ROLLBACK'); return res.status(409).json({ error: 'latest approved estimate required' }); }
  await client.query('INSERT INTO completed_executions(order_id,message_id,estimate_id) VALUES($1,$2,$3)', [req.params.id, messageId, estimate.rows[0].id]);
  await client.query('COMMIT'); return res.status(204).end();
 } catch (error) { await client.query('ROLLBACK'); console.error('execution signal failed', error); return res.status(503).json({ error: 'execution signal unavailable' }); }
 finally { client.release(); }
});

internalPayments.post('/orders/:id/checkout', async (req: Request, res: Response) => {
 const key = req.header('idempotency-key');
 if (!key || !uuid.test(key)) return res.status(400).json({ error: 'idempotency-key must be a UUID' });
 if (!process.env.MERCADO_PAGO_ACCESS_TOKEN) return res.status(503).json({ error: 'payment provider not configured' });
 const client = await pool.connect().catch(() => null);
 if (!client) return res.status(503).json({ error: 'database unavailable' });
 let attempt: any; let items: any[];
 try {
  await client.query('BEGIN');
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [req.params.id]);
  const existing = await client.query('SELECT p.*, e.items FROM payment_attempts p JOIN estimates e ON e.id=p.estimate_id WHERE p.idempotency_key=$1', [key]);
  if (existing.rowCount) {
   attempt = existing.rows[0];
   if (attempt.order_id !== req.params.id) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'idempotency key belongs to a different order' }); }
  } else {
   const gate = await client.query('SELECT estimate_id FROM completed_executions WHERE order_id=$1', [req.params.id]);
   const estimate = await client.query('SELECT * FROM estimates WHERE order_id=$1 ORDER BY version DESC LIMIT 1', [req.params.id]);
   if (!gate.rowCount || !estimate.rowCount || estimate.rows[0].status !== 'APPROVED' || gate.rows[0]?.estimate_id !== estimate.rows[0].id) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'completed execution and latest approved estimate required' }); }
   const current = await client.query("SELECT id FROM payment_attempts WHERE order_id=$1 AND status IN ('CREATING','PENDING','PAID','REVERSED')", [req.params.id]);
   if (current.rowCount) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'an active or paid attempt already exists' }); }
   const id = randomUUID();
   const inserted = await client.query("INSERT INTO payment_attempts(id,order_id,estimate_id,idempotency_key,amount_cents,status) VALUES($1,$2,$3,$4,$5,'CREATING') RETURNING *", [id,req.params.id,estimate.rows[0].id,key,estimate.rows[0].total_cents]);
   attempt = { ...inserted.rows[0], items: estimate.rows[0].items };
  }
  items = attempt.items;
  await client.query('COMMIT');
 } catch (error) { await client.query('ROLLBACK'); console.error('checkout preparation failed', error); return res.status(500).json({ error: 'checkout preparation failed' }); }
 finally { client.release(); }
 if (attempt.status !== 'CREATING') return res.json({ id: attempt.id, status: attempt.status, checkoutUrl: attempt.checkout_url });
 try {
  const order = await provider().createOrder({ attemptId: attempt.id, idempotencyKey: key, amountCents: Number(attempt.amount_cents), items: items.map(item => ({ title: item.nome, quantity: item.quantidade, unit_price: money(item.precoCents) })) });
  if (order.external_reference !== attempt.id || !matchesAmount(order.total_amount, Number(attempt.amount_cents)) || order.currency !== 'BRL') throw new Error('provider order does not match attempt');
  const updated = await pool.query("UPDATE payment_attempts SET provider_order_id=$2,checkout_url=$3,provider_status=$4,status=CASE WHEN status='CREATING' THEN 'PENDING' ELSE status END,updated_at=now() WHERE id=$1 AND (provider_order_id IS NULL OR provider_order_id=$2) RETURNING id,status,checkout_url", [attempt.id,order.id,order.checkout_url,order.status]);
  if (!updated.rowCount) return res.status(409).json({ error: 'provider order conflicts with attempt' });
  return res.json({ id: updated.rows[0].id, status: updated.rows[0].status, checkoutUrl: updated.rows[0].checkout_url });
 } catch (error) { console.error('checkout provider request failed', error); return res.status(502).json({ error: 'checkout unavailable; retry using the same idempotency-key', attemptId: attempt.id }); }
});

export async function reconcile(client: PoolClient, order: CheckoutOrder, notificationId: string): Promise<void> {
 const result = await client.query('SELECT * FROM payment_attempts WHERE id::text=$1 FOR UPDATE', [order.external_reference]);
 if (!result.rowCount) throw new Error('unknown payment attempt');
 const attempt = result.rows[0];
 if (attempt.provider_order_id && attempt.provider_order_id !== order.id) throw new Error('provider id mismatch');
 if (order.currency !== 'BRL' || !matchesAmount(order.total_amount, Number(attempt.amount_cents))) throw new Error('provider amount or currency mismatch');
 const already = await client.query('SELECT provider_order_id FROM processed_notifications WHERE notification_id=$1', [notificationId]);
 if (already.rowCount) { if (already.rows[0].provider_order_id !== order.id) throw new Error('notification id conflict'); return; }
 // Processed is confirmed only when the authoritative paid total matches the attempt.
 const paid = order.status === 'processed' && order.status_detail === 'accredited' && matchesAmount(order.total_paid_amount, Number(attempt.amount_cents));
 const reversed = order.status === 'refunded' || order.status === 'charged_back' || order.status_detail === 'partially_refunded';
 const nextStatus = attempt.status === 'REVERSED' || reversed ? 'REVERSED' : attempt.status === 'PAID' ? 'PAID' : paid ? 'PAID' : order.status === 'failed' ? 'FAILED' : order.status === 'canceled' ? 'CANCELLED' : ['FAILED', 'CANCELLED'].includes(attempt.status) ? attempt.status : 'PENDING';
 await client.query('UPDATE payment_attempts SET provider_order_id=$2,provider_status=$3,status=$4,updated_at=now() WHERE id=$1', [attempt.id,order.id,order.status,nextStatus]);
 if (nextStatus === 'PAID' && attempt.status !== 'PAID') await client.query('INSERT INTO outbox(id,aggregate_id,kind,payload) VALUES($1,$2,$3,$4)', [randomUUID(),attempt.estimate_id,'payment.confirmed',JSON.stringify({orderId:attempt.order_id,attemptId:attempt.id,estimateId:attempt.estimate_id})]);
 if (nextStatus === 'REVERSED' && attempt.status === 'PAID') await client.query('INSERT INTO outbox(id,aggregate_id,kind,payload) VALUES($1,$2,$3,$4)', [randomUUID(),attempt.estimate_id,'payment.reversed',JSON.stringify({orderId:attempt.order_id,attemptId:attempt.id,estimateId:attempt.estimate_id})]);
 await client.query('INSERT INTO processed_notifications(notification_id,provider_order_id) VALUES($1,$2)', [notificationId,order.id]);
}


// Delivery authorization checks the provider again instead of trusting a stale notification.
internalPayments.get('/orders/:id/payment-status', async (req: Request, res: Response) => {
 try {
  const result = await pool.query("SELECT id,provider_order_id FROM payment_attempts WHERE order_id=$1 AND status='PAID' ORDER BY created_at DESC LIMIT 1", [req.params.id]);
  if (!result.rowCount || !result.rows[0].provider_order_id) return res.json({ paid: false });
  const attempt = result.rows[0]; const order = await provider().getOrder(attempt.provider_order_id);
  if (order.id !== attempt.provider_order_id || order.external_reference !== attempt.id) throw new Error('provider order mismatch');
  const client = await pool.connect();
  try { await client.query('BEGIN'); await reconcile(client,order,`check:${randomUUID()}`); await client.query('COMMIT'); }
  catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  const current = await pool.query('SELECT status FROM payment_attempts WHERE id=$1', [attempt.id]);
  return res.json({ paid: current.rows[0]?.status === 'PAID' && order.status === 'processed' && order.status_detail === 'accredited' });
 } catch (error) { console.error('payment status check failed', error); return res.status(503).json({ error: 'payment status unavailable' }); }
});

internalPayments.get('/payments/:id', async (req: Request, res: Response) => {
 try {
  const result = await pool.query('SELECT id,order_id,estimate_id,status,amount_cents,currency,checkout_url,provider_status FROM payment_attempts WHERE id::text=$1', [req.params.id]);
  return result.rowCount ? res.json(result.rows[0]) : res.status(404).json({ error: 'payment attempt not found' });
 } catch { return res.status(503).json({ error: 'database unavailable' }); }
});

internalPayments.post('/payments/:id/reconcile', async (req: Request, res: Response) => {
 try {
  const attempt = await pool.query('SELECT provider_order_id FROM payment_attempts WHERE id::text=$1', [req.params.id]);
  if (!attempt.rowCount) return res.status(404).json({ error: 'payment attempt not found' });
  if (!attempt.rows[0].provider_order_id) return res.status(409).json({ error: 'provider order not yet recorded; retry checkout using the same idempotency key' });
  const order = await provider().getOrder(attempt.rows[0].provider_order_id);
  if (order.id !== attempt.rows[0].provider_order_id || order.external_reference !== req.params.id) throw new Error('provider order mismatch');
  const client = await pool.connect();
  try { await client.query('BEGIN'); await reconcile(client, order, `manual:${randomUUID()}`); await client.query('COMMIT'); }
  catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  const updated = await pool.query('SELECT id,order_id,status,amount_cents,currency,provider_status FROM payment_attempts WHERE id::text=$1', [req.params.id]);
  return res.json(updated.rows[0]);
 } catch (error) { console.error('manual payment reconciliation failed', error); return res.status(503).json({ error: 'reconciliation unavailable' }); }
});

publicPayments.post('/webhooks/mercado-pago', async (req: Request, res: Response) => {
 const dataId = typeof req.query['data.id'] === 'string' ? req.query['data.id'] : '';
 const signature = req.header('x-signature') ?? ''; const requestId = req.header('x-request-id') ?? '';
 if (!verifyWebhookSignature(process.env.MERCADO_PAGO_WEBHOOK_SECRET ?? '', signature, requestId, dataId)) return res.status(401).json({ error: 'invalid signature' });
 if (req.body?.type !== 'order' || !['string','number'].includes(typeof req.body?.id)) return res.status(400).json({ error: 'invalid notification' });
 const notificationId = String(req.body.id);
 try {
  const order = await provider().getOrder(dataId);
  if (order.id.toLowerCase() !== dataId.toLowerCase() || !order.external_reference) throw new Error('provider order mismatch');
  const client = await pool.connect();
  try { await client.query('BEGIN'); await reconcile(client,order,notificationId); await client.query('COMMIT'); }
  catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  return res.status(200).end();
 } catch (error) { console.error('payment reconciliation failed', error); return res.status(503).json({ error: 'reconciliation unavailable' }); }
});
