import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { CheckCheckoutEligibilityUseCase } from '../src/application/usecases/check-checkout-eligibility.usecase';
import { PrepareCheckoutUseCase } from '../src/application/usecases/prepare-checkout.usecase';

test('libera checkout apenas para execução e orçamento aprovado correspondentes', () => {
    const useCase = new CheckCheckoutEligibilityUseCase();
    assert.equal(useCase.execute(undefined, { id: 'e1', status: 'APPROVED' }), false);
    assert.equal(useCase.execute('e1', undefined), false);
    assert.equal(useCase.execute('e1', { id: 'e2', status: 'APPROVED' }), false);
    assert.equal(useCase.execute('e1', { id: 'e1', status: 'PENDING' }), false);
    assert.equal(useCase.execute('e1', { id: 'e1', status: 'APPROVED' }), true);
});

test('prepara os itens e valida a resposta do provedor', () => {
    const useCase = new PrepareCheckoutUseCase();
    const checkout = useCase.execute('attempt', 'key', 1250, [{ nome: 'Serviço', quantidade: 1, precoCents: 1250 }]);
    assert.deepEqual(checkout.items, [{ title: 'Serviço', quantity: 1, unit_price: '12.50' }]);
    assert.equal(checkout.idempotencyKey, 'key');
    useCase.validateProviderOrder({ external_reference: 'attempt', total_amount: '12.50', currency: 'BRL' }, 'attempt', 1250);
    assert.throws(() => useCase.validateProviderOrder({ external_reference: 'wrong', total_amount: '12.50', currency: 'BRL' }, 'attempt', 1250));
    assert.throws(() => useCase.validateProviderOrder({ external_reference: 'attempt', total_amount: '12.49', currency: 'BRL' }, 'attempt', 1250));
});
