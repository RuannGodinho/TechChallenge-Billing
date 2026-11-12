import nodemailer from 'nodemailer';
import { pool } from './db';

async function run() {
 const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM, ESTIMATE_EMAIL_TO } = process.env;
 if (!process.env.DATABASE_URL || !SMTP_HOST || !SMTP_PORT || !SMTP_FROM || !ESTIMATE_EMAIL_TO) throw new Error('DATABASE_URL, SMTP_HOST, SMTP_PORT, SMTP_FROM and ESTIMATE_EMAIL_TO are required');
 const port = Number(SMTP_PORT);
 if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid SMTP_PORT');
 if (!!SMTP_USER !== !!SMTP_PASS) throw new Error('SMTP_USER and SMTP_PASS must be provided together');
 const transport = nodemailer.createTransport({ host: SMTP_HOST, port, secure: process.env.SMTP_SECURE === 'true', ...(SMTP_USER && SMTP_PASS ? { auth: { user: SMTP_USER, pass: SMTP_PASS } } : {}) });
 let stopping = false;
 process.on('SIGTERM', () => { stopping = true; });
 process.on('SIGINT', () => { stopping = true; });
 while (!stopping) {
  const client = await pool.connect();
  try {
   await client.query('BEGIN');
   const selected = await client.query("SELECT o.id, e.order_id, e.version, e.total_cents, e.items, e.expires_at FROM outbox o JOIN estimates e ON e.id=o.aggregate_id WHERE o.kind='estimate.created' AND o.email_sent_at IS NULL AND o.email_attempts < 10 ORDER BY o.created_at FOR UPDATE OF o SKIP LOCKED LIMIT 1");
   if (!selected.rowCount) { await client.query('COMMIT'); await new Promise(resolve => setTimeout(resolve, 5000)); continue; }
   const row = selected.rows[0];
   const items = (row.items as Array<{ nome: string; quantidade: number; precoCents: number }>).map(item => `${item.nome} x${item.quantidade} - R$ ${(item.precoCents / 100).toFixed(2)}`).join('\n');
   try {
    await transport.sendMail({ from: SMTP_FROM, to: ESTIMATE_EMAIL_TO, subject: `Orçamento ${row.version} - OS ${row.order_id}`, text: `Ordem: ${row.order_id}\n${items}\nTotal: R$ ${(Number(row.total_cents) / 100).toFixed(2)}\nVálido até: ${new Date(row.expires_at).toISOString()}`, messageId: `<estimate-${row.id}@billing.local>` });
    await client.query('UPDATE outbox SET email_sent_at=now(),email_attempts=email_attempts+1,email_last_error=NULL WHERE id=$1', [row.id]);
   } catch (error) {
    console.error('estimate email failed', error);
    await client.query('UPDATE outbox SET email_attempts=email_attempts+1,email_last_error=$2 WHERE id=$1', [row.id, 'SMTP delivery failed']);
   }
   await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); console.error('email worker failed', error); }
  finally { client.release(); }
  await new Promise(resolve => setTimeout(resolve, 5000));
 }
 transport.close();
 await pool.end();
}
run().catch(error => { console.error(error); process.exitCode = 1; });
