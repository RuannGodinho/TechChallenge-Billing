import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { Request, Response } from 'express';
import { PaymentGatewayPort } from '../src/application/ports/payment-gateway.port';
import { PaymentWorkflows } from '../src/application/usecases/payment-workflows.usecase';
import { createPaymentController } from '../src/Adapters/controllers/payment.controller';

const workflows = new PaymentWorkflows({} as PaymentGatewayPort, () => {
    throw new Error('provider must not be called');
});

function response() {
    const result = { statusCode: 200, body: undefined as unknown };
    const res = {
        status(code: number) { result.statusCode = code; return res; },
        json(body: unknown) { result.body = body; return res; },
    } as unknown as Response;
    return { res, result };
}

test('checkout retorna indisponível quando provedor não está configurado', async () => {
    const controller = createPaymentController({
        workflows,
        providerConfigured: () => false,
        verifyWebhook: () => false,
    });
    const req = { header: () => '7a1fb88b-714d-4350-8abb-e437c441ab31' } as unknown as Request;
    const { res, result } = response();
    await controller.checkout(req, res);
    assert.equal(result.statusCode, 503);
    assert.deepEqual(result.body, { error: 'payment provider not configured' });
});

test('webhook rejeita assinatura inválida antes de consultar provedor', async () => {
    const controller = createPaymentController({
        workflows,
        providerConfigured: () => true,
        verifyWebhook: () => false,
    });
    const req = { query: { 'data.id': 'order' }, header: () => 'invalid' } as unknown as Request;
    const { res, result } = response();
    await controller.mercadoPagoWebhook(req, res);
    assert.equal(result.statusCode, 401);
    assert.deepEqual(result.body, { error: 'invalid signature' });
});
