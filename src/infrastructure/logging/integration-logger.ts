type Fields = Record<string, unknown>;

function linkingMetadata(): Fields {
    try {
        const agent = require('newrelic') as { getLinkingMetadata?: () => Fields };
        return agent.getLinkingMetadata?.() ?? {};
    } catch {
        return {};
    }
}

/** Log only correlation fields, never an integration message's business payload. */
export function integrationFields(event: unknown): Fields {
    if (!event || typeof event !== 'object') return {};
    const message = event as Fields;
    const data = message.data && typeof message.data === 'object' ? message.data as Fields : {};
    const fields: Fields = {};
    for (const key of ['messageId', 'eventType', 'orderId']) {
        if (typeof message[key] === 'string') fields[key] = message[key];
    }
    for (const key of ['sagaId', 'commandId', 'commandType', 'decision']) {
        if (typeof data[key] === 'string') fields[key] = data[key];
    }
    if (typeof data.attempt === 'number') fields.sagaAttempt = data.attempt;
    if (typeof data.ok === 'boolean') fields.resultOk = data.ok;
    if (typeof data.attemptId === 'string') fields.paymentAttemptId = data.attemptId;
    return fields;
}

export function logIntegration(level: 'info' | 'warn' | 'error', msg: string, fields: Fields = {}): void {
    const record = { ...linkingMetadata(), ...fields, time: new Date().toISOString(), level, service: 'billing', msg };
    console[level](JSON.stringify(record, (key, value: unknown) => {
        if (/authorization|password|^pass$|token|secret|api.?key|x-gateway-trust/i.test(key)) return undefined;
        if (value instanceof Error) {
            return { name: value.name, message: value.message, code: (value as Error & { code?: unknown }).code };
        }
        return value;
    }));
}
