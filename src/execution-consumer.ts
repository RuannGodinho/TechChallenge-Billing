import { pool } from './db';
import { PaymentPostgresGateway } from './Adapters/gateways/payment.postgres.gateway';
import { ConsumeExecutionCompletedUseCase } from './application/usecases/consume-execution-completed.usecase';
import { parseExecutionCompleted } from './infrastructure/messaging/execution-event';
import { runConsumer, workerControl } from './infrastructure/messaging/rabbitmq';
async function main() {
    if (!process.env.RABBITMQ_URL || !process.env.DATABASE_URL) throw new Error('RABBITMQ_URL and DATABASE_URL are required');
    const useCase = new ConsumeExecutionCompletedUseCase(new PaymentPostgresGateway(pool));
    try { await runConsumer(process.env.RABBITMQ_URL,'billing.execution',parseExecutionCompleted,event=>useCase.execute(event),workerControl()); }
    finally { await pool.end(); }
}
if (require.main === module) void main().catch(error=>{console.error(error.message);process.exitCode=1;});
