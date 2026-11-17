import { ProcessarComandoSagaUseCase } from '../../application/usecases/participante-saga.usecase';
import { pool } from '../../db';
import { SagaPostgresGateway } from '../../Adapters/gateways/saga.postgres.gateway';
import { parseSaga } from './saga';
import { runConsumer, runOutboxPublisher, workerControl } from './rabbitmq';
async function main() {
    const url = process.env.RABBITMQ_URL;
    if (!url)
        throw Error('RABBITMQ_URL required');
    const control = workerControl();
    const gateway = new SagaPostgresGateway(pool);
    try {
        await Promise.all([runConsumer(url, 'billing.saga.commands', parseSaga, m => new ProcessarComandoSagaUseCase({ execute: message => gateway.execute(message as typeof m) }).execute(m), control), runOutboxPublisher(url, 'saga.results', gateway, control), (async () => { while (!control.stopping) {
                await gateway.expire();
                await new Promise(r => setTimeout(r, 5000));
            } })()]);
    }
    finally {
        await pool.end();
    }
}
if (require.main === module)
    main().catch(e => { console.error(e.message); process.exitCode = 1; });
