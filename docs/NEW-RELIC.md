# New Relic — APIs e workers

## Cobertura configurada

O operador e o Fluent Bit existentes são mantidos pelo CD do TechChallenge-Fiap. Os três CDs aplicam a Instrumentation do respectivo serviço antes de recriar os pods. Não há nova instalação de agente, pod permanente ou Secret.

| Aplicação APM | Deployments |
| --- | --- |
| techchallenge-orders | api-deployment; service-orders-billing-consumer |
| techchallenge-execution | execution-deployment; execution-workers |
| techchallenge-billing | billing; billing-workers |

A seleção é restrita ao namespace default e aos labels desses deployments. APIs e workers compartilham o nome APM do microsserviço; a UI diferencia transações web e de background. Os processos filhos do supervisor de workers herdam o ambiente de instrumentação. A imagem do agente existente, compatível com o Node 20 das aplicações, é preservada. Novas réplicas criadas pelo HPA também correspondem aos seletores.

O nome explícito pode criar entidades APM com novos nomes em relação ao ambiente anterior; procure pelos três nomes desta tabela. As métricas Kubernetes continuam usando o nome de cluster já configurado: newrelic Cluster.

## Logs e correlação

O Fluent Bit lê somente os containers de API e workers dos seis deployments. Bancos, broker, jobs de seed/migration e agentes não entram nesse filtro. A coleta continua com um DaemonSet por node e os recursos existentes.

O filtro Kubernetes expande logs JSON, copia msg para message e preserva os campos de negócio/correlação na allowlist. O envio de logs pelo agente APM continua desativado para evitar duplicar a coleta do Fluent Bit.

Logs estruturados das integrações incluem service, msg, level e time; eventos de fila também incluem messageId, eventType, orderId e, quando disponíveis, sagaId, commandId, commandType, decision, resultOk e paymentAttemptId. attempt representa retry de consumo; sagaAttempt representa a tentativa da Saga. message_processed inclui durationMs e só é registrado depois de processar e solicitar ACK. message_published é emitido após a confirmação do broker; não substitui o recibo do consumidor.

O agente APM adiciona trace.id, span.id e metadados de entidade quando há contexto disponível. O transporte retorna a Promise de processamento ao callback de consumo, permitindo acompanhar o trabalho assíncrono. Esses campos não são obrigatórios em logs de inicialização ou tarefas sem uma transação ativa. A correlação entre a requisição HTTP original e a publicação posterior por outbox continua sendo feita pelos IDs de negócio; não foi adicionado contexto de tracing persistido à outbox.

Os helpers de logging não registram o payload de negócio das mensagens e removem campos de credenciais. Erros registram nome, mensagem e código, sem parâmetros SQL. Não cole tokens ou senhas nos campos de diagnóstico.

Billing também emite checkout_created/checkout_failed, payment_webhook_processed/payment_webhook_failed, payment_status_failed, payment_reconcile_failed, smtp_sent e smtp_send_failed. Um webhook processado não significa necessariamente pagamento confirmado: valide payment.confirmed e o estado PAID no Billing. Erros inesperados das rotas de orçamento geram estimate_request_failed sem mudar a resposta HTTP.

Métricas internas dedicadas de RabbitMQ e PostgreSQL ficaram fora deste escopo. Há APM das aplicações, chamadas a dependências suportadas pelo agente e métricas Kubernetes dos pods; não há integração específica de filas, conexões ou locks.

## Implantação

1. Após publicar os commits, execute o CD do TechChallenge-Fiap. Ele aplica o bundle, reinicia o DaemonSet de logging para ler o ConfigMap atualizado e aguarda o rollout.
2. Execute os CDs de Execution e Billing. Eles aplicam seus seletores de APM e recriam APIs/workers.
3. Use as rotas reais pelo Gateway e processe uma OS para gerar transações e mensagens. O CD aplica a configuração; a chegada da telemetria deve ser confirmada no New Relic.
4. Observe CPU/memória e reinícios dos workers: vários processos Node no mesmo pod passam a carregar o agente. Não é necessário aumentar réplicas apenas para instrumentar.

Comandos de verificação no cluster, sem mostrar credenciais:

```bash
kubectl get instrumentation -n newrelic
kubectl rollout status daemonset/nri-bundle-newrelic-logging -n newrelic
kubectl get pods -n default
kubectl top pods -n default
```

No describe de um pod novo de cada deployment, confira o init container e as variáveis adicionadas pelo operador. Não compartilhe um dump completo do ambiente se ele contiver credenciais.

## Verificações no painel

Gere tráfego e selecione um período que inclua o teste. A ausência de transações sem tráfego não comprova erro de configuração.

APM das três aplicações:

```sql
FROM Transaction
SELECT count(*), average(duration) * 1000 AS 'duracao_media_ms'
WHERE appName IN ('techchallenge-orders', 'techchallenge-execution', 'techchallenge-billing')
FACET appName
SINCE 30 minutes ago
```

No APM de cada aplicação, confira também as transações de background/message após consumir eventos RabbitMQ. Os workers não atendem HTTP e não devem aparecer somente na lista de transações web.

Cobertura de logs dos pods:

```sql
FROM Log
SELECT count(*)
WHERE namespace_name = 'default'
FACET pod_name
SINCE 30 minutes ago
LIMIT MAX
```

Após executar uma OS, devem aparecer pods das três APIs e dos três grupos de workers. Logs antigos anteriores ao deploy não passam a ser coletados retroativamente.

Histórico de uma OS:

```sql
FROM Log
SELECT *
WHERE orderId = 'COLE_ID_DA_OS' OR ordemServicoId = 'COLE_ID_DA_OS'
SINCE 30 minutes ago
LIMIT 200
```

Uma resposta negativa de negócio pode ser processada corretamente pelo transporte. Para localizar recusas dos participantes da Saga:

```sql
FROM Log
SELECT *
WHERE eventType = 'saga.result' AND resultOk = false
SINCE 30 minutes ago
LIMIT 200
```

Falhas e tempo de processamento das filas:

```sql
FROM Log
SELECT count(*)
WHERE message = 'message_processing_failed' OR message = 'message_invalid'
FACET service, queue
SINCE 30 minutes ago
```

```sql
FROM Log
SELECT average(durationMs), percentile(durationMs, 95)
WHERE message = 'message_processed'
FACET service, queue
SINCE 30 minutes ago
```

Pagamento e SMTP:

```sql
FROM Log
SELECT *
WHERE service = 'billing'
  AND (message LIKE 'checkout_%' OR message LIKE 'payment_%' OR message LIKE 'smtp_%')
SINCE 30 minutes ago
LIMIT 200
```

Para confirmar alertas ou dashboards, crie-os na UI após verificar que esses campos estão chegando. Os manifests não criam alertas ou dashboards no account New Relic.

Referências: [APM auto-attach](https://docs.newrelic.com/docs/kubernetes-pixie/kubernetes-integration/installation/k8s-agent-operator/), [Node.js e filas](https://docs.newrelic.com/docs/apm/agents/nodejs-agent/extend-your-instrumentation/message-queues/), [filtro Kubernetes do Fluent Bit](https://docs.fluentbit.io/manual/data-pipeline/filters/kubernetes).
