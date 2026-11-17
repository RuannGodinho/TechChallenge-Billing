# Saga orquestrada da preparação da OS

Service Orders coordena a abertura, diagnóstico, orçamento, aprovação, reserva de estoque, preparação e liberação da execução. Billing e Execution continuam com seus bancos e contratos HTTP próprios. Conclusão, pagamento e entrega mantêm o fluxo existente.

## Inicialização

Execute `docker compose up -d --build` em cada repositório, começando pelo Billing, que hospeda o broker local. Cada Compose inicia a Saga dentro do container agrupado `workers`, junto dos demais workers do microsserviço. Configure o mesmo broker e vhost em `RABBITMQ_URL`. As migrations do Billing são automáticas. O MongoDB do Service Orders passa a usar o replica set `orders-rs`, com inicializador idempotente e o volume existente; não remova volumes. Para acesso MongoDB pelo host use `directConnection=true`.

Habilite `SAGA_ENABLED=true` no `.env` do Service Orders após implantar os três participantes. Apenas novas OS usam a Saga. Desabilitar a flag impede novas adesões, mas os workers devem continuar executando para finalizar tentativas existentes.

## API e fluxo

- `POST /api/ordensServico` preserva HTTP 201 e cria OS e Saga atomicamente. Não agenda execuções antecipadamente.
- `PUT /api/ordensServico/:id` preserva HTTP 200. Alterar para `EM DIAGNOSTICO` continua explícito; enviar peças/serviços durante o diagnóstico inicia a criação assíncrona do orçamento. A resposta confirma a gravação local, não a conclusão remota.
- `GET /api/ordensServico/:id/saga` consulta tentativa, etapa, versão, orçamento e prazo, com autenticação existente.
- `POST /api/ordensServico/:id/saga/cancelar` solicita compensação (202). Saga concluída não pode ser cancelada por este fluxo.
- `POST /internal/sagas/:sagaId/retry` retoma intervenção manual, com `x-internal-api-key` do Service Orders. Corrija a causa antes de retomar.
- `Idempotency-Key` opcional na criação e submissão de diagnóstico evita repetição com a mesma chave. Conteúdo divergente retorna conflito. Preserve a chave ao repetir uma requisição.

Decidir o orçamento usa os endpoints atuais do Billing. A aprovação identifica exatamente orçamento, versão e tentativa e dispara automaticamente reserva, preparação e autorização. Só depois o Service Orders grava `EM EXECUCAO` e libera o início. Nenhuma transação fica aberta esperando aprovação ou rede.

Itens ficam imutáveis durante a tentativa; para revisão, cancele, aguarde `COMPENSADA` e envie novos itens. Uma tentativa nova pode ter os mesmos itens da anterior. OS históricas continuam nos fluxos legados.

## Estados e compensações

`AGUARDANDO_DIAGNOSTICO → GERANDO_ORCAMENTO → AGUARDANDO_APROVACAO → RESERVANDO_ESTOQUE → PREPARANDO_EXECUCOES → AUTORIZANDO_EXECUCAO → CONCLUIDA`.

Falha de negócio, rejeição, expiração ou prazo técnico vencido inicia `COMPENSANDO`: cancelar preparação, liberar reserva/estornar baixa, invalidar orçamento elegível. Apenas depois das confirmações a tentativa termina `COMPENSADA` e a OS retorna a `EM DIAGNOSTICO`. Registros de execução cancelada são preservados em `ExecucoesCanceladas`; movimentos compensatórios preservam histórico. Orçamentos rejeitados/expirados não são reescritos como cancelados.

Estoque disponível é quantidade física menos reservado. Todas as peças são reservadas em uma transação. Nenhuma peça é reservada enquanto o cliente decide. Saídas de estoque existentes respeitam as reservas. O início exige lote autorizado e OS liberada pelo coordenador.

Timeout não significa que um comando não foi executado. Cancelamentos persistem mesmo antes da chegada do comando original. Mensagens atrasadas não recriam efeitos de tentativa cancelada. A compensação também é idempotente. Antes da execução física os efeitos de preparação são reversíveis; serviços já realizados não são desfeitos por esta Saga.

Defaults: orçamento válido por sete dias; etapa técnica cinco minutos (`SAGA_STEP_TIMEOUT_MS=300000`); compensação sem confirmação por trinta minutos (`SAGA_COMPENSATION_TIMEOUT_MS=1800000`); verificação a cada cinco segundos. Compensação recusada ou sem confirmação entra em `INTERVENCAO_MANUAL`; não significa rollback concluído.

## Mensagens e recuperação

Exchanges topic duráveis `saga.commands` e `saga.results`. Filas `billing.saga.commands`, `execution.saga.commands`, `service-orders.saga.results`, cada uma com retry e DLQ. Comandos: `billing.CriarOrcamento`, `billing.CancelarOrcamento`, `execution.ReservarEstoque`, `execution.PrepararExecucoes`, `execution.AutorizarExecucao`, `execution.CancelarPreparacao`, `execution.LiberarEstoque`. Resultados usam `saga.result`.

Envelope v1: `messageId`, `eventType`, `eventVersion`, `orderId`, `occurredAt`, `data`. Dados incluem `sagaId`, `attempt`, `commandId`, `commandType`; resultados referenciam o comando original. Decisões incluem `estimateId`, `estimateVersion`, `decision`. Eventos existentes continuam publicados.

Estado, inbox e outbox são confirmados na mesma transação local. Publishers usam confirmação, persistent/mandatory e leases recuperáveis. A Saga usa versão concorrente e índice único de tentativa ativa. Mensagem inválida vai para DLQ; falha de processamento recebe retries. Não purgue filas para corrigir uma Saga.

Inspecione `SagasPreparacao`, `SagaOutbox`, `SagaInbox` no Service Orders; `saga_participations`, `saga_inbox`, `saga_outbox` no Billing; `PreparacoesExecucao`, `SagaInbox`, `SagaOutbox`, estoque e movimentos no Execution. A consulta HTTP expõe estado e erro resumidos, sem snapshots pessoais. Logs de processamento usam fila e messageId; correlacione com as mensagens e a tentativa persistida.

## Validação

Execute typecheck/build, testes e `npm run check:architecture` em cada repo. No Billing, `node scripts/test-saga-flow.cjs` testa bancos temporários e vhost RabbitMQ isolado, removidos ao final. O teste opcional requer os checkouts dos três serviços: configure `BILLING_PROJECT_DIR`, `EXECUTION_PROJECT_DIR`, `SERVICE_ORDERS_PROJECT_DIR` e opcionalmente `BILLING_ENV_FILE`; os serviços em execução não dependem desses caminhos. Ele não gera pagamentos nem modifica OS reais.
