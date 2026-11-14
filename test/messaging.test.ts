import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { ConfirmChannel } from 'amqplib';
import { PublishOutboxUseCase } from '../src/application/usecases/publish-outbox.usecase';
import { publishConfirmed } from '../src/infrastructure/messaging/rabbitmq';
import { completionMessageId, parseExecutionCompleted } from '../src/infrastructure/messaging/execution-event';
import { ConsumeExecutionCompletedUseCase } from '../src/application/usecases/consume-execution-completed.usecase';
import { RegisterExecutionUseCase } from '../src/application/usecases/register-execution.usecase';
const orderId='0123456789abcdef01234567';
const event={messageId:completionMessageId(orderId),eventType:'execution.completed',eventVersion:1 as const,orderId,occurredAt:new Date().toISOString(),data:{orderId,executionIds:['1123456789abcdef01234567']}};
test('outbox publication failure never marks the event published',async()=>{
 const operations:string[]=[];
 const useCase=new PublishOutboxUseCase({claim:async()=>({id:event.messageId,event}),markPublished:async()=>{operations.push('published');},markFailed:async()=>{operations.push('failed');}},{publish:async()=>{throw new Error('broker unavailable');}});
 await assert.rejects(useCase.execute());assert.deepEqual(operations,['failed']);
});
test('broker returns and confirmation timeouts cannot be mistaken for delivery',async()=>{
 const channel=new EventEmitter() as EventEmitter & {publish:Function};
 channel.publish=(_exchange:string,_key:string,_body:Buffer,options:any,callback:Function)=>{queueMicrotask(()=>{channel.emit('return',{properties:{messageId:options.messageId}});callback(null);});return true;};
 await assert.rejects(publishConfirmed(channel as unknown as ConfirmChannel,'events','missing',Buffer.from('{}'),{messageId:event.messageId}),/unroutable/);
 channel.publish=()=>true;
 await assert.rejects(publishConfirmed(channel as unknown as ConfirmChannel,'events','missing',Buffer.from('{}'),{messageId:event.messageId},10),/timed out/);
});
test('execution event contract rejects identity, version and routing mismatches',()=>{
 assert.equal(parseExecutionCompleted(Buffer.from(JSON.stringify(event)),event.messageId).orderId,orderId);
 for(const bad of [{...event,eventVersion:2},{...event,messageId:'invalid'},{...event,data:{...event.data,orderId:'different'}}]) assert.throws(()=>parseExecutionCompleted(Buffer.from(JSON.stringify(bad)),event.messageId));
});
test('Billing completion consumer forwards stable identity and occurrence time',async()=>{
 let captured:unknown[]=[];
 const useCase=new ConsumeExecutionCompletedUseCase({registerExecution:async(...args)=>{captured=args;return 'ok';}});
 await useCase.execute(event);assert.equal(captured[0],orderId);assert.equal(captured[1],event.messageId);assert.equal((captured[2] as Date).toISOString(),event.occurredAt);
});
test('delayed completion cannot authorize an estimate approved after execution',()=>{
 const now=new Date();const future=new Date(now.getTime()+1000);const useCase=new RegisterExecutionUseCase();
 assert.equal(useCase.canRegister({status:'APPROVED',createdAt:future},now),false);
 assert.equal(useCase.canRegister({status:'APPROVED',createdAt:now,decisionAt:future},now),false);
});
