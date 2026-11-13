import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { validateEstimate } from '../src/enterprise/entities/estimate.entity';

const estimate = {
    ordemServicoId: 'order-1',
    valorTotal: 35.5,
    pecas: [{ id: 'part-1', nome: 'Peça', descricao: 'Peça de teste', tipo: 'PECA', preco: 10.25, quantidade: 2 }],
    servicos: [{ id: 'service-1', nome: 'Serviço', descricao: 'Serviço de teste', preco: 15 }],
};

test('normaliza itens e calcula valores em centavos', () => {
    const result = validateEstimate(estimate);
    assert.equal(result.orderId, 'order-1');
    assert.equal(result.total, 3550);
    assert.equal(result.items[0].precoCents, 1025);
    assert.equal(result.items[0].quantidade, 2);
    assert.equal(result.items[1].kind, 'service');
    assert.equal(result.items[1].quantidade, 1);
});

test('rejeita total divergente e valores fracionados em centavos', () => {
    assert.throws(() => validateEstimate({ ...estimate, valorTotal: 35 }));
    assert.throws(() => validateEstimate({ ...estimate, valorTotal: 35.501 }));
});

test('rejeita orçamento sem itens ou com quantidade inválida', () => {
    assert.throws(() => validateEstimate({ ...estimate, pecas: [], servicos: [] }));
    assert.throws(() => validateEstimate({ ...estimate, pecas: [{ ...estimate.pecas[0], quantidade: 0 }] }));
});
