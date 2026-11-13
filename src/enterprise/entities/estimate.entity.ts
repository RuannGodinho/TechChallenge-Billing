export interface EstimateItem {
    id: string;
    nome: string;
    descricao: string;
    tipo: string | null;
    kind: 'part' | 'service';
    quantidade: number;
    precoCents: number;
}

export interface EstimateInput {
    orderId: string;
    total: number;
    items: EstimateItem[];
}

function cents(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 ||
        !Number.isSafeInteger(Math.round(value * 100)) ||
        Math.abs(value * 100 - Math.round(value * 100)) > 1e-6) {
        throw new Error('invalid monetary value');
    }
    return Math.round(value * 100);
}

export function validateEstimate(body: any): EstimateInput {
    if (typeof body?.ordemServicoId !== 'string' || !body.ordemServicoId.trim() ||
        !Array.isArray(body.pecas) || !Array.isArray(body.servicos) ||
        body.pecas.length + body.servicos.length === 0) {
        throw new Error('invalid estimate');
    }

    let total = 0;
    const rawItems = [
        ...body.pecas.map((item: any) => ({ ...item, kind: 'part' as const })),
        ...body.servicos.map((item: any) => ({ ...item, kind: 'service' as const, quantidade: 1 })),
    ];
    const items: EstimateItem[] = rawItems.map((item: any) => {
        if (!item || typeof item.id !== 'string' || !item.id.trim() ||
            typeof item.nome !== 'string' || !item.nome.trim() || typeof item.descricao !== 'string' ||
            !Number.isSafeInteger(item.quantidade) || item.quantidade <= 0 ||
            (item.kind === 'part' && typeof item.tipo !== 'string')) {
            throw new Error('invalid item');
        }
        const precoCents = cents(item.preco);
        total += precoCents * item.quantidade;
        if (!Number.isSafeInteger(total)) throw new Error('invalid total');
        return { id: item.id, nome: item.nome, descricao: item.descricao, tipo: item.tipo ?? null,
            kind: item.kind, quantidade: item.quantidade, precoCents };
    });
    if (total !== cents(body.valorTotal)) throw new Error('total does not match items');
    return { orderId: body.ordemServicoId.trim(), total, items };
}
