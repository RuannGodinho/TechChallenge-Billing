export interface IntegrationEvent {
    messageId: string;
    eventType: string;
    eventVersion: 1;
    orderId: string;
    occurredAt: string;
    data: Record<string, unknown>;
}
export interface EventPublisher { publish(event: IntegrationEvent): Promise<void>; }
export interface OutboxMessage { id: string; event: IntegrationEvent; }
export interface EventOutbox {
    claim(): Promise<OutboxMessage | null>;
    markPublished(id: string): Promise<void>;
    markFailed(id: string, error: string): Promise<void>;
}
