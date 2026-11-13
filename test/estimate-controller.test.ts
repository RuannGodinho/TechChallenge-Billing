import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { Request, Response } from 'express';
import { EstimateController } from '../src/Adapters/controllers/estimate.controller';
import { EstimateGatewayPort, EstimateWriteResult } from '../src/application/ports/estimate-gateway.port';

function response() {
    const result = { statusCode: 200, body: undefined as unknown };
    const res = {
        status(code: number) { result.statusCode = code; return res; },
        json(body: unknown) { result.body = body; return res; },
    } as unknown as Response;
    return { res, result };
}

test('controller cria orçamento usando gateway simulado', async () => {
    let receivedOrder = '';
    const gateway: EstimateGatewayPort = {
        async create(input) { receivedOrder = input.orderId; return { kind: 'ok', data: { id: 'estimate-1' }, created: true }; },
        async isApproved() { return false; },
        async decide() { return { kind: 'not_found' }; },
    };
    const controller = new EstimateController(gateway);
    const { res, result } = response();
    const req = { body: { ordemServicoId: 'order-1', valorTotal: 10, pecas: [], servicos: [{ id: 's1', nome: 'Serviço', descricao: '', preco: 10 }] } } as Request;
    await controller.create(req, res);
    assert.equal(receivedOrder, 'order-1');
    assert.equal(result.statusCode, 201);
    assert.deepEqual(result.body, { id: 'estimate-1' });
});

test('controller traduz conflitos de decisão e indisponibilidade', async () => {
    let outcome: EstimateWriteResult = { kind: 'superseded' };
    const gateway: EstimateGatewayPort = {
        async create() { return { kind: 'unavailable' }; },
        async isApproved() { throw new Error('unavailable'); },
        async decide() { return outcome; },
    };
    const controller = new EstimateController(gateway);
    const req = { params: { id: 'estimate-1' }, body: { decision: 'APPROVED' } } as unknown as Request;
    const conflict = response();
    await controller.decide(req, conflict.res);
    assert.equal(conflict.result.statusCode, 409);
    outcome = { kind: 'unavailable' };
    const unavailable = response();
    await controller.decide(req, unavailable.res);
    assert.equal(unavailable.result.statusCode, 503);
});
