import { randomUUID } from 'node:crypto';
import { PublishOutboxUseCase } from '../src/application/usecases/publish-outbox.usecase';
import { ProcessarComandoSagaUseCase } from '../src/application/usecases/participante-saga.usecase';
import { parseSaga, SagaMessage } from '../src/infrastructure/messaging/saga';

const command: SagaMessage = { messageId: randomUUID(), eventType: 'execution.ReservarEstoque', eventVersion: 1,
    orderId: '000000000000000000000001', occurredAt: '2026-01-01T00:00:00Z',
    data: { sagaId: randomUUID(), commandId: randomUUID(), attempt: 1, commandType: 'execution.ReservarEstoque' } };
test('preserves a validated Saga command and both successful and refused results', () => {
    expect(parseSaga(Buffer.from(JSON.stringify(command)), command.messageId)).toEqual(command);
    for (const ok of [true, false]) {
        const result = { ...command, eventType: 'saga.result', data: { ...command.data, ok } };
        expect(parseSaga(Buffer.from(JSON.stringify(result)), command.messageId)).toEqual(result);
    }
});
test.each([
    { messageId: 'bad' }, { eventVersion: 2 }, { orderId: 'bad' }, { occurredAt: 'bad' }, { data: null },
    { eventType: 'unknown' }, { eventType: 'execution.PrepararExecucoes' },
    ...[{ sagaId: 'bad' }, { commandId: 'bad' }, { attempt: 0 }, { attempt: 1.5 }, { commandType: 'unknown' }]
        .map(data => ({ data: { ...command.data, ...data } })),
    { eventType: 'saga.result', data: { ...command.data } },
])('rejects malformed Saga envelopes and mismatched command identities: %p', patch => {
    expect(() => parseSaga(Buffer.from(JSON.stringify({ ...command, ...patch })), command.messageId)).toThrow();
});
test('rejects malformed JSON and a mismatched broker message ID', () => {
    expect(() => parseSaga(Buffer.from('{'), command.messageId)).toThrow();
    expect(() => parseSaga(Buffer.from(JSON.stringify(command)), randomUUID())).toThrow('Invalid saga message');
});
test('delegates a validated command and propagates participant failures', async () => {
    const participant = { execute: jest.fn().mockResolvedValue(undefined) };
    const useCase = new ProcessarComandoSagaUseCase(participant);
    await useCase.execute(command);
    expect(participant.execute).toHaveBeenCalledWith(command);
    participant.execute.mockRejectedValue(new Error('storage offline'));
    await expect(useCase.execute(command)).rejects.toThrow('storage offline');
});
function outbox() {
    const storage = { claim: jest.fn().mockResolvedValue({ id: command.messageId, event: command }),
        markPublished: jest.fn(), markFailed: jest.fn() };
    const publisher = { publish: jest.fn() };
    return { storage, publisher, useCase: new PublishOutboxUseCase(storage, publisher) };
}
test('does nothing when the outbox has no eligible message', async () => {
    const c = outbox(); c.storage.claim.mockResolvedValue(null);
    expect(await c.useCase.execute()).toBe(false);
    expect(c.publisher.publish).not.toHaveBeenCalled();
});
test('marks only a successfully published message as delivered', async () => {
    const c = outbox();
    expect(await c.useCase.execute()).toBe(true);
    expect(c.publisher.publish).toHaveBeenCalledWith(command);
    expect(c.storage.markPublished).toHaveBeenCalledWith(command.messageId);
    expect(c.publisher.publish.mock.invocationCallOrder[0]).toBeLessThan(c.storage.markPublished.mock.invocationCallOrder[0]);
    expect(c.storage.markFailed).not.toHaveBeenCalled();
});
test.each([new Error('broker offline'), 'unavailable'])('keeps failed publications available for retry: %p', async failure => {
    const c = outbox(); c.publisher.publish.mockRejectedValue(failure);
    await expect(c.useCase.execute()).rejects.toBe(failure);
    expect(c.storage.markPublished).not.toHaveBeenCalled();
    expect(c.storage.markFailed).toHaveBeenCalledWith(command.messageId, failure instanceof Error ? failure.message : 'Publication failed');
});
test('records failure if the lease is lost after publishing', async () => {
    const c = outbox(); c.storage.markPublished.mockRejectedValue(new Error('lease lost'));
    await expect(c.useCase.execute()).rejects.toThrow('lease lost');
    expect(c.storage.markFailed).toHaveBeenCalledWith(command.messageId, 'lease lost');
});
