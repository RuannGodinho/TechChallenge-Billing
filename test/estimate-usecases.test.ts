import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { CheckEstimateApprovalUseCase } from '../src/application/usecases/check-estimate-approval.usecase';
import { DecideEstimateUseCase } from '../src/application/usecases/decide-estimate.usecase';
import { PrepareEstimateUseCase } from '../src/application/usecases/prepare-estimate.usecase';

test('prepara orçamento e mantém hash estável para conteúdo repetido', () => {
    const useCase = new PrepareEstimateUseCase();
    const input = { ordemServicoId: 'o1', valorTotal: 10, pecas: [], servicos: [{ id: 's1', nome: 'Serviço', descricao: '', preco: 10 }] };
    const result = useCase.execute(input);
    assert.equal(result.input.total, 1000);
    assert.equal(result.hash, useCase.execute(input).hash);
    assert.notEqual(result.hash, useCase.execute({ ...input, valorTotal: 11, servicos: [{ ...input.servicos[0], preco: 11 }] }).hash);
    assert.throws(() => useCase.execute({ ...input, valorTotal: 9 }));
});

test('verifica se existe orçamento aprovado', () => {
    const useCase = new CheckEstimateApprovalUseCase();
    assert.equal(useCase.execute(undefined), false);
    assert.equal(useCase.execute({ status: 'PENDING' }), false);
    assert.equal(useCase.execute({ status: 'APPROVED' }), true);
});

test('avalia decisão e repetição de forma independente do banco', () => {
    const useCase = new DecideEstimateUseCase();
    const now = new Date('2026-01-01T00:00:00Z');
    const estimate = { id: 'e1', status: 'PENDING', expiresAt: new Date('2026-01-02T00:00:00Z') };
    assert.equal(useCase.execute(estimate, 'e1', 'APPROVED', now), 'update');
    assert.equal(useCase.execute(estimate, 'e2', 'APPROVED', now), 'superseded');
    assert.equal(useCase.execute({ ...estimate, status: 'APPROVED' }, 'e1', 'APPROVED', now), 'unchanged');
    assert.equal(useCase.execute({ ...estimate, status: 'REJECTED' }, 'e1', 'APPROVED', now), 'unavailable');
    assert.equal(useCase.execute({ ...estimate, expiresAt: now }, 'e1', 'APPROVED', now), 'unavailable');
});
