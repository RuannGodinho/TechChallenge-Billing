import { OrcamentoSnapshot } from '../../enterprise/entities/orcamento.entity';
const statuses = { PENDING: 'PENDENTE', APPROVED: 'APROVADO', REJECTED: 'REPROVADO', EXPIRED: 'EXPIRADO' };
export function presentOrcamento(row: OrcamentoSnapshot) {
    const presentItem = (item: OrcamentoSnapshot['items'][number]) => ({ id: item.id, nome: item.nome, descricao: item.descricao, preco: item.precoCents / 100, quantidade: item.quantidade, ...(item.kind === 'part' ? { tipo: item.tipo } : {}) });
    return { id: row.id, ordemServicoId: row.orderId, versao: row.version, status: statuses[row.status], valorTotal: row.totalCents / 100, pecas: row.items.filter(item => item.kind === 'part').map(presentItem), itensServicos: row.items.filter(item => item.kind === 'service').map(presentItem), validadeEm: row.expiresAt, criadoEm: row.createdAt };
}
