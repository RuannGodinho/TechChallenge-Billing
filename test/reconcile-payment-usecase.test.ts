import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { ReconcilePaymentUseCase } from '../src/application/usecases/reconcile-payment.usecase';

const useCase = new ReconcilePaymentUseCase();
const attempt = { status: 'PENDING', amountCents: 1000, providerOrderId: 'provider-1' };
const order = { id: 'provider-1', status: 'processed', status_detail: 'accredited', total_amount: '10.00', total_paid_amount: '10.00', currency: 'BRL' };

test('confirma pagamento integral e gera evento uma vez', () => {
    useCase.validate(attempt, order);
    assert.deepEqual(useCase.execute(attempt, order), { status: 'PAID', event: 'payment.confirmed' });
    assert.deepEqual(useCase.execute({ ...attempt, status: 'PAID' }, order), { status: 'PAID', event: null });
});

test('mantém pagamento incompleto pendente', () => {
    assert.deepEqual(useCase.execute(attempt, { ...order, total_paid_amount: '9.99' }), { status: 'PENDING', event: null });
});

test('rejeita dados divergentes do provedor', () => {
    assert.throws(() => useCase.validate(attempt, { ...order, id: 'other' }), /provider id mismatch/);
    assert.throws(() => useCase.validate(attempt, { ...order, currency: 'USD' }), /provider amount or currency mismatch/);
});

test('informa reversão somente ao reverter pagamento confirmado', () => {
    const refunded = { ...order, status: 'refunded' };
    assert.deepEqual(useCase.execute({ ...attempt, status: 'PAID' }, refunded), { status: 'REVERSED', event: 'payment.reversed' });
    assert.deepEqual(useCase.execute({ ...attempt, status: 'REVERSED' }, refunded), { status: 'REVERSED', event: null });
});
