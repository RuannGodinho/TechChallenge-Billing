import express, { Request, Response, NextFunction } from 'express';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { pool } from './db';
import { internalPayments, publicPayments } from './payments';

const app = express();
app.use(express.json({ limit: '128kb' }));
app.get('/health', (_req, res) => res.json({ status: 'ok' }));
app.get('/ready', async (_req, res) => { try { await pool.query('SELECT 1'); res.json({ status: 'ok' }); } catch { res.status(503).json({ error: 'database unavailable' }); } });
function auth(req: Request, res: Response, next: NextFunction) {
 const configured = process.env.INTERNAL_API_KEY; const provided = req.header('x-internal-api-key');
 if (!configured || !provided || Buffer.byteLength(configured) !== Buffer.byteLength(provided) || !timingSafeEqual(Buffer.from(configured), Buffer.from(provided))) return res.status(401).json({ error: 'unauthorized' });
 return next();
}
app.use(publicPayments);
app.use('/internal', auth);
app.use('/internal', internalPayments);
function cents(value: unknown): number {
 if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || !Number.isSafeInteger(Math.round(value * 100)) || Math.abs(value * 100 - Math.round(value * 100)) > 1e-6) throw new Error('invalid monetary value');
 return Math.round(value * 100);
}
function validate(body: any) {
 if (typeof body?.ordemServicoId !== 'string' || !body.ordemServicoId.trim() || !Array.isArray(body.pecas) || !Array.isArray(body.servicos) || body.pecas.length + body.servicos.length === 0) throw new Error('invalid estimate');
 let total = 0;
 const items = [...body.pecas.map((item: any) => ({ ...item, kind: 'part' })), ...body.servicos.map((item: any) => ({ ...item, kind: 'service', quantidade: 1 }))].map((item: any) => {
  if (!item || typeof item.id !== 'string' || !item.id.trim() || typeof item.nome !== 'string' || !item.nome.trim() || typeof item.descricao !== 'string' || !Number.isSafeInteger(item.quantidade) || item.quantidade <= 0 || (item.kind === 'part' && typeof item.tipo !== 'string')) throw new Error('invalid item');
  const precoCents = cents(item.preco); total += precoCents * item.quantidade; if (!Number.isSafeInteger(total)) throw new Error('invalid total');
  return { id: item.id, nome: item.nome, descricao: item.descricao, tipo: item.tipo ?? null, kind: item.kind, quantidade: item.quantidade, precoCents };
 });
 if (total !== cents(body.valorTotal)) throw new Error('total does not match items');
 return { orderId: body.ordemServicoId.trim(), total, items };
}
app.post('/internal/estimates', async (req, res) => {
 let input: ReturnType<typeof validate>; try { input = validate(req.body); } catch { return res.status(400).json({ error: 'invalid estimate or total' }); }
 const hash = createHash('sha256').update(JSON.stringify({ total: input.total, items: input.items })).digest('hex');
 const client = await pool.connect().catch(() => null); if (!client) return res.status(503).json({ error: 'database unavailable' });
 try {
  await client.query('BEGIN'); await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [input.orderId]);
  const existing = await client.query('SELECT * FROM estimates WHERE order_id=$1 AND request_hash=$2', [input.orderId,hash]);
  if (existing.rowCount) { await client.query('COMMIT'); return res.status(200).json(existing.rows[0]); }
  const previous = await client.query('SELECT COALESCE(MAX(version),0)::int AS version FROM estimates WHERE order_id=$1', [input.orderId]);
  const id = randomUUID(); const result = await client.query("INSERT INTO estimates(id,order_id,version,request_hash,status,total_cents,items,expires_at) VALUES($1,$2,$3,$4,'PENDING',$5,$6,now()+interval '7 days') RETURNING *",[id,input.orderId,previous.rows[0].version+1,hash,input.total,JSON.stringify(input.items)]);
  await client.query('INSERT INTO outbox(id,aggregate_id,kind,payload) VALUES($1,$2,$3,$4)',[randomUUID(),id,'estimate.created',JSON.stringify({estimateId:id,orderId:input.orderId})]);
  await client.query('COMMIT'); return res.status(201).json(result.rows[0]);
 } catch (error) { await client.query('ROLLBACK'); console.error('estimate creation failed',error); return res.status(500).json({ error:'estimate creation failed' }); } finally { client.release(); }
});
app.get('/internal/orders/:id/estimate-approval', async (req,res) => {
 try { const result=await pool.query('SELECT status,expires_at FROM estimates WHERE order_id=$1 ORDER BY version DESC LIMIT 1',[req.params.id]); const row=result.rows[0]; return res.json({ approved: !!row && row.status === 'APPROVED' }); }
 catch { return res.status(503).json({error:'database unavailable'}); }
});
app.post('/internal/estimates/:id/decision', async (req,res) => {
 if (!['APPROVED','REJECTED'].includes(req.body?.decision)) return res.status(400).json({error:'invalid decision'});
 const client=await pool.connect().catch(()=>null); if(!client) return res.status(503).json({error:'database unavailable'});
 try { await client.query('BEGIN'); const found=await client.query('SELECT * FROM estimates WHERE id::text=$1 FOR UPDATE',[req.params.id]);
 if(!found.rowCount){await client.query('ROLLBACK');return res.status(404).json({error:'estimate not found'});} const row=found.rows[0];
 await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[row.order_id]);
 const latest=await client.query('SELECT id FROM estimates WHERE order_id=$1 ORDER BY version DESC LIMIT 1',[row.order_id]);
 if(latest.rows[0]?.id !== row.id){await client.query('ROLLBACK');return res.status(409).json({error:'estimate superseded'});}
 if(row.status===req.body.decision){await client.query('COMMIT');return res.json(row);}
 if(row.status!=='PENDING' || new Date(row.expires_at).getTime()<=Date.now()){await client.query('ROLLBACK');return res.status(409).json({error:'estimate cannot be decided'});}
 const updated=await client.query('UPDATE estimates SET status=$2,decision_at=now() WHERE id=$1 RETURNING *',[row.id,req.body.decision]);
 await client.query('INSERT INTO outbox(id,aggregate_id,kind,payload) VALUES($1,$2,$3,$4)',[randomUUID(),row.id,`estimate.${req.body.decision.toLowerCase()}`,JSON.stringify({estimateId:row.id,orderId:row.order_id})]);
 await client.query('COMMIT');return res.json(updated.rows[0]);
 } catch(error){await client.query('ROLLBACK');console.error('decision failed',error);return res.status(500).json({error:'decision failed'});}finally{client.release();}
});
const port=Number(process.env.PORT || 3002);
if (require.main === module) { if (!process.env.DATABASE_URL || !process.env.INTERNAL_API_KEY) { console.error('DATABASE_URL and INTERNAL_API_KEY are required'); process.exit(1); } app.listen(port,()=>console.log(`billing listening on ${port}`)); }
export { app, validate };
