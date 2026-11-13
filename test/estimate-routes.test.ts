import { strict as assert } from 'node:assert';
import { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { Server } from 'node:http';
import { app } from '../src/server';

let server: Server;
let baseUrl: string;
const previousKey = process.env.INTERNAL_API_KEY;

before(async () => {
    process.env.INTERNAL_API_KEY = 'test-internal-key';
    server = await new Promise<Server>(resolve => {
        const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
    if (previousKey === undefined) delete process.env.INTERNAL_API_KEY;
    else process.env.INTERNAL_API_KEY = previousKey;
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

test('exige autenticação nas rotas internas', async () => {
    const response = await fetch(`${baseUrl}/internal/estimates`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(response.status, 401);
});

test('rejeita orçamento inválido sem acessar o banco', async () => {
    const response = await fetch(`${baseUrl}/internal/estimates`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-internal-api-key': 'test-internal-key' }, body: '{}',
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'invalid estimate or total' });
});

test('rejeita decisão inválida sem acessar o banco', async () => {
    const response = await fetch(`${baseUrl}/internal/estimates/id/decision`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-internal-api-key': 'test-internal-key' }, body: JSON.stringify({ decision: 'INVALID' }),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'invalid decision' });
});
