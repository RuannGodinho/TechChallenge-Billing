import { integrationFields, logIntegration } from '../src/infrastructure/logging/integration-logger';

const metadata = jest.fn(() => ({ 'trace.id': 'trace-test', 'span.id': 'span-test' }));
jest.mock('newrelic', () => ({ getLinkingMetadata: () => metadata() }), { virtual: true });
afterEach(() => { jest.restoreAllMocks(); metadata.mockClear(); });

test('message correlation excludes the business payload and distinguishes Saga attempts from retries', () => {
    expect(integrationFields({
        messageId: 'message', eventType: 'saga.result', orderId: 'order',
        data: { sagaId: 'saga', commandId: 'command', commandType: 'execution.ReservarEstoque', ok: false, decision: 'REJECTED', attempt: 2, attemptId: 'payment', cpf: 'private', snapshot: { token: 'private' } },
    })).toEqual({ messageId: 'message', eventType: 'saga.result', orderId: 'order', sagaId: 'saga', commandId: 'command', commandType: 'execution.ReservarEstoque', resultOk: false, decision: 'REJECTED', sagaAttempt: 2, paymentAttemptId: 'payment' });
    for (const event of [null, 'invalid', {}, { data: null }]) expect(integrationFields(event)).toEqual({});
});

test('writes one JSON line with APM context and stable service/level/message fields', () => {
    const output = jest.spyOn(console, 'info').mockImplementation(() => undefined);
    logIntegration('info', 'message_processed', { queue: 'work', service: 'override', level: 'override' });
    expect(output).toHaveBeenCalledTimes(1);
    expect(output.mock.calls[0]).toHaveLength(1);
    expect(JSON.parse(output.mock.calls[0][0])).toEqual(expect.objectContaining({
        msg: 'message_processed', service: 'billing', level: 'info', queue: 'work',
        'trace.id': 'trace-test', 'span.id': 'span-test', time: expect.any(String),
    }));
});

test('redacts credentials and serializes an error without SQL parameters or connection details', () => {
    const output = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const error = Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED', query: 'private SQL', parameters: ['private'] });
    logIntegration('error', 'integration_failed', { error, password: 'private', headers: { authorization: 'private', 'x-internal-api-key': 'private' } });
    const record = JSON.parse(output.mock.calls[0][0]);
    expect(record.error).toEqual({ name: 'Error', message: 'connection refused', code: 'ECONNREFUSED' });
    expect(record.headers).toEqual({});
    expect(output.mock.calls[0][0]).not.toContain('private');
});

test('keeps logs working if the optional APM agent fails', () => {
    const output = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    metadata.mockImplementationOnce(() => { throw new Error('agent unavailable'); });
    expect(() => logIntegration('warn', 'retry')).not.toThrow();
    expect(JSON.parse(output.mock.calls[0][0])).toEqual(expect.objectContaining({ msg: 'retry', level: 'warn' }));
});
