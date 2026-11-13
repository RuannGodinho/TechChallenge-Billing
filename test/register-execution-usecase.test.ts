import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { RegisterExecutionUseCase } from '../src/application/usecases/register-execution.usecase';

test('identifica execução nova, repetida e conflitante', () => {
    const useCase = new RegisterExecutionUseCase();
    assert.equal(useCase.checkExisting('o1', 'm1', []), 'new');
    assert.equal(useCase.checkExisting('o1', 'm1', [{ order_id: 'o1', message_id: 'm1' }]), 'duplicate');
    assert.equal(useCase.checkExisting('o1', 'm1', [{ order_id: 'o1', message_id: 'm2' }]), 'conflict');
    assert.equal(useCase.checkExisting('o1', 'm1', [{ order_id: 'o2', message_id: 'm1' }]), 'conflict');
});

test('exige orçamento aprovado para registrar conclusão', () => {
    const useCase = new RegisterExecutionUseCase();
    assert.equal(useCase.canRegister(undefined), false);
    assert.equal(useCase.canRegister({ status: 'PENDING' }), false);
    assert.equal(useCase.canRegister({ status: 'APPROVED' }), true);
});
