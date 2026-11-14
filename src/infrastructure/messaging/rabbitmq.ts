import amqp, { Channel, ConfirmChannel, ConsumeMessage, Options } from 'amqplib';
import { IntegrationEvent, EventOutbox } from '../../application/ports/integration-event';
import { PublishOutboxUseCase } from '../../application/usecases/publish-outbox.usecase';

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
export const executionQueues = ['service-orders.execution', 'billing.execution'] as const;
export async function declareTopology(channel: Channel) {
    for (const exchange of ['billing.events', 'execution.events']) {
        await channel.assertExchange(exchange, 'topic', { durable: true });
        await channel.assertExchange(`${exchange}.dlx`, 'direct', { durable: true });
    }
    for (const [queue, exchange, bindings] of [
        ['service-orders.billing', 'billing.events', ['estimate.#', 'payment.#']],
        ['service-orders.execution', 'execution.events', ['execution.completed']],
        ['billing.execution', 'execution.events', ['execution.completed']],
    ] as const) {
        await channel.assertQueue(`${queue}.dlq`, { durable: true });
        await channel.bindQueue(`${queue}.dlq`, `${exchange}.dlx`, queue);
        await channel.assertQueue(queue, { durable: true, arguments: { 'x-dead-letter-exchange': `${exchange}.dlx`, 'x-dead-letter-routing-key': queue } });
        for (const binding of bindings) await channel.bindQueue(queue, exchange, binding);
        await channel.assertQueue(`${queue}.retry`, { durable: true, arguments: { 'x-message-ttl': 1000, 'x-dead-letter-exchange': '', 'x-dead-letter-routing-key': queue } });
    }
}

/** A broker confirm is insufficient when the broker returns an unroutable message. */
export function publishConfirmed(channel: ConfirmChannel, exchange: string, routingKey: string, body: Buffer, options: Options.Publish, timeoutMs = 5000): Promise<void> {
    return new Promise((resolve, reject) => {
        let settled = false;
        let returned = false;
        const finish = (error?: Error | null) => {
            if (settled) return;
            settled = true; clearTimeout(timeout);
            channel.removeListener('return', onReturn); channel.removeListener('close', onClose);
            if (error || returned) reject(error ?? new Error('Message returned as unroutable'));
            else resolve();
        };
        const onReturn = (message: ConsumeMessage) => { if (message.properties.messageId === options.messageId) returned = true; };
        const onClose = () => finish(new Error('Channel closed before publication confirmation'));
        const timeout = setTimeout(() => finish(new Error('Publication confirmation timed out')), timeoutMs);
        channel.on('return', onReturn); channel.once('close', onClose);
        try { channel.publish(exchange, routingKey, body, { ...options, persistent: true, mandatory: true, contentType: 'application/json' }, error => finish(error)); }
        catch (error) { finish(error instanceof Error ? error : new Error('Publication failed')); }
    });
}
function brokerUrl(url: string) {
    const parsed = new URL(url);
    if (!parsed.searchParams.has('heartbeat')) parsed.searchParams.set('heartbeat', '15');
    return parsed.toString();
}
export interface WorkerControl { stopping: boolean; }
export function workerControl(): WorkerControl {
    const control = { stopping: false };
    process.on('SIGINT', () => { control.stopping = true; });
    process.on('SIGTERM', () => { control.stopping = true; });
    return control;
}
export async function runOutboxPublisher(url: string, exchange: string, outbox: EventOutbox, control: WorkerControl) {
    while (!control.stopping) {
        let connection: amqp.ChannelModel | undefined;
        try {
            connection = await amqp.connect(brokerUrl(url));
            let closed = false;
            connection.on('error', error => console.error('rabbitmq_connection_error', error.message));
            connection.on('close', () => { closed = true; });
            const channel = await connection.createConfirmChannel();
            channel.on('error', error => console.error('rabbitmq_channel_error', error.message));
            channel.on('close', () => { closed = true; });
            await declareTopology(channel);
            const useCase = new PublishOutboxUseCase(outbox, { publish: event => publishConfirmed(channel, exchange, event.eventType, Buffer.from(JSON.stringify(event)), { messageId: event.messageId, type: event.eventType }) });
            while (!control.stopping && !closed) if (!await useCase.execute()) await delay(500);
            await channel.close().catch(() => undefined);
        } catch (error) { console.error('outbox_publisher_retry', error instanceof Error ? error.message : 'Publication failed'); }
        finally { if (connection) await connection.close().catch(() => undefined); }
        if (!control.stopping) await delay(1500);
    }
}

export async function runConsumer<T>(url: string, queue: string, parse: (content: Buffer, messageId: string | undefined) => T, handle: (event: T) => Promise<unknown>, control: WorkerControl, maxRetries = 3) {
    while (!control.stopping) {
        let connection: amqp.ChannelModel | undefined;
        try {
            connection = await amqp.connect(brokerUrl(url));
            let closed = false;
            connection.on('error', error => console.error('rabbitmq_connection_error', error.message));
            connection.on('close', () => { closed = true; });
            const channel = await connection.createConfirmChannel();
            channel.on('error', error => console.error('rabbitmq_channel_error', error.message));
            channel.on('close', () => { closed = true; });
            await declareTopology(channel); await channel.prefetch(1);
            let active: Promise<void> = Promise.resolve();
            const processMessage = async (message: ConsumeMessage) => {
                let event: T;
                try { event = parse(message.content, message.properties.messageId); }
                catch (error) {
                    console.error('message_invalid', { queue, messageId: message.properties.messageId, error: error instanceof Error ? error.message : 'Invalid event' });
                    if (!closed) channel.nack(message, false, false);
                    return;
                }
                const attempt = message.properties.headers?.['x-retry-count'] ?? 0;
                if (!Number.isSafeInteger(attempt) || attempt < 0) { if (!closed) channel.nack(message, false, false); return; }
                try {
                    await handle(event);
                    if (!closed) channel.ack(message);
                    console.info('message_processed', { queue, messageId: message.properties.messageId, attempt });
                } catch (error) {
                    console.error('message_processing_failed', { queue, messageId: message.properties.messageId, attempt, error: error instanceof Error ? error.message : 'Processing failed' });
                    if (closed) return;
                    if (attempt >= maxRetries) { channel.nack(message, false, false); return; }
                    await publishConfirmed(channel, '', `${queue}.retry`, message.content, { ...message.properties, headers: { ...message.properties.headers, 'x-retry-count': attempt + 1 } });
                    if (!closed) channel.ack(message);
                }
            };
            const consumer = await channel.consume(queue, message => {
                if (!message) return;
                active = processMessage(message);
                void active.catch(error => {
                    console.error('consumer_channel_retry', error instanceof Error ? error.message : 'Channel failure');
                    void channel.close().catch(() => undefined);
                });
            }, { noAck: false });
            while (!control.stopping && !closed) await delay(250);
            if (!closed) await channel.cancel(consumer.consumerTag);
            await active.catch(() => undefined);
            if (!closed) await channel.close().catch(() => undefined);
        } catch (error) { console.error('consumer_connection_retry', error instanceof Error ? error.message : 'Connection failed'); }
        finally { if (connection) await connection.close().catch(() => undefined); }
        if (!control.stopping) await delay(1500);
    }
}
