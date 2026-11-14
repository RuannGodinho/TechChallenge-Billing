import { createHash } from 'node:crypto';
import { IntegrationEvent } from '../../application/ports/integration-event';
export interface ExecutionCompletedEvent extends IntegrationEvent {
    eventType: 'execution.completed';
    data: { orderId: string; executionIds: string[] };
}
export function completionMessageId(orderId: string): string {
    const hex = createHash('sha256').update(`execution-complete:${orderId}`).digest('hex');
    return `${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;
}
export function parseExecutionCompleted(content: Buffer, propertyId: string | undefined): ExecutionCompletedEvent {
    const event = JSON.parse(content.toString('utf8'));
    const objectId = (id: unknown): id is string => typeof id === 'string' && /^[0-9a-f]{24}$/i.test(id);
    if (!event || event.eventType !== 'execution.completed' || event.eventVersion !== 1 || !objectId(event.orderId)
        || event.messageId !== completionMessageId(event.orderId) || propertyId !== event.messageId
        || typeof event.occurredAt !== 'string' || !Number.isFinite(Date.parse(event.occurredAt))
        || !event.data || event.data.orderId !== event.orderId || !Array.isArray(event.data.executionIds)
        || !event.data.executionIds.length || !event.data.executionIds.every(objectId)
        || new Set(event.data.executionIds).size !== event.data.executionIds.length) throw new Error('Invalid execution.completed v1 event');
    return event;
}
