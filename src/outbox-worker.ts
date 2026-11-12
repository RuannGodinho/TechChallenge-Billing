import amqp from 'amqplib';
import { pool } from './db';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
let stopping = false;
process.on('SIGTERM', () => { stopping = true; });
process.on('SIGINT', () => { stopping = true; });

async function run(): Promise<void> {
 const url = process.env.RABBITMQ_URL;
 if (!url || !process.env.DATABASE_URL) throw new Error('RABBITMQ_URL and DATABASE_URL are required');
 while (!stopping) {
  let connection: amqp.ChannelModel | undefined;
  try {
   connection = await amqp.connect(url);
   connection.on('error', error => console.error('rabbitmq connection error', error.message));
   let disconnected = false;
   connection.on('close', () => { disconnected = true; });
   const channel = await connection.createConfirmChannel();
   channel.on('error', error => console.error('rabbitmq channel error', error.message));
   channel.on('close', () => { disconnected = true; });
   await channel.assertExchange('billing.events', 'topic', { durable: true });
   await channel.assertExchange('billing.events.dlx', 'direct', { durable: true });
   await channel.assertQueue('service-orders.billing.dlq', { durable: true });
   await channel.bindQueue('service-orders.billing.dlq', 'billing.events.dlx', 'service-orders.billing');
   await channel.assertQueue('service-orders.billing', { durable: true, arguments: { 'x-dead-letter-exchange': 'billing.events.dlx', 'x-dead-letter-routing-key': 'service-orders.billing' } });
   await channel.bindQueue('service-orders.billing', 'billing.events', 'estimate.#');
   await channel.bindQueue('service-orders.billing', 'billing.events', 'payment.#');
   while (!stopping && !disconnected) {
    const client = await pool.connect();
    let found = false;
    try {
     await client.query('BEGIN');
     const result = await client.query('SELECT id,aggregate_id,kind,payload,created_at FROM outbox WHERE published_at IS NULL AND attempts < 10 ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1');
     if (result.rowCount) {
      found = true;
      const row = result.rows[0];
      const message = { messageId: row.id, eventType: row.kind, eventVersion: 1, orderId: row.payload.orderId, occurredAt: row.created_at.toISOString(), data: row.payload };
      try {
       channel.publish('billing.events', row.kind, Buffer.from(JSON.stringify(message)), { persistent: true, contentType: 'application/json', messageId: row.id, type: row.kind });
       await channel.waitForConfirms();
       await client.query('UPDATE outbox SET published_at=now(), attempts=attempts+1 WHERE id=$1', [row.id]);
      } catch (error) {
       console.error('outbox publish failed', error);
       await client.query('UPDATE outbox SET attempts=attempts+1 WHERE id=$1', [row.id]);
       disconnected = true;
      }
     }
     await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); console.error('outbox transaction failed', error); await delay(5000); }
    finally { client.release(); }
    if (!found) await delay(2000);
   }
   await channel.close().catch(() => undefined);
  } catch (error) { console.error('outbox worker connection failed', error); }
  finally { if (connection) await connection.close().catch(() => undefined); }
  if (!stopping) await delay(5000);
 }
 await pool.end();
}
run().catch(error => { console.error(error); process.exitCode = 1; });
