import { Request, Response } from 'express';
import { PaymentWorkflows } from '../../application/usecases/payment-workflows.usecase';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const executionErrors = {
    conflict: [409, 'execution event conflicts with an existing event'],
    approval_required: [409, 'latest approved estimate required'],
    database_unavailable: [503, 'database unavailable'],
    execution_unavailable: [503, 'execution signal unavailable'],
} as const;

const checkoutErrors = {
    database_unavailable: [503, 'database unavailable'],
    preparation_failed: [500, 'checkout preparation failed'],
    wrong_order: [409, 'idempotency key belongs to a different order'],
    approval_required: [409, 'completed execution and latest approved estimate required'],
    attempt_exists: [409, 'an active or paid attempt already exists'],
    provider_conflict: [409, 'provider order conflicts with attempt'],
} as const;

export function createPaymentController(dependencies: {
    workflows: PaymentWorkflows;
    providerConfigured: () => boolean;
    verifyWebhook: (signature: string, requestId: string, dataId: string) => boolean;
}) {
    const { workflows } = dependencies;

    const executionComplete = async (req: Request, res: Response) => {
        const messageId = req.body?.messageId;
        if (!uuid.test(messageId ?? '') || !req.params.id.trim()) {
            return res.status(400).json({ error: 'invalid order or messageId' });
        }
        const result = await workflows.gateway.registerExecution(req.params.id, messageId);
        if (result === 'ok') return res.status(204).end();
        const [status, error] = executionErrors[result];
        return res.status(status).json({ error });
    };

    const checkout = async (req: Request, res: Response) => {
        const key = req.header('idempotency-key');
        if (!key || !uuid.test(key)) return res.status(400).json({ error: 'idempotency-key must be a UUID' });
        if (!dependencies.providerConfigured()) return res.status(503).json({ error: 'payment provider not configured' });

        const result = await workflows.checkout(req.params.id, key);
        if (result.kind === 'success') return res.json(result.payment);
        if (result.kind === 'provider_unavailable') {
            return res.status(502).json({ error: 'checkout unavailable; retry using the same idempotency-key', attemptId: result.attemptId });
        }
        const [status, error] = checkoutErrors[result.kind];
        return res.status(status).json({ error });
    };

    const paymentStatus = async (req: Request, res: Response) => {
        try {
            return res.json({ paid: await workflows.isPaid(req.params.id) });
        } catch (error) {
            console.error('payment status check failed', error);
            return res.status(503).json({ error: 'payment status unavailable' });
        }
    };

    const getPayment = async (req: Request, res: Response) => {
        try {
            const payment = await workflows.gateway.findPayment(req.params.id);
            return payment ? res.json(payment) : res.status(404).json({ error: 'payment attempt not found' });
        } catch {
            return res.status(503).json({ error: 'database unavailable' });
        }
    };

    const reconcileManually = async (req: Request, res: Response) => {
        try {
            const result = await workflows.reconcileManually(req.params.id);
            if (result.kind === 'not_found') return res.status(404).json({ error: 'payment attempt not found' });
            if (result.kind === 'provider_missing') {
                return res.status(409).json({ error: 'provider order not yet recorded; retry checkout using the same idempotency key' });
            }
            return res.json(result.payment);
        } catch (error) {
            console.error('manual payment reconciliation failed', error);
            return res.status(503).json({ error: 'reconciliation unavailable' });
        }
    };

    const mercadoPagoWebhook = async (req: Request, res: Response) => {
        const dataId = typeof req.query['data.id'] === 'string' ? req.query['data.id'] : '';
        const signature = req.header('x-signature') ?? '';
        const requestId = req.header('x-request-id') ?? '';
        if (!dependencies.verifyWebhook(signature, requestId, dataId)) return res.status(401).json({ error: 'invalid signature' });
        if (req.body?.type !== 'order' || !['string', 'number'].includes(typeof req.body?.id)) {
            return res.status(400).json({ error: 'invalid notification' });
        }
        try {
            await workflows.processNotification(dataId, String(req.body.id));
            return res.status(200).end();
        } catch (error) {
            console.error('payment reconciliation failed', error);
            return res.status(503).json({ error: 'reconciliation unavailable' });
        }
    };

    return { executionComplete, checkout, paymentStatus, getPayment, reconcileManually, mercadoPagoWebhook };
}
