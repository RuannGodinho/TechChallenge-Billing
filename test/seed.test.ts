import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
const { seedDatabase } = require(resolve('src/postgres-init/seed.js'));

test('seed is idempotent and preserves an edited estimate without publishing events', { skip: !process.env.TEST_BILLING_PG_URL }, async () => {
  const admin = new Pool({ connectionString: process.env.TEST_BILLING_PG_URL });
  const schema = `seed_${randomUUID().replaceAll('-', '')}`;
  const pool = new Pool({ connectionString: process.env.TEST_BILLING_PG_URL, options: `-c search_path=${schema}` });
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await pool.query(await readFile('migrations/001_init.sql', 'utf8'));
    await Promise.all([seedDatabase(pool), seedDatabase(pool)]);
    const rows = (await pool.query('SELECT * FROM estimates ORDER BY order_id')).rows;
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map(row => Number(row.total_cents)), [36500, 40000]);
    for (const row of rows) {
      assert.equal(Number(row.total_cents), row.items.reduce((sum: number, item: any) => sum + item.precoCents * item.quantidade, 0));
    }
    await pool.query("UPDATE estimates SET status='REJECTED',decision_at=now() WHERE id=$1", [rows[0].id]);
    await seedDatabase(pool);
    assert.equal((await pool.query('SELECT status FROM estimates WHERE id=$1', [rows[0].id])).rows[0].status, 'REJECTED');
    assert.equal(Number((await pool.query('SELECT count(*) FROM estimates')).rows[0].count), 2);
    assert.equal(Number((await pool.query('SELECT count(*) FROM outbox')).rows[0].count), 0);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});
