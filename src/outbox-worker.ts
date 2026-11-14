import { pool } from './db';
import { OutboxPostgresGateway } from './Adapters/gateways/outbox.postgres.gateway';
import { runOutboxPublisher, workerControl } from './infrastructure/messaging/rabbitmq';
async function main() {
    if (!process.env.RABBITMQ_URL || !process.env.DATABASE_URL) throw new Error('RABBITMQ_URL and DATABASE_URL are required');
    try { await runOutboxPublisher(process.env.RABBITMQ_URL, 'billing.events', new OutboxPostgresGateway(pool), workerControl()); }
    finally { await pool.end(); }
}
if (require.main === module) void main().catch(error => { console.error(error.message); process.exitCode=1; });
