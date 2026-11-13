import { createOrcamentoRoutes, OrcamentoController } from './orcamentos';
import express, { Request, Response, NextFunction } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { pool } from './db';
import { EstimateController } from './Adapters/controllers/estimate.controller';
import { EstimatePostgresGateway } from './Adapters/gateways/estimate.postgres.gateway';
import { createEstimateRoutes } from './infrastructure/http/estimate-routes';
import { createPaymentRoutes } from './infrastructure/http/payment-routes';
import { paymentController } from './infrastructure/composition-root/payment-container';
import { validateEstimate as validate } from './enterprise/entities/estimate.entity';

function auth(req: Request, res: Response, next: NextFunction) {
 const configured = process.env.INTERNAL_API_KEY; const provided = req.header('x-internal-api-key');
 if (!configured || !provided || Buffer.byteLength(configured) !== Buffer.byteLength(provided) || !timingSafeEqual(Buffer.from(configured), Buffer.from(provided))) return res.status(401).json({ error: 'unauthorized' });
 return next();
}
export function createBillingApp(
    payments = paymentController,
    estimates = new EstimateController(new EstimatePostgresGateway(pool)),
) {
    const app = express();
    const { internalPayments, publicPayments } = createPaymentRoutes(payments);
    app.use(express.json({ limit: '128kb' }));
    app.get('/health', (_req, res) => res.json({ status: 'ok' }));
    app.get('/ready', async (_req, res) => {
        try {
            await pool.query('SELECT 1');
            res.json({ status: 'ok' });
        } catch {
            res.status(503).json({ error: 'database unavailable' });
        }
    });
    app.use('/api', createOrcamentoRoutes(new OrcamentoController(pool), (req, res, next) => { void estimates.create(req, res).then(() => undefined).catch(next); }));
    app.use(publicPayments);
    app.use('/internal', auth, internalPayments, createEstimateRoutes(estimates));
    return app;
}

const app = createBillingApp();
const port=Number(process.env.PORT || 3002);
if (require.main === module) { if (!process.env.DATABASE_URL || !process.env.INTERNAL_API_KEY) { console.error('DATABASE_URL and INTERNAL_API_KEY are required'); process.exit(1); } app.listen(port,()=>console.log(`billing listening on ${port}`)); }
export { app, validate };
