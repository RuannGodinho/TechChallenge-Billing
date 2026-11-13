import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { AddressInfo } from 'node:net';
import express from 'express';
import jwt from 'jsonwebtoken';
import { Pool } from 'pg';
import { createOrcamentoRoutes, presentOrcamento } from '../src/orcamentos';
import { createOrcamentoController } from '../src/infrastructure/composition-root/orcamento-container';

const item = { id: 'service-1', kind: 'service' as const, nome: 'Troca de oleo', descricao: 'Substituicao', tipo: null, quantidade: 1, precoCents: 15000 };
test('preserves the original Portuguese estimate response and currency units', () => {
    const result = presentOrcamento({ id: 'estimate', orderId: 'order', version: 2, status: 'APPROVED', totalCents: 15000, items: [item], expiresAt: new Date(), createdAt: new Date(), decisionAt: null });
    assert.equal(result.status, 'APROVADO'); assert.equal(result.valorTotal, 150); assert.equal(result.versao, 2);
    assert.deepEqual(result.pecas, []); assert.equal(result.itensServicos[0].preco, 150);
});

test('restores legacy estimate HTTP contracts against PostgreSQL', { skip: !process.env.TEST_BILLING_DATABASE_URL }, async () => {
    const connectionString = process.env.TEST_BILLING_DATABASE_URL;
    const admin = new Pool({ connectionString });
    const schema = `endpoint_migration_${process.pid}_${Date.now()}`;
    const pool = new Pool({ connectionString, options: `-c search_path=${schema}` });
    const oldKey = process.env.INTERNAL_API_KEY; const oldJwt = process.env.JWT_SECRET;
    process.env.INTERNAL_API_KEY = 'billing-test'; process.env.JWT_SECRET = 'jwt-test';
    let server: ReturnType<express.Express['listen']> | undefined;
    try {
        await admin.query(`CREATE SCHEMA ${schema}`);
        const migrations = resolve(__dirname, '../../migrations');
        for (const name of (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort()) await pool.query(await readFile(resolve(migrations,name),'utf8'));
        const app = express(); app.use(express.json()); app.use('/api', createOrcamentoRoutes(createOrcamentoController(pool)));
        server = app.listen(0,'127.0.0.1'); await new Promise<void>(done => server!.once('listening',done));
        const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        const headers = { 'x-internal-api-key':'billing-test', 'content-type':'application/json' };
        const call = (path: string, method = 'GET', body?: unknown, auth = headers) => fetch(base+path,{method,headers:auth,body:body === undefined ? undefined : JSON.stringify(body)});
        const order = 'order-1'; const id = randomUUID();
        await pool.query("INSERT INTO estimates(id,order_id,version,request_hash,status,total_cents,items,expires_at) VALUES($1,$2,1,'stable-hash','PENDING',15000,$3,now()+interval '7 days')",[id,order,JSON.stringify([item])]);
        assert.equal((await fetch(base+`/api/orcamentos/${order}`)).status,401);
        const token = jwt.sign({ cpf:'11144477735' },'jwt-test',{expiresIn:'1h'});
        assert.equal((await fetch(base+`/api/orcamentos/${order}`,{headers:{authorization:`Bearer ${token}`}})).status,200);
        assert.equal((await call('/api/orcamentos/missing')).status,404);
        const listed = await (await call(`/api/orcamentos/${order}`)).json() as any[];
        assert.equal(listed[0].valorTotal,150); assert.equal(listed[0].status,'PENDENTE');
        assert.equal((await call(`/api/orcamentos/${id}`,'PUT',{status:'invalid'})).status,400);
        assert.equal((await call(`/api/orcamentos/${id}`,'PUT',{valorTotal:999})).status,400);
        const changed = await call(`/api/orcamentos/${id}`,'PUT',{versao:2,validadeEm:new Date(Date.now()+86400000).toISOString()}); assert.equal(changed.status,200);
        assert.equal((await changed.json() as any).versao,2);
        const approved = await call(`/api/orcamentos/${id}`,'PUT',{status:'APROVADO'}); assert.equal(approved.status,200); assert.equal((await approved.json() as any).status,'APROVADO');
        assert.equal((await call(`/api/orcamentos/${id}`,'PUT',{status:'APROVADO'})).status,200);
        assert.equal((await pool.query('SELECT request_hash FROM estimates WHERE id=$1',[id])).rows[0].request_hash,'stable-hash');
        assert.equal((await pool.query("SELECT count(*)::int AS count FROM outbox WHERE kind='estimate.approved'")).rows[0].count,1);
        assert.equal((await call(`/api/orcamentos/${id}`,'PUT',{status:'REPROVADO'})).status,409);
        const newer = randomUUID();
        await pool.query("INSERT INTO estimates(id,order_id,version,request_hash,status,total_cents,items,expires_at) VALUES($1,$2,3,'newer','PENDING',15000,$3,now()+interval '7 days')",[newer,order,JSON.stringify([item])]);
        assert.equal((await call(`/api/orcamentos/${id}`,'PUT',{status:'APROVADO'})).status,409);
        assert.equal((await (await call(`/api/orcamentos/${order}`)).json() as any[]).length,2);
        await pool.query('INSERT INTO completed_executions(order_id,message_id,estimate_id) VALUES($1,$2,$3)',[order,randomUUID(),newer]);
        assert.equal((await call(`/api/orcamentos/${newer}`,'PUT',{status:'APROVADO'})).status,409);
    } finally {
        if(server) await new Promise<void>((done,reject) => server!.close(error => error ? reject(error) : done()));
        await pool.end(); await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end();
        if(oldKey === undefined) delete process.env.INTERNAL_API_KEY; else process.env.INTERNAL_API_KEY = oldKey;
        if(oldJwt === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = oldJwt;
    }
});
