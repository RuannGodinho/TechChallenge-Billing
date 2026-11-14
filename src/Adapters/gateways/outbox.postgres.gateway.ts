import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { EventOutbox, IntegrationEvent, OutboxMessage } from '../../application/ports/integration-event';
export class OutboxPostgresGateway implements EventOutbox {
    private readonly owner = randomUUID();
    constructor(private readonly pool: Pool) {}
    async claim(): Promise<OutboxMessage | null> {
        const result = await this.pool.query(`WITH available AS (
            SELECT id FROM outbox WHERE published_at IS NULL AND attempts < 10
            AND next_attempt_at <= now() AND (lease_until IS NULL OR lease_until < now())
            ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1
        ) UPDATE outbox o SET lease_owner=$1,lease_until=now()+interval '30 seconds',attempts=o.attempts+1
          FROM available a WHERE o.id=a.id RETURNING o.*`, [this.owner]);
        const row = result.rows[0];
        if (!row) return null;
        const event: IntegrationEvent = {messageId:row.id,eventType:row.kind,eventVersion:1,orderId:row.payload.orderId,occurredAt:row.created_at.toISOString(),data:row.payload};
        return {id:row.id,event};
    }
    async markPublished(id: string) {
        const result = await this.pool.query('UPDATE outbox SET published_at=now(),lease_owner=NULL,lease_until=NULL,last_error=NULL WHERE id=$1 AND lease_owner=$2', [id,this.owner]);
        if (!result.rowCount) throw new Error('Outbox lease no longer owned');
    }
    async markFailed(id: string, error: string) {
        await this.pool.query("UPDATE outbox SET lease_owner=NULL,lease_until=NULL,last_error=$3,next_attempt_at=now()+LEAST(60,power(2,attempts)::int)*interval '1 second' WHERE id=$1 AND lease_owner=$2", [id,this.owner,error.slice(0,1000)]);
    }
}
