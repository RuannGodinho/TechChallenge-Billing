export function matchesAmount(value: unknown, cents: number): boolean {
    if (typeof value !== 'string' || !/^\d+(?:\.\d{1,2})?$/.test(value)) return false;
    const [whole, fraction = ''] = value.split('.');
    return BigInt(whole) * 100n + BigInt((fraction + '00').slice(0, 2)) === BigInt(cents);
}

export function determinePaymentStatus(current: string, providerStatus: string, paid: boolean, reversed: boolean): string {
    if (current === 'REVERSED' || reversed) return 'REVERSED';
    if (current === 'PAID' || paid) return 'PAID';
    if (providerStatus === 'failed') return 'FAILED';
    if (providerStatus === 'canceled') return 'CANCELLED';
    if (current === 'FAILED' || current === 'CANCELLED') return current;
    return 'PENDING';
}
