import { IntegrationEvent } from '../../application/ports/integration-event';
export interface SagaData extends Record<string, unknown> {
    sagaId: string;
    attempt: number;
    commandId: string;
    commandType: string;
    snapshot?: any;
    estimateId?: string;
    estimateVersion?: number;
    expiresAt?: string;
    ok?: boolean;
    error?: string;
}
export interface SagaMessage extends IntegrationEvent {
    data: SagaData;
}
export const sagaCommands = ['billing.CriarOrcamento', 'billing.CancelarOrcamento', 'execution.ReservarEstoque', 'execution.PrepararExecucoes', 'execution.AutorizarExecucao', 'execution.CancelarPreparacao', 'execution.LiberarEstoque'];
export function parseSaga(raw: Buffer, id?: string): SagaMessage {
    const m = JSON.parse(raw.toString());
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!m || !uuid.test(m.messageId) || m.messageId !== id || m.eventVersion !== 1 || !/^[a-f0-9]{24}$/i.test(m.orderId) || !Number.isFinite(Date.parse(m.occurredAt)) || !m.data || !uuid.test(m.data.sagaId) || !uuid.test(m.data.commandId) || !Number.isSafeInteger(m.data.attempt) || m.data.attempt < 1 || !sagaCommands.includes(m.data.commandType) || !(sagaCommands.includes(m.eventType) || m.eventType === 'saga.result'))
        throw Error('Invalid saga message');
    if (m.eventType !== 'saga.result' && m.eventType !== m.data.commandType) throw Error('Command type mismatch');
    if (m.eventType === 'saga.result' && typeof m.data.ok !== 'boolean') throw Error('Invalid saga result');
    return m;
}
