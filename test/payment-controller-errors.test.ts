import { Request, Response } from 'express';
import { createPaymentController } from '../src/Adapters/controllers/payment.controller';
import { PaymentWorkflows } from '../src/application/usecases/payment-workflows.usecase';

const key = '7a1fb88b-714d-4350-8abb-e437c441ab31';
function setup() {
    const workflows = {
        gateway: { registerExecution: jest.fn(), findPayment: jest.fn() },
        checkout: jest.fn(), isPaid: jest.fn(), reconcileManually: jest.fn(), processNotification: jest.fn(),
    };
    const verifyWebhook = jest.fn().mockReturnValue(true);
    const controller = createPaymentController({ workflows: workflows as unknown as PaymentWorkflows,
        providerConfigured: () => true, verifyWebhook });
    const request = { params: { id: 'order' }, body: { messageId: key, type: 'order', id: 42 },
        query: { 'data.id': 'provider' }, header: jest.fn().mockReturnValue(key) };
    const response = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis(), end: jest.fn().mockReturnThis() };
    return { workflows, verifyWebhook, controller, request, response,
        req: request as unknown as Request, res: response as unknown as Response };
}
beforeEach(() => jest.spyOn(console, 'error').mockImplementation(() => undefined));
afterEach(() => jest.restoreAllMocks());

test.each([['conflict', 409], ['approval_required', 409], ['database_unavailable', 503], ['execution_unavailable', 503], ['ok', 204]])(
    'maps execution completion outcome %s to HTTP %s', async (result, status) => {
        const c = setup(); c.workflows.gateway.registerExecution.mockResolvedValue(result);
        await c.controller.executionComplete(c.req, c.res);
        expect(c.response.status).toHaveBeenCalledWith(status);
        expect(c.workflows.gateway.registerExecution).toHaveBeenCalledWith('order', key);
    });
test.each([{ messageId: 'invalid' }, { messageId: undefined }])('rejects an invalid execution message before writing: %p', async body => {
    const c = setup(); Object.assign(c.request.body, body);
    await c.controller.executionComplete(c.req, c.res);
    expect(c.response.status).toHaveBeenCalledWith(400);
    expect(c.workflows.gateway.registerExecution).not.toHaveBeenCalled();
});
test('rejects a blank order identity', async () => {
    const c = setup(); c.request.params.id = ' ';
    await c.controller.executionComplete(c.req, c.res);
    expect(c.response.status).toHaveBeenCalledWith(400);
});
test.each([undefined, 'invalid'])('rejects an invalid checkout key: %p', async value => {
    const c = setup(); c.request.header.mockReturnValue(value);
    await c.controller.checkout(c.req, c.res);
    expect(c.response.status).toHaveBeenCalledWith(400);
    expect(c.workflows.checkout).not.toHaveBeenCalled();
});
test.each([
    ['database_unavailable', 503], ['preparation_failed', 500], ['wrong_order', 409],
    ['approval_required', 409], ['attempt_exists', 409], ['provider_conflict', 409], ['provider_unavailable', 502],
])('maps checkout failure %s to HTTP %s', async (kind, status) => {
    const c = setup(); c.workflows.checkout.mockResolvedValue({ kind, attemptId: 'attempt' });
    await c.controller.checkout(c.req, c.res);
    expect(c.response.status).toHaveBeenCalledWith(status);
    if (kind === 'provider_unavailable') expect(c.response.json).toHaveBeenCalledWith(expect.objectContaining({ attemptId: 'attempt' }));
});
test('returns the accepted checkout payment', async () => {
    const c = setup(); c.workflows.checkout.mockResolvedValue({ kind: 'success', payment: { id: 'attempt' } });
    await c.controller.checkout(c.req, c.res);
    expect(c.response.json).toHaveBeenCalledWith({ id: 'attempt' });
});
test('reports payment check failures as unavailable rather than unpaid', async () => {
    const c = setup(); c.workflows.isPaid.mockRejectedValue(new Error('provider down'));
    await c.controller.paymentStatus(c.req, c.res);
    expect(c.response.status).toHaveBeenCalledWith(503);
});
test.each(['found', 'missing', 'database failure'])('handles payment lookup: %s', async outcome => {
    const c = setup();
    if (outcome === 'database failure') c.workflows.gateway.findPayment.mockRejectedValue(new Error('DB down'));
    else c.workflows.gateway.findPayment.mockResolvedValue(outcome === 'found' ? { id: 'attempt' } : null);
    await c.controller.getPayment(c.req, c.res);
    if (outcome === 'found') expect(c.response.json).toHaveBeenCalledWith({ id: 'attempt' });
    else expect(c.response.status).toHaveBeenCalledWith(outcome === 'missing' ? 404 : 503);
});
test.each([['not_found', 404], ['provider_missing', 409], ['error', 503], ['ok', 200]])(
    'handles manual reconciliation outcome %s', async (kind, status) => {
        const c = setup();
        if (kind === 'error') c.workflows.reconcileManually.mockRejectedValue(new Error('unavailable'));
        else c.workflows.reconcileManually.mockResolvedValue({ kind, payment: { status: 'PAID' } });
        await c.controller.reconcileManually(c.req, c.res);
        if (status === 200) expect(c.response.json).toHaveBeenCalledWith({ status: 'PAID' });
        else expect(c.response.status).toHaveBeenCalledWith(status);
    });
test.each([{ type: 'payment', id: 42 }, { type: 'order', id: {} }])('rejects a signed but invalid notification: %p', async body => {
    const c = setup(); c.req.body = body;
    await c.controller.mercadoPagoWebhook(c.req, c.res);
    expect(c.response.status).toHaveBeenCalledWith(400);
    expect(c.workflows.processNotification).not.toHaveBeenCalled();
});
test('does not acknowledge a notification when reconciliation fails', async () => {
    const c = setup(); c.workflows.processNotification.mockRejectedValue(new Error('DB down'));
    c.req.query = {}; c.request.header.mockReturnValue(undefined);
    await c.controller.mercadoPagoWebhook(c.req, c.res);
    expect(c.verifyWebhook).toHaveBeenCalledWith('', '', '');
    expect(c.response.status).toHaveBeenCalledWith(503);
});
