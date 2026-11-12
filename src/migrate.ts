import { readFile, readdir } from 'node:fs/promises';
import { pool } from './db';
async function main() {
 const client = await pool.connect();
 try {
  await client.query('BEGIN');
  await client.query('SELECT pg_advisory_xact_lock(7102026)');
  await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const files = (await readdir('migrations')).filter(file => /^\d+_[\w-]+\.sql$/.test(file)).sort();
  for (const file of files) {
   const existing = await client.query('SELECT 1 FROM schema_migrations WHERE version=$1', [file]);
   // Older installations stored the first migration without the extension.
   const legacy = file === '001_init.sql' && (await client.query("SELECT 1 FROM schema_migrations WHERE version='001_init'")).rowCount;
   if (!existing.rowCount && !legacy) await client.query(await readFile(`migrations/${file}`, 'utf8'));
   if (!existing.rowCount) await client.query('INSERT INTO schema_migrations(version) VALUES ($1)', [file]);
  }
  await client.query('COMMIT');
 } catch (error) { await client.query('ROLLBACK'); throw error; }
 finally { client.release(); await pool.end(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
