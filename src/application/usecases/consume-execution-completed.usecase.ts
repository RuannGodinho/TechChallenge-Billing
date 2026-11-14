import { PaymentGatewayPort } from '../ports/payment-gateway.port';
export class ConsumeExecutionCompletedUseCase {
    constructor(private readonly payments: Pick<PaymentGatewayPort, 'registerExecution'>) {}
    async execute(event: {orderId: string; messageId: string; occurredAt: string}) {
        const result = await this.payments.registerExecution(event.orderId,event.messageId,new Date(event.occurredAt));
        if (result !== 'ok') throw new Error(`Execution completion rejected: ${result}`);
    }
}
