import { randomUUID } from 'node:crypto';
import { Pool, PoolClient } from 'pg';
import { CheckoutAttempt, CheckoutPreparation, CheckoutSummary, ExecutionResult, PaymentGatewayPort } from '../../application/ports/payment-gateway.port';
import { ProviderOrder } from '../../application/ports/payment-provider.port';
import { CheckoutEstimateItem } from '../../application/usecases/prepare-checkout.usecase';
import { CheckCheckoutEligibilityUseCase } from '../../application/usecases/check-checkout-eligibility.usecase';
import { ReconcilePaymentUseCase } from '../../application/usecases/reconcile-payment.usecase';
import { RegisterExecutionUseCase } from '../../application/usecases/register-execution.usecase';

interface AttemptRow {
    id: string;
    order_id: string;
    status: string;
    amount_cents: string;
    checkout_url: string | null;
    items: CheckoutEstimateItem[];
}

const registerExecution = new RegisterExecutionUseCase();
const checkoutEligibility = new CheckCheckoutEligibilityUseCase();
const reconcilePayment = new ReconcilePaymentUseCase();

export class PaymentPostgresGateway implements PaymentGatewayPort {
    constructor(private readonly pool: Pool) {}

    async registerExecution(orderId: string, messageId: string, occurredAt?: Date): Promise<ExecutionResult> {
        const client = await this.pool.connect().catch(() => null);
        if (!client) return 'database_unavailable';
        try {
            await client.query('BEGIN');
            await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [orderId]);
            const existing = await client.query('SELECT order_id,message_id FROM completed_executions WHERE order_id=$1 OR message_id=$2', [orderId, messageId]);
            const state = registerExecution.checkExisting(orderId, messageId, existing.rows);
            if (state === 'conflict') {
                await client.query('ROLLBACK');
                return 'conflict';
            }
            if (state === 'new') {
                const estimate = await client.query('SELECT id,status,created_at,decision_at FROM estimates WHERE order_id=$1 ORDER BY version DESC LIMIT 1', [orderId]);
                if (!registerExecution.canRegister(estimate.rows[0] ? {status:estimate.rows[0].status,createdAt:estimate.rows[0].created_at,decisionAt:estimate.rows[0].decision_at} : undefined, occurredAt)) {
                    await client.query('ROLLBACK');
                    return 'approval_required';
                }
                await client.query('INSERT INTO completed_executions(order_id,message_id,estimate_id) VALUES($1,$2,$3)', [orderId, messageId, estimate.rows[0].id]);
            }
            await client.query('COMMIT');
            return 'ok';
        } catch (error) {
            await client.query('ROLLBACK').catch(() => undefined);
            console.error('execution signal failed', error);
            return 'execution_unavailable';
        } finally {
            client.release();
        }
    }

    async prepareCheckout(orderId: string, key: string): Promise<CheckoutPreparation> {
        const client = await this.pool.connect().catch(() => null);
        if (!client) return { kind: 'database_unavailable' };
        try {
            await client.query('BEGIN');
            await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [orderId]);
            const existing = await client.query<AttemptRow>('SELECT p.*, e.items FROM payment_attempts p JOIN estimates e ON e.id=p.estimate_id WHERE p.idempotency_key=$1', [key]);
            let attempt = existing.rows[0];
            if (attempt) {
                if (attempt.order_id !== orderId) {
                    await client.query('ROLLBACK');
                    return { kind: 'wrong_order' };
                }
            } else {
                const gate = await client.query('SELECT estimate_id FROM completed_executions WHERE order_id=$1', [orderId]);
                const estimate = (await client.query('SELECT * FROM estimates WHERE order_id=$1 ORDER BY version DESC LIMIT 1', [orderId])).rows[0];
                if (!checkoutEligibility.execute(gate.rows[0]?.estimate_id, estimate)) {
                    await client.query('ROLLBACK');
                    return { kind: 'approval_required' };
                }
                const current = await client.query("SELECT id FROM payment_attempts WHERE order_id=$1 AND status IN ('CREATING','PENDING','PAID','REVERSED')", [orderId]);
                if (current.rowCount) {
                    await client.query('ROLLBACK');
                    return { kind: 'attempt_exists' };
                }
                const inserted = await client.query<AttemptRow>("INSERT INTO payment_attempts(id,order_id,estimate_id,idempotency_key,amount_cents,status) VALUES($1,$2,$3,$4,$5,'CREATING') RETURNING *", [randomUUID(), orderId, estimate.id, key, estimate.total_cents]);
                attempt = { ...inserted.rows[0], items: estimate.items };
            }
            const checkout: CheckoutAttempt = {
                id: attempt.id, status: attempt.status, checkoutUrl: attempt.checkout_url,
                amountCents: Number(attempt.amount_cents), items: attempt.items,
            };
            await client.query('COMMIT');
            return { kind: 'ok', attempt: checkout };
        } catch (error) {
            await client.query('ROLLBACK').catch(() => undefined);
            console.error('checkout preparation failed', error);
            return { kind: 'preparation_failed' };
        } finally {
            client.release();
        }
    }

    async saveCheckout(attemptId: string, order: ProviderOrder): Promise<CheckoutSummary | null> {
        const result = await this.pool.query("UPDATE payment_attempts SET provider_order_id=$2,checkout_url=$3,provider_status=$4,status=CASE WHEN status='CREATING' THEN 'PENDING' ELSE status END,updated_at=now() WHERE id=$1 AND (provider_order_id IS NULL OR provider_order_id=$2) RETURNING id,status,checkout_url", [attemptId, order.id, order.checkout_url, order.status]);
        const row = result.rows[0];
        return row ? { id: row.id, status: row.status, checkoutUrl: row.checkout_url } : null;
    }

    async findPaidAttempt(orderId: string) {
        const result = await this.pool.query("SELECT id,provider_order_id FROM payment_attempts WHERE order_id=$1 AND status='PAID' ORDER BY created_at DESC LIMIT 1", [orderId]);
        const row = result.rows[0];
        return row ? { id: row.id as string, providerOrderId: row.provider_order_id as string | null } : null;
    }

    async findPayment(id: string) {
        const result = await this.pool.query('SELECT id,order_id,estimate_id,status,amount_cents,currency,checkout_url,provider_status FROM payment_attempts WHERE id::text=$1', [id]);
        return result.rows[0] ?? null;
    }

    async findProviderReference(id: string) {
        const result = await this.pool.query('SELECT provider_order_id FROM payment_attempts WHERE id::text=$1', [id]);
        const row = result.rows[0];
        return row ? { providerOrderId: row.provider_order_id as string | null } : null;
    }

    async readPaymentStatus(id: string): Promise<string | undefined> {
        const result = await this.pool.query('SELECT status FROM payment_attempts WHERE id=$1', [id]);
        return result.rows[0]?.status;
    }

    async readReconciledPayment(id: string) {
        const result = await this.pool.query('SELECT id,order_id,status,amount_cents,currency,provider_status FROM payment_attempts WHERE id::text=$1', [id]);
        return result.rows[0];
    }

    async reconcile(order: ProviderOrder, notificationId: string): Promise<void> {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            await reconcile(client, order, notificationId);
            await client.query('COMMIT');
        } catch (error) {
            await client.query('ROLLBACK').catch(() => undefined);
            throw error;
        } finally {
            client.release();
        }
    }
}

export async function reconcile(client: PoolClient, order: ProviderOrder, notificationId: string): Promise<void> {
    const result = await client.query('SELECT * FROM payment_attempts WHERE id::text=$1 FOR UPDATE', [order.external_reference]);
    const attempt = result.rows[0];
    if (!attempt) throw new Error('unknown payment attempt');

    const snapshot = { status: attempt.status, amountCents: Number(attempt.amount_cents), providerOrderId: attempt.provider_order_id };
    reconcilePayment.validate(snapshot, order);
    const already = await client.query('SELECT provider_order_id FROM processed_notifications WHERE notification_id=$1', [notificationId]);
    if (already.rowCount) {
        if (already.rows[0].provider_order_id !== order.id) throw new Error('notification id conflict');
        return;
    }

    const { status, event } = reconcilePayment.execute(snapshot, order);
    await client.query('UPDATE payment_attempts SET provider_order_id=$2,provider_status=$3,status=$4,updated_at=now() WHERE id=$1', [attempt.id, order.id, order.status, status]);
    if (event) {
        const payload = JSON.stringify({ orderId: attempt.order_id, attemptId: attempt.id, estimateId: attempt.estimate_id });
        await client.query('INSERT INTO outbox(id,aggregate_id,kind,payload) VALUES($1,$2,$3,$4)', [randomUUID(), attempt.estimate_id, event, payload]);
    }
    await client.query('INSERT INTO processed_notifications(notification_id,provider_order_id) VALUES($1,$2)', [notificationId, order.id]);
}
