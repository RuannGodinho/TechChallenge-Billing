import { EventOutbox, EventPublisher } from '../ports/integration-event';
export class PublishOutboxUseCase {
    constructor(private readonly outbox: EventOutbox, private readonly publisher: EventPublisher) {}
    async execute(): Promise<boolean> {
        const message = await this.outbox.claim();
        if (!message) return false;
        try {
            await this.publisher.publish(message.event);
            await this.outbox.markPublished(message.id);
        } catch (error) {
            await this.outbox.markFailed(message.id, error instanceof Error ? error.message : 'Publication failed');
            throw error;
        }
        return true;
    }
}
