import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import amqp from 'amqplib';
import { runConsumer } from '../src/infrastructure/messaging/rabbitmq';

for (const rejectClose of [false, true]) test(`reconnects after broker cancellation when channel close rejects = ${rejectClose}`, async () => {
    const control = { stopping: false };
    let connectionsOpened = 0, handled = 0, acked = 0, firstConnectionClosed = 0;
    let received!: () => void;
    const arrived = new Promise<void>(resolve => { received = resolve; });
    const message = { content: Buffer.from('{"id":"recovered"}'), properties: { messageId: 'message-id', headers: {} } };
    const connections = [0, 1].map(index => {
        const channel = Object.assign(new EventEmitter(), {
            assertExchange: async () => undefined, assertQueue: async () => undefined, bindQueue: async () => undefined, prefetch: async () => undefined,
            consume: async (_queue: string, callback: Function) => { queueMicrotask(() => callback(index === 0 ? null : message)); return { consumerTag: `consumer-${index}` }; },
            ack: () => { acked++; }, cancel: async () => undefined,
            close: async () => { if (index === 0 && rejectClose) throw new Error('channel already closing'); channel.emit('close'); },
        });
        const connection = Object.assign(new EventEmitter(), {
            createConfirmChannel: async () => channel,
            close: async () => { if (index === 0) firstConnectionClosed++; connection.emit('close'); },
        });
        return connection;
    });
    jest.spyOn(amqp, 'connect').mockImplementation(async () => connections[connectionsOpened++] as unknown as amqp.ChannelModel);
    const timer = setTimeout(() => { control.stopping = true; received(); }, 4000);
    const running = runConsumer('amqp://broker.test/oficina', 'billing.execution', content => JSON.parse(content.toString()), async event => {
        assert.deepEqual(event, { id: 'recovered' }); handled++; control.stopping = true; received();
    }, control);
    try {
        await arrived;
        await running;
        assert.equal(connectionsOpened, 2);
        assert.equal(firstConnectionClosed, 1);
        assert.equal(handled, 1);
        assert.equal(acked, 1);
    } finally {
        clearTimeout(timer);
        control.stopping = true;
        await running;
        jest.restoreAllMocks();
    }
}, 8000);
