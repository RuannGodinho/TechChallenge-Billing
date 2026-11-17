/* Opt-in broker test. Creates and removes its own vhost; never consumes application queues outside it. */
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
require('ts-node/register/transpile-only');
const amqp = require('amqplib');

const root = path.resolve(process.env.AUDIT_TEST_PROJECT_DIR || path.join(__dirname, '..'));
const { declareTopology, publishConfirmed } = require(path.join(root, 'src/infrastructure/messaging/rabbitmq.ts'));
const broker = new URL(process.env.TEST_RABBITMQ_URL || 'amqp://guest:guest@127.0.0.1:5672');
const management = new URL(process.env.TEST_RABBITMQ_MANAGEMENT_URL || 'http://127.0.0.1:15672');
const user = decodeURIComponent(broker.username);
const password = decodeURIComponent(broker.password);
const vhost = `audit-test-${randomUUID()}`;
let connection, channel, created = false;

async function api(method, resource, body) {
    const response = await fetch(new URL(`/api${resource}`, management), {
        method,
        headers: { authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error(`RabbitMQ management ${method} ${resource}: HTTP ${response.status}`);
    const value = await response.text();
    return value ? JSON.parse(value) : null;
}

async function main() {
    try {
        await api('PUT', `/vhosts/${vhost}`, {});
        created = true;
        await api('PUT', `/permissions/${vhost}/${encodeURIComponent(user)}`, { configure: '.*', write: '.*', read: '.*' });
        broker.pathname = `/${vhost}`;
        connection = await amqp.connect(broker.toString());
        channel = await connection.createConfirmChannel();
        await declareTopology(channel);
        await declareTopology(channel);

        const cases = [
            ['billing.events', 'estimate.created', 'service-orders.billing'],
            ['execution.events', 'execution.completed', 'service-orders.execution'],
            ['saga.commands', 'billing.CriarOrcamento', 'billing.saga.commands'],
            ['saga.commands', 'execution.ReservarEstoque', 'execution.saga.commands'],
            ['saga.results', 'saga.result', 'service-orders.saga.results'],
        ];
        for (const [exchange, eventType, queue] of cases) {
            const auditQueue = `audit.${exchange}`;
            const info = await api('GET', `/queues/${vhost}/${auditQueue}`);
            assert.equal(info.durable, true);
            assert.equal(info.arguments['x-message-ttl'], 86400000);
            const event = { messageId: randomUUID(), eventType, orderId: '000000000000000000000001', occurredAt: new Date().toISOString() };
            const body = Buffer.from(JSON.stringify(event));
            await publishConfirmed(channel, exchange, eventType, body, { messageId: event.messageId, type: eventType });
            const operational = await channel.get(queue, { noAck: false });
            assert.ok(operational);
            assert.equal(operational.properties.messageId, event.messageId);
            channel.ack(operational);
            assert.equal((await channel.checkQueue(queue)).messageCount, 0);

            const audit = await channel.get(auditQueue, { noAck: false });
            assert.ok(audit, 'Audit copy survives operational acknowledgement');
            assert.equal(audit.fields.exchange, exchange);
            assert.equal(audit.fields.routingKey, eventType);
            assert.equal(audit.properties.messageId, event.messageId);
            assert.deepEqual(JSON.parse(audit.content.toString()), event);
            channel.nack(audit, false, true);
            const requeueDeadline = Date.now() + 3000;
            while (!(await channel.checkQueue(auditQueue)).messageCount && Date.now() < requeueDeadline) {
                await new Promise(resolve => setTimeout(resolve, 50));
            }
            assert.equal((await channel.checkQueue(auditQueue)).messageCount, 1, 'Requeue preserves the copy when inspecting');
            const inspected = await channel.get(auditQueue, { noAck: true });
            assert.equal(inspected.properties.messageId, event.messageId);
            console.log(`PASS ${exchange}/${eventType}: operational ACK, retained copy and inspection with requeue`);
        }

        await assert.rejects(publishConfirmed(channel, 'saga.commands', 'unknown.action', Buffer.from('{}'), { messageId: randomUUID() }), /unroutable/);
        console.log('PASS unknown routing keys remain unroutable');

        // Exercise expiration without waiting 24 hours; the policy is isolated to this test vhost.
        await api('PUT', `/policies/${vhost}/test-audit-expiration`, { pattern: '^audit\\.', 'apply-to': 'queues', definition: { 'message-ttl': 100 }, priority: 1 });
        await publishConfirmed(channel, 'billing.events', 'estimate.created', Buffer.from('{}'), { messageId: randomUUID() });
        await new Promise(resolve => setTimeout(resolve, 1000));
        assert.equal(await channel.get('audit.billing.events', { noAck: true }), false);
        assert.ok(await channel.get('service-orders.billing', { noAck: true }), 'Audit expiration must not expire operational messages');
        console.log('PASS audit expiration is independent of operational queues (24h declaration, accelerated test policy)');
    } finally {
        if (channel) await channel.close().catch(() => undefined);
        if (connection) await connection.close().catch(() => undefined);
        if (created) await api('DELETE', `/vhosts/${vhost}`);
    }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
