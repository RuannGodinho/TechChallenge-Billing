import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { Orcamento, OrcamentoSnapshot, OrcamentoRuleError } from '../src/enterprise/entities/orcamento.entity';
import { AtualizarOrcamentoUseCase } from '../src/application/usecases/atualizar-orcamento.usecase';
import { OrcamentoRepository } from '../src/application/ports/orcamento-repository.port';

const now = new Date('2026-01-01T00:00:00Z');
function snapshot(): OrcamentoSnapshot {
    return { id:'estimate',orderId:'order',version:1,status:'PENDING',totalCents:15000,items:[{id:'service',kind:'service',nome:'Servico',descricao:'Descricao',tipo:null,quantidade:1,precoCents:15000}],createdAt:now,expiresAt:new Date(now.getTime()+86400000),decisionAt:null };
}
const context = {latestId:'estimate',blocked:false};
const conflict = (error: unknown) => error instanceof OrcamentoRuleError && error.kind === 'conflict';
test('estimate aggregate rejects expired and superseded decisions without storage', () => {
    assert.throws(() => new Orcamento({...snapshot(),expiresAt:now}).revise({status:'APPROVED'},context,now), conflict);
    assert.throws(() => new Orcamento(snapshot()).revise({status:'APPROVED'},{...context,latestId:'newer'},now), conflict);
});
test('completed execution/payment blocks edits while identical decisions remain idempotent', () => {
    assert.throws(() => new Orcamento(snapshot()).revise({version:2},{...context,blocked:true},now), conflict);
    const approved = {...snapshot(),status:'APPROVED' as const};
    const result = new Orcamento(approved).revise({status:'APPROVED'},{...context,blocked:true},now);
    assert.equal(result.changed,false); assert.equal(result.decisionChanged,false);
});
test('aggregate protects versions and totals even when called without the HTTP parser', () => {
    for(const patch of [{version:0},{totalCents:99}]) assert.throws(() => new Orcamento(snapshot()).revise(patch,context,now), error => error instanceof OrcamentoRuleError && error.kind === 'invalid');
});
test('use case applies domain policy inside an abstract transaction and preserves the original state', async () => {
    const original=snapshot(); let writes=0;
    const repository: OrcamentoRepository = {
        findByOrderId: async () => [original],
        withLockedEstimate: async (_id,_target,operation) => operation({current:original,context,save:async(next,event)=>{writes++;assert.equal(event,true);return next;}}),
    };
    const result=await new AtualizarOrcamentoUseCase(repository,()=>now).execute('estimate',{status:'APROVADO'});
    assert.equal(result?.status,'APPROVED'); assert.equal(result?.decisionAt,now); assert.equal(original.status,'PENDING'); assert.equal(writes,1);
});
