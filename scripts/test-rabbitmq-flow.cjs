/* Opt-in integration test. Uses temporary databases/vhost. RUN_RABBITMQ_RESTART_TEST=1 also restarts the local broker. */
const {strict:assert}=require('node:assert');
const fs=require('node:fs/promises');
const path=require('node:path');
const {createRequire}=require('node:module');
const {spawn,spawnSync}=require('node:child_process');
const billingRoot=process.env.BILLING_PROJECT_DIR||path.resolve(__dirname,'..');
const executionRoot=process.env.EXECUTION_PROJECT_DIR||path.resolve(billingRoot,'../TechChallenge-Execution');
const ordersRoot=process.env.SERVICE_ORDERS_PROJECT_DIR||path.resolve(billingRoot,'../TechChallenge-Fiap');
const executionRequire=createRequire(path.join(executionRoot,'package.json'));
const billingRequire=createRequire(path.join(billingRoot,'package.json'));
const register=executionRequire.resolve('tsx/cjs');require(register);
const {MongoClient,ObjectId}=executionRequire('mongodb');
const {Pool}=billingRequire('pg');
const amqp=billingRequire('amqplib');
const suffix=`${process.pid}_${Date.now()}`;
const schema=`mq_test_${suffix}`;
const vhost=`mq-test-${suffix}`;
const mongo=new MongoClient(process.env.TEST_EXECUTION_MONGO_URL||'mongodb://127.0.0.1:27018/?directConnection=true');
const ordersDb=mongo.db(`mq_orders_${suffix}`);const executionDb=mongo.db(`mq_execution_${suffix}`);
const workers=new Map();const servers=[];const workerLogs=[];const report=[];
let mongoConnected=false;let admin;let pool;let brokerConnection;let brokerChannel;let brokerStopped=false;let management;let hostRabbitUrl;let vhostCreated=false;
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function checkWorkers(){for(const [name,child] of workers){if(child.exitCode!==null&&!child.expectedStop)throw new Error(`Worker ${name} exited: ${workerLogs.slice(-12).join('\n')}`);}}
async function until(label,fn,timeout=45000){const deadline=Date.now()+timeout;let last;while(Date.now()<deadline){checkWorkers();try{const result=await fn();if(result)return result;}catch(error){last=error;}await pause(150);}throw new Error(`Timeout: ${label}${last?': '+last.message:''}`);}
function pass(label){report.push(label);console.log('PASS: '+label);}
async function listen(app){const server=app.listen(0,'127.0.0.1');servers.push(server);await new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});return `http://127.0.0.1:${server.address().port}`;}
async function stopWorker(name){const child=workers.get(name);if(!child)return;child.expectedStop=true;if(child.exitCode!==null){workers.delete(name);return;}const exited=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),7000);await exited;clearTimeout(timer);workers.delete(name);}
function startWorker(name,root,entry,env){const child=spawn(process.execPath,['--require',register,path.join(root,entry)],{cwd:root,env:{...process.env,...env},stdio:['ignore','pipe','pipe']});workers.set(name,child);for(const stream of [child.stdout,child.stderr])stream.on('data',data=>{workerLogs.push(`${name}: ${data.toString().trim()}`);if(workerLogs.length>80)workerLogs.shift();});return child;}
(async()=>{
 try{
  const raw=await fs.readFile(path.join(billingRoot,'.env'),'utf8');const config=Object.fromEntries(raw.split(/\r?\n/).filter(line=>line.includes('=')&&!line.trim().startsWith('#')).map(line=>{const index=line.indexOf('=');return[line.slice(0,index),line.slice(index+1).trim().replace(/^['"]|['"]$/g,'')];}));
  const user=config.RABBITMQ_USER;const password=config.RABBITMQ_PASSWORD;assert.ok(user&&password,'RabbitMQ credentials configured');
  management=async(method,url,body)=>{const response=await fetch(`http://127.0.0.1:15672/api${url}`,{method,headers:{authorization:'Basic '+Buffer.from(`${user}:${password}`).toString('base64'),'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});if(!response.ok)throw new Error(`Management ${method} ${url}: ${response.status}`);const text=await response.text();return text?JSON.parse(text):null;};
  await management('PUT',`/vhosts/${vhost}`,{});vhostCreated=true;await management('PUT',`/permissions/${vhost}/${encodeURIComponent(user)}`,{configure:'.*',write:'.*',read:'.*'});
  hostRabbitUrl=`amqp://${encodeURIComponent(user)}:${encodeURIComponent(password)}@127.0.0.1:5672/${vhost}`;
  const databaseUrl=new URL(process.env.TEST_BILLING_DATABASE_URL||config.DATABASE_URL);databaseUrl.hostname='127.0.0.1';databaseUrl.port='5433';
  admin=new Pool({connectionString:databaseUrl.toString()});await admin.query(`CREATE SCHEMA ${schema}`);databaseUrl.searchParams.set('options',`-c search_path=${schema}`);
  process.env.DATABASE_URL=databaseUrl.toString();process.env.INTERNAL_API_KEY='mq-integration-key';process.env.JWT_SECRET='mq-integration-jwt';process.env.AUTH_MODE='local';process.env.LOG_LEVEL='silent';
  process.env.EXECUTION_INTERNAL_API_KEY='mq-integration-key';process.env.BILLING_INTERNAL_API_KEY='mq-integration-key';process.env.SERVICE_ORDERS_INTERNAL_API_KEY='mq-integration-key';process.env.EXECUTION_COMPLETION_TRANSPORT='rabbitmq';
  await mongo.connect();mongoConnected=true;const ordersUri=`mongodb://127.0.0.1:27018/${ordersDb.databaseName}?directConnection=true`;const executionUri=`mongodb://127.0.0.1:27018/${executionDb.databaseName}?directConnection=true`;
  process.env.MONGODB_URI=ordersUri;
  pool=require(path.join(billingRoot,'src/db.ts')).pool;
  for(const name of (await fs.readdir(path.join(billingRoot,'migrations'))).filter(name=>name.endsWith('.sql')).sort())await pool.query(await fs.readFile(path.join(billingRoot,'migrations',name),'utf8'));
  const billing=await listen(require(path.join(billingRoot,'src/server.ts')).app);process.env.BILLING_SERVICE_URL=billing;
  await require(path.join(ordersRoot,'src/infrastructure/composition-root/di-container.ts')).DIContainer.getInstance().initialize();
  const orders=await listen(require(path.join(ordersRoot,'app.ts')).default);process.env.SERVICE_ORDERS_URL=orders;
  const execution=await listen(await require(path.join(executionRoot,'src/main/server.ts')).createExecutionApp(executionDb));process.env.EXECUTION_SERVICE_URL=execution;
  const workerEnv={RABBITMQ_URL:hostRabbitUrl,DATABASE_URL:databaseUrl.toString(),MONGODB_URI:ordersUri};
  startWorker('billing-outbox',billingRoot,'src/outbox-worker.ts',workerEnv);
  startWorker('execution-outbox',executionRoot,'src/infrastructure/messaging/execution-publisher.ts',{...workerEnv,MONGODB_URI:executionUri});
  startWorker('billing-projection',ordersRoot,'src/infrastructure/messaging/billing-consumer.ts',workerEnv);
  const startConsumers=()=>{startWorker('orders-execution',ordersRoot,'src/infrastructure/messaging/execution-consumer.ts',workerEnv);startWorker('billing-execution',billingRoot,'src/execution-consumer.ts',workerEnv);};startConsumers();
  const queue=name=>management('GET',`/queues/${vhost}/${encodeURIComponent(name)}`);
  await until('all three subscriptions',async()=>{for(const name of ['service-orders.billing','service-orders.execution','billing.execution'])if((await queue(name)).consumers!==1)return false;return true;});pass('all publisher/consumer processes connected to isolated RabbitMQ vhost');
  brokerConnection=await amqp.connect(hostRabbitUrl);brokerConnection.on('error',()=>{});brokerChannel=await brokerConnection.createConfirmChannel();brokerChannel.on('error',()=>{});
  const {publishConfirmed}=require(path.join(billingRoot,'src/infrastructure/messaging/rabbitmq.ts'));
  const publish=event=>publishConfirmed(brokerChannel,'execution.events','execution.completed',Buffer.from(JSON.stringify(event)),{messageId:event.messageId,type:event.eventType});
  async function api(base,method,url,body,token){const response=await fetch(base+url,{method,headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{'x-internal-api-key':'mq-integration-key'})},body:body===undefined?undefined:JSON.stringify(body)});const text=await response.text();const data=text?JSON.parse(text):null;assert.ok(response.ok,`${method} ${url}: ${response.status} ${text}`);return data;}
  const vehicleId=new ObjectId();await ordersDb.collection('Clientes').insertOne({cpf:'11144477735',nome:'Messaging test',email:'messaging@example.com',telefone:'11999999999',status:'ATIVO'});await ordersDb.collection('Veiculos').insertOne({_id:vehicleId,placa:'ABC1234',modelo:'Messaging',ano:2020,marca:'Test'});
  const {token}=await api(orders,'POST','/api/login',{cpf:'11144477735'});assert.ok(token);
  const service=await api(execution,'POST','/api/servicos',{nome:'Troca de oleo',descricao:'Substituicao',preco:150});const part=await api(execution,'POST','/api/pecas',{nome:'Filtro',descricao:'Filtro de oleo',tipo:'INSUMO',preco:30});await api(execution,'POST','/api/estoque/movimentacoes',{pecaId:part.id,tipo:'ENTRADA',quantidade:10,origem:'compra'});
  async function createOrder(){const order=await api(orders,'POST','/api/ordensServico',{cpfCnpj:'11144477735',veiculoId:vehicleId.toString(),servicos:[service.id]},token);await api(orders,'PUT',`/api/ordensServico/${order.id}`,{status:'EM DIAGNOSTICO'},token);await api(orders,'PUT',`/api/ordensServico/${order.id}`,{pecas:[{pecaId:part.id,quantidade:1}],servicos:[service.id]},token);const [estimate]=await api(billing,'GET',`/api/orcamentos/${order.id}`);await api(billing,'PUT',`/api/orcamentos/${estimate.id}`,{status:'APROVADO'});await api(orders,'PUT',`/api/ordensServico/${order.id}`,{status:'EM EXECUCAO'},token);const [item]=await api(execution,'GET',`/api/execucoes-servico/${order.id}`);await api(execution,'PATCH',`/api/execucoes-servico/${item.id}/iniciar`);return{...order,executionId:item.id};}
  async function finish(order){await api(execution,'PATCH',`/api/execucoes-servico/${order.executionId}/finalizar`);const [outbox]=await executionDb.collection('ExecutionOutbox').find({'event.orderId':order.id}).toArray();assert.ok(outbox,'completion and durable outbox persisted');return outbox.event;}
  async function completed(order){return until('both execution consumers',async()=>{const current=await ordersDb.collection('OrdemServico').findOne({_id:new ObjectId(order.id)});const gate=await pool.query('SELECT * FROM completed_executions WHERE order_id=$1',[order.id]);if(current?.status!=='FINALIZADA'||gate.rowCount!==1)return false;assert.equal(current.statusHistory.filter(entry=>entry.status==='FINALIZADA').length,1);return true;});}
  const first=await createOrder();const event=await finish(first);await completed(first);await until('Billing events projected',async()=>{const row=await ordersDb.collection('OrdemServico').findOne({_id:new ObjectId(first.id)});return row.billingEvents?.some(e=>e.eventType==='estimate.approved');});pass('estimate events and execution completion cross the broker and update both owning databases');
  await publish(event);await publish(event);await until('duplicate messages acknowledged',async()=>(await queue('service-orders.execution')).messages===0&&(await queue('billing.execution')).messages===0);assert.equal(await ordersDb.collection('ExecutionInbox').countDocuments({orderId:first.id}),1);assert.equal((await pool.query('SELECT count(*)::int AS count FROM completed_executions WHERE order_id=$1',[first.id])).rows[0].count,1);await completed(first);pass('duplicate execution events do not duplicate completion or order history');
  await stopWorker('orders-execution');await stopWorker('billing-execution');
  const second=await createOrder();await finish(second);await until('durable queues hold events while consumers are stopped',async()=>(await queue('service-orders.execution')).messages_ready>=1&&(await queue('billing.execution')).messages_ready>=1);assert.equal((await ordersDb.collection('OrdemServico').findOne({_id:new ObjectId(second.id)})).status,'EM EXECUCAO');startConsumers();await completed(second);pass('consumer downtime retains events and resumed consumers catch up');
  await publish({...event,eventVersion:2});await until('invalid events dead-lettered',async()=>(await queue('service-orders.execution.dlq')).messages_ready===1&&(await queue('billing.execution.dlq')).messages_ready===1);pass('invalid event versions are rejected into each consumer DLQ');
  const retryOrder=new ObjectId().toString();const {completionMessageId}=require(path.join(billingRoot,'src/infrastructure/messaging/execution-event.ts'));
  const estimate=await api(billing,'POST','/api/orcamentos',{ordemServicoId:retryOrder,valorTotal:150,pecas:[],servicos:[{id:service.id,nome:'Servico',descricao:'Teste',preco:150}]});await api(billing,'PUT',`/api/orcamentos/${estimate.id}`,{status:'APROVADO'});
  const retryEvent={messageId:completionMessageId(retryOrder),eventType:'execution.completed',eventVersion:1,orderId:retryOrder,occurredAt:new Date().toISOString(),data:{orderId:retryOrder,executionIds:[new ObjectId().toString()]}};await publish(retryEvent);await until('processing failure enters retry handling',async()=>workerLogs.some(line=>line.includes('message_processing_failed')&&line.includes(retryEvent.messageId)));
  await ordersDb.collection('OrdemServico').insertOne({_id:new ObjectId(retryOrder),cpfCnpj:'11144477735',veiculo:vehicleId,status:'EM EXECUCAO',dataAbertura:new Date(),pecas:[],servicos:[new ObjectId(service.id)]});await completed({id:retryOrder});pass('transient processing errors retry through the broker and recover');
  if(process.env.RUN_RABBITMQ_RESTART_TEST==='1'){
   const third=await createOrder();const stopped=spawnSync('docker',['stop','--time','2','oficina-rabbitmq'],{encoding:'utf8'});assert.equal(stopped.status,0,stopped.stderr);brokerStopped=true;await finish(third);assert.equal((await executionDb.collection('ExecutionOutbox').findOne({'event.orderId':third.id})).publishedAt,null);
   const started=spawnSync('docker',['start','oficina-rabbitmq'],{encoding:'utf8'});assert.equal(started.status,0,started.stderr);brokerStopped=false;await until('broker restart',()=>management('GET','/overview'),60000);await completed(third);await until('dead-letter persistence after restart',async()=>(await queue('service-orders.execution.dlq')).messages_ready===1);pass('broker restart preserves queues and publishers recover pending outbox events');
  }
  for(const child of workers.values())assert.equal(child.exitCode,null);
  console.log(JSON.stringify({result:'passed',checks:report.length,isolatedDatabases:true,isolatedVhost:true}));
 }finally{
  if(brokerStopped){spawnSync('docker',['start','oficina-rabbitmq'],{stdio:'ignore'});await pause(10000);}
  for(const name of [...workers.keys()])await stopWorker(name);
  if(brokerChannel)await brokerChannel.close().catch(()=>{});if(brokerConnection)await brokerConnection.close().catch(()=>{});
  for(const server of servers)await new Promise(resolve=>server.close(resolve));
  if(pool)await pool.end();
  const databaseModule=require.cache[require.resolve(path.join(ordersRoot,'src/infrastructure/database.ts'))];if(databaseModule)await databaseModule.exports.closeDatabase();
  if(mongoConnected){try{await ordersDb.dropDatabase();await executionDb.dropDatabase();}finally{await mongo.close();}}
  if(admin){await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();}
  if(vhostCreated)await management('DELETE',`/vhosts/${vhost}`);
 }
})().catch(error=>{console.error(error.stack||error.message);console.error(workerLogs.slice(-15).join('\n'));process.exitCode=1;});
