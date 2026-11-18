import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import express from 'express';
import { Pool } from 'pg';
import { createOrcamentoController } from '../src/infrastructure/composition-root/orcamento-container';
import { createOrcamentoRoutes } from '../src/infrastructure/http/orcamento-routes';

const integration = process.env.TEST_BILLING_DATABASE_URL ? describe : describe.skip;

integration('Saga estimate decisions preserve PostgreSQL timestamp precision', () => {
    const connectionString = process.env.TEST_BILLING_DATABASE_URL;
    const schema = `saga_decision_${randomUUID().replace(/-/g, '')}`;
    const admin = new Pool({ connectionString });
    const pool = new Pool({ connectionString, options: `-c search_path=${schema}` });
    const previousKey = process.env.INTERNAL_API_KEY;
    let server: ReturnType<express.Express['listen']>;
    let base: string;

    beforeAll(async () => {
        await admin.query(`CREATE SCHEMA ${schema}`);
        for (const name of (await readdir('migrations')).filter(name => name.endsWith('.sql')).sort()) {
            await pool.query(await readFile(resolve('migrations', name), 'utf8'));
        }
        process.env.INTERNAL_API_KEY = 'saga-decision-test';
        const app = express();
        app.use(express.json());
        app.use('/api', createOrcamentoRoutes(createOrcamentoController(pool)));
        server = app.listen(0, '127.0.0.1');
        await new Promise<void>(done => server.once('listening', done));
        base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterAll(async () => {
        if (server) await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
        await pool.end();
        await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        await admin.end();
        if (previousKey === undefined) delete process.env.INTERNAL_API_KEY;
        else process.env.INTERNAL_API_KEY = previousKey;
    });

    test.each([['APROVADO', 'APPROVED'], ['REPROVADO', 'REJECTED']])('%s succeeds without changing a frozen expiry', async (status, storedStatus) => {
        const id = randomUUID();
        const orderId = randomUUID();
        const item = { id: 'service', kind: 'service', nome: 'Troca', descricao: 'Troca', tipo: null, quantidade: 1, precoCents: 15000 };
        await pool.query("INSERT INTO estimates(id,order_id,version,request_hash,status,total_cents,items,expires_at) VALUES($1,$2,1,$3,'PENDING',15000,$4,date_trunc('milliseconds',now()) + interval '7 days 123 microseconds')", [id, orderId, randomUUID(), JSON.stringify([item])]);
        await pool.query('INSERT INTO saga_participations(saga_id,order_id,attempt,estimate_id) VALUES($1,$2,1,$3)', [randomUUID(), orderId, id]);
        const original = (await pool.query('SELECT expires_at::text AS expiry FROM estimates WHERE id=$1', [id])).rows[0].expiry;
        const decide = () => fetch(`${base}/api/orcamentos/${id}`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json', 'x-internal-api-key': 'saga-decision-test' },
            body: JSON.stringify({ status }),
        });

        const response = await decide();
        const body = await response.json();
        expect({ status: response.status, body }).toMatchObject({ status: 200, body: { status } });
        const replay = await decide();
        expect(replay.status).toBe(200);
        await replay.arrayBuffer();

        const saved = (await pool.query('SELECT status,expires_at::text AS expiry FROM estimates WHERE id=$1', [id])).rows[0];
        expect(saved).toEqual({ status: storedStatus, expiry: original });
        expect((await pool.query('SELECT count(*)::int AS count FROM saga_outbox WHERE event->>\'orderId\'=$1 AND event->\'data\'->>\'decision\'=$2', [orderId, storedStatus])).rows[0].count).toBe(1);
        expect((await pool.query('SELECT count(*)::int AS count FROM outbox WHERE aggregate_id=$1', [id])).rows[0].count).toBe(1);
        await expect(pool.query("UPDATE estimates SET expires_at=expires_at + interval '1 day' WHERE id=$1", [id]))
            .rejects.toMatchObject({ code: '23514', message: 'Orçamento da Saga não pode ser alterado' });
    });
});
