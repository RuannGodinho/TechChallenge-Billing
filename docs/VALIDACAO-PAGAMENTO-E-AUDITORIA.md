# Evidências de mensagens, PostgreSQL e pagamento na AWS

## Histórico de mensagens por 24 horas

Os três projetos declaram a mesma topologia de auditoria no RabbitMQ existente. Nenhum pod, consumidor ou banco adicional é criado. Cada publicação compatível com as rotas operacionais recebe uma cópia em:

| Fila de auditoria | Publicações copiadas |
| --- | --- |
| `audit.billing.events` | `estimate.#` e `payment.#` |
| `audit.execution.events` | `execution.completed` |
| `audit.saga.commands` | `billing.*` e `execution.*` |
| `audit.saga.results` | `saga.result` |

As filas são duráveis e as cópias expiram 24 horas após entrarem na fila (`x-message-ttl=86400000`). Elas continuam visíveis depois do ACK da mensagem operacional. A retenção usa o disco do broker/PVC atual e aumenta o armazenamento utilizado. As mensagens anteriores à criação dessas filas não são recuperadas automaticamente.

Isso é um histórico de **publicações**, não um comprovante de sucesso em cada consumidor. Retentativas encaminhadas diretamente às filas `.retry` e mensagens publicadas diretamente em uma fila não passam pelos exchanges auditados. Duplicatas publicadas novamente podem aparecer no histórico; correlacione pelo messageId. Para comprovar processamento use inbox, resultados da Saga, estado de negócio e logs `message_processed`/`message_processing_failed`.

Após implantar os workers atualizados, no Terminal do seu Mac:

```bash
kubectl port-forward -n default deployment/rabbitmq-deployment 15672:15672
```

Abra http://localhost:15672, entre com as credenciais do broker, selecione o vhost configurado e abra Queues and Streams. Filtre por `audit.`. Em cada fila, use Get messages **com requeue=true** para consultar sem remover a cópia. Confira exchange, routing key, message_id e JSON do payload: messageId, eventType, orderId, occurredAt e data (sagaId, attempt, commandId, decision, conforme o evento). Get messages é uma leitura em lotes, não uma busca completa por OS ou uma timeline de ACKs. Não use Purge nas filas para inspecioná-las.

Para validar, processe uma OS nova, confira que a fila operacional foi consumida e que a cópia com o mesmo messageId continua na fila de auditoria. Não conecte um consumidor de aplicação às filas audit.

Teste opcional com RabbitMQ real, independente dos bancos e sem criar OS ou pagamentos: `node scripts/test-rabbitmq-audit.cjs`. Ele cria e remove um vhost exclusivo. Configure `TEST_RABBITMQ_URL` e `TEST_RABBITMQ_MANAGEMENT_URL` para um broker de desenvolvimento; os defaults são o broker local nas portas 5672/15672 com guest/guest. O teste verifica ACK, cópia, requeue, rotas desconhecidas e expiração acelerada por uma policy apenas no vhost temporário. O TTL de produção continua 24 horas. `AUDIT_TEST_PROJECT_DIR` permite validar a implementação de outro checkout sem torná-lo dependência de runtime.

## PostgreSQL no DBeaver do Mac

Execute no mesmo Mac onde o DBeaver está instalado, mantendo o terminal aberto:

```bash
kubectl port-forward -n default service/postgres-service 15432:5432
```

No DBeaver Community: Database → New Database Connection → PostgreSQL.

| Campo | Valor |
| --- | --- |
| Host | `127.0.0.1` |
| Port | `15432` |
| Database | `billing` |
| Username | `billing` |
| Password | Mesmo POSTGRES_PASSWORD utilizado pelo infra-db |

Use Test Connection e Finish. Abra Databases → billing → Schemas → public → Tables; selecione uma tabela e abra a aba Data (ou View Data). O port-forward acessa o PostgreSQL da AWS, não um banco local. Ele não publica o PostgreSQL na internet e não acrescenta pods. Se o pod reiniciar, reconecte o túnel. Se executar no CloudShell, localhost será o CloudShell e o DBeaver no Mac não terá esse túnel.

Abra `queries/billing-evidencias.sql` no SQL Editor e substitua COLE_ID_DA_OS pelo ID da ordem. As consultas são somente leitura e mostram orçamentos, validade exata, conclusão, pagamento, notificações, e-mail e os registros de publicação/recebimento da Saga. Valores PostgreSQL são PENDING/APPROVED/REJECTED e PAID; a API apresenta PENDENTE/APROVADO/REPROVADO para orçamentos.

## Pagamento Mercado Pago pelo Postman e checkout existente

Configure os secrets MERCADO_PAGO_ACCESS_TOKEN e MERCADO_PAGO_WEBHOOK_SECRET do ambiente Teste no Billing e execute o CD. No painel da mesma aplicação Mercado Pago, configure Webhooks do ambiente Teste, evento Order (Mercado Pago), apontando para:

```text
https://SEU_API_GATEWAY.execute-api.us-east-1.amazonaws.com/webhooks/mercado-pago
```

A assinatura secreta dessa configuração deve ser a usada no Billing. A rota do webhook já está no Gateway e valida a assinatura; não exige Bearer. O teste de verdade precisa de uma order paga no provedor, e não apenas do simulador de notificação.

Use uma OS com orçamento aprovado, Saga CONCLUIDA e todos os serviços finalizados. Confirme que Billing recebeu completed_executions referente ao orçamento aprovado. A OS deve estar FINALIZADA e ainda não ENTREGUE.

O checkout é um endpoint interno. Em outro terminal do Mac:

```bash
kubectl port-forward -n default service/billing 3002:80
```

No Postman:

```http
POST http://localhost:3002/internal/orders/ID_DA_OS/checkout
Content-Type: application/json
x-internal-api-key: INTERNAL_API_KEY_DO_BILLING
Idempotency-Key: UUID_GERADO_PARA_ESTA_TENTATIVA

{}
```

Use a chave interna do Billing e não o Bearer nessa chamada. Preserve o UUID e o corpo em qualquer repetição por timeout/502. Guarde `id` da tentativa e `checkoutUrl`; abra essa URL no navegador e utilize os cartões/dados dos cenários oficiais de teste. Um retorno 409 pode indicar que a conclusão ainda não foi recebida, que o orçamento não é elegível ou que já há uma tentativa ativa. Leia a resposta antes de criar outra chave.

Após pagar, consulte no Postman:

```http
GET http://localhost:3002/internal/payments/ID_DA_TENTATIVA
x-internal-api-key: INTERNAL_API_KEY_DO_BILLING
```

```http
GET http://localhost:3002/internal/orders/ID_DA_OS/payment-status
x-internal-api-key: INTERNAL_API_KEY_DO_BILLING
```

Esperado: tentativa PAID e paid=true; publicação payment.confirmed; processamento no Orders e uma única entrada ENTREGUE no statusHistory. Use as consultas SQL para correlacionar a tentativa com provider_order_id, a notificação e a publicação, e consulte o Mongo Orders para o histórico da OS. A cópia em audit.billing.events demonstra publicação, não substitui o estado do consumidor.

Evidências do pagamento: painel Mercado Pago com notificação real entregue em HTTP 200; payment_attempts; processed_notifications; evento payment.confirmed; histórico ENTREGUE no Orders. O redirecionamento do navegador sozinho não autoriza a entrega.

Teste também pagamento pendente/rejeitado (não entrega) e reenvio da mesma notificação real (sem duplicar histórico). Como recuperação manual existe POST /internal/payments/ID_DA_TENTATIVA/reconcile com a chave do Billing; ele consulta o provedor, mas não comprova que o webhook foi recebido.

Referências: [ACKs](https://www.rabbitmq.com/docs/confirms), [TTL de mensagens](https://www.rabbitmq.com/docs/ttl), [DBeaver PostgreSQL](https://dbeaver.com/docs/dbeaver/Database-driver-PostgreSQL/), [teste Checkout Pro com Orders](https://www.mercadopago.com.br/developers/pt/docs/checkout-pro-orders/integration-test/test-purchase-with-card?scope=prod).
