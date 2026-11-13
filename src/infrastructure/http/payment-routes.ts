import { Router } from 'express';
import type { createPaymentController } from '../../Adapters/controllers/payment.controller';
import { paymentController } from '../composition-root/payment-container';

export function createPaymentRoutes(controller: ReturnType<typeof createPaymentController>) {
    const internalPayments = Router();
    const publicPayments = Router();

    internalPayments.post('/orders/:id/execution-complete', controller.executionComplete);
    internalPayments.post('/orders/:id/checkout', controller.checkout);
    internalPayments.get('/orders/:id/payment-status', controller.paymentStatus);
    internalPayments.get('/payments/:id', controller.getPayment);
    internalPayments.post('/payments/:id/reconcile', controller.reconcileManually);
    publicPayments.post('/webhooks/mercado-pago', controller.mercadoPagoWebhook);
    return { internalPayments, publicPayments };
}

export const { internalPayments, publicPayments } = createPaymentRoutes(paymentController);
