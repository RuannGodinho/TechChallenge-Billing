import { createPaymentController } from '../../Adapters/controllers/payment.controller';
import { PaymentPostgresGateway } from '../../Adapters/gateways/payment.postgres.gateway';
import { PaymentWorkflows } from '../../application/usecases/payment-workflows.usecase';
import { pool } from '../../db';
import { MercadoPagoClient, verifyWebhookSignature } from '../../mercado-pago';

const gateway = new PaymentPostgresGateway(pool);
const workflows = new PaymentWorkflows(gateway, () => new MercadoPagoClient(process.env.MERCADO_PAGO_ACCESS_TOKEN ?? ''));

export const paymentController = createPaymentController({
    workflows,
    providerConfigured: () => !!process.env.MERCADO_PAGO_ACCESS_TOKEN,
    verifyWebhook: (signature, requestId, dataId) =>
        verifyWebhookSignature(process.env.MERCADO_PAGO_WEBHOOK_SECRET ?? '', signature, requestId, dataId),
});
