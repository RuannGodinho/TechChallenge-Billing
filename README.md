> Documentação integrada: [arquitetura final dos microsserviços](docs/ARQUITETURA-FINAL-MICROSSERVICOS.md) e [fluxograma da ordem de serviço (Mermaid)](docs/FLUXO-ORDEM-DE-SERVICO.mmd).

> Saga orquestrada: [fluxo, compensações, configuração e testes](docs/SAGA.md).

> RabbitMQ setup and asynchronous execution completion are implemented. See [local messaging setup, queues and tests](docs/RABBITMQ.md). Older extraction notes below are historical.

> Endpoint migration update: original Portuguese `/api` paths are restored in their owning service. See [restored endpoints and configuration](docs/ENDPOINT-MIGRATION.md). The extraction notes below describe earlier limitations; the endpoint inventory and execution-completion behavior are superseded by that document.

# Billing service (work in progress)

Independent TypeScript/Express Billing service with its own PostgreSQL database. This repository currently implements estimate snapshots, approval/rejection, the Service Orders estimate endpoints, transactional outbox records, and an SMTP email worker. It is not yet a complete billing or payment service.

## Local development

Use Node 20 and Docker Compose. Copy `.env.example` to `.env`, change the secrets, then run `docker compose up -d --build`. This starts PostgreSQL, migrations/API, RabbitMQ, the outbox publisher, execution consumer, email worker, and the local Mailpit inbox. Each other microservice starts independently with the same command in its own repository; see [messaging configuration](docs/RABBITMQ.md). Outside Docker: install dependencies with `npm ci`, configure `DATABASE_URL` and `INTERNAL_API_KEY`, then run `npm run build`, `npm run migrate`, and `npm start`.

All `/internal` endpoints require `x-internal-api-key`, shared securely with Service Orders. `POST /internal/estimates` accepts `{ordemServicoId,valorTotal,pecas,servicos}` matching the Service Orders contract; parts require `id,nome,descricao,tipo,preco,quantidade`, services require `id,nome,descricao,preco`. A duplicate payload for the same order returns the existing estimate; different payloads create a new version. Money is checked in cents and totals must match. `GET /internal/orders/:id/estimate-approval` returns `{approved:boolean}` for the latest estimate. `POST /internal/estimates/:id/decision` accepts `{decision:"APPROVED"|"REJECTED"}` and repeats of the same decision are idempotent. Only the latest unexpired pending estimate may be decided.

The database transaction writes an outbox record with each creation or decision. Execution completion is consumed through RabbitMQ. The local broker, transactional outbox, consumers, retries, deduplication and restart recovery are verified by the integration test in `docs/RABBITMQ.md`; automatic cloud deployment remains separate. A duplicate estimate with identical items and total returns the existing version even after rejection; a distinct command identifier will be needed if identical new estimates are required. Do not deploy as complete billing.

## Estimate email worker

Compose starts the email worker automatically. For local delivery capture, use `SMTP_HOST=mailpit` and open http://localhost:8025. Configure the SMTP settings and `ESTIMATE_EMAIL_TO` for another provider. Outside Compose, apply migrations and run `npm run email-worker` in a separate process. Each estimate-created outbox record is sent independently of the message publisher. Failed delivery retries up to ten times; inspect `email_last_error` and `email_attempts` in `outbox` for exhausted items. SMTP provides at-least-once delivery: a crash after the provider accepts a message but before the database commit can cause a duplicate. The configured recipient is currently global, matching the legacy service; customer-specific recipient lookup remains to be integrated.

## Testes, coverage e SonarQube

O projeto usa Jest com `ts-jest` e coverage V8, seguindo o padrão do Service Orders. Não é necessário compilar antes de executar os testes.

```bash
npm ci
npm run typecheck
npm test -- --runInBand
npm run coverage -- --runInBand
```

Os relatórios ficam em `coverage/lcov-report/index.html` (HTML) e `coverage/lcov.info` (SonarQube). A pipeline CI também executa a suíte com coverage. Os testes HTTP usam portas locais temporárias e simulam o Mercado Pago, sem cobranças reais. Os testes PostgreSQL são opcionais: configure `TEST_BILLING_DATABASE_URL` (contratos HTTP) e `TEST_BILLING_PG_URL` (seed) para habilitá-los; eles criam e removem schemas isolados.

Jest exige pelo menos **81% em linhas, statements, funções e branches**, inclusive na suíte padrão sem PostgreSQL. A descoberta inclui `src` e `test`, contabilizando também fontes não importados pelos testes. DTOs, declarações e contratos de ports sem lógica ficam fora do cálculo; as exclusões também estão configuradas no SonarQube. Controllers, gateways e regras de negócio continuam na cobertura.

Use o mesmo SonarQube do projeto principal em `http://localhost:9000`. Crie o projeto com a chave `techchallenge-billing`, gere um token com permissão de análise e preencha `SONAR_TOKEN` no `.env` (copie `.env.example` se necessário). Depois de gerar o coverage:

```bash
npm run sonar
```

O launcher usa o token do ambiente sem expansão de shell e propaga falhas do scanner. Assim como no principal, sem `SONAR_TOKEN` a análise é ignorada. O Sonar roda localmente; a pipeline não tenta acessar `localhost:9000` do desenvolvedor.

## Kubernetes foundation

Os manifests em `k8s/` separam API, HPA e workers agrupados, preservando o init container de migrations. Configuração, secrets, ordem de deploy e limites de escala: [Kubernetes](docs/KUBERNETES.md).

## RabbitMQ outbox publisher

Set `RABBITMQ_URL` and start `npm run outbox-worker` after migrations. The worker declares the durable topic exchange `billing.events`, the durable `service-orders.billing` queue (bound to `estimate.#` and `payment.#`), and a dead-letter exchange and queue. It sends persistent JSON messages with stable `messageId`, `eventType`, `eventVersion`, `orderId`, `occurredAt`, and `data`, and marks records published only after broker confirmation. The consumer must deduplicate by `messageId`: a crash between broker confirmation and database commit can publish a duplicate. Failed publishes are retried at most ten times; operators must inspect and reset `attempts` for unpublished rows after resolving the cause. Consumer retry limits and dead-letter rejection behavior belong to the consuming service. The broker and consumer must use this topology and credentials.

For Compose, `RABBITMQ_URL` must name a broker reachable from inside the containers; `localhost` there means the container itself. Billing's default Compose starts the local broker. Its workers use the `rabbitmq` hostname; other repositories use `host.docker.internal` locally or a configured remote broker hostname. No startup script or shared Docker network is required. For Kubernetes, include `RABBITMQ_URL` in `billing-secrets`. These integrations have been verified against the local Docker broker, including downtime, duplicates, retry and dead-letter scenarios.

## Checkout and notifications

Set `MERCADO_PAGO_ACCESS_TOKEN` and `MERCADO_PAGO_WEBHOOK_SECRET` in the secret configuration. Apply all migrations. A trusted orchestrator must call `POST /internal/orders/:id/execution-complete` with `{ "messageId": "<UUID>" }` and `x-internal-api-key` after execution completes. This stores the latest approved estimate as the execution gate and accepts duplicate events with the same ID. Execution now publishes `execution.completed`, and Billing consumes it automatically. The HTTP endpoint remains available for compatibility.

Call `POST /internal/orders/:id/checkout` with `x-internal-api-key` and a UUID `idempotency-key` header. Only a completed execution and the same latest approved estimate are eligible. Persist the key and retry with the same key after errors; a different key is rejected while an attempt is open or paid. A provider timeout can leave the attempt in `CREATING`, so do not create a new key to work around it. `GET /internal/payments/:id` returns the status. `GET /internal/orders/:id/payment-status` rechecks the provider before reporting a confirmed payment. `POST /internal/payments/:id/reconcile` fetches the stored provider order again, for missed notifications.

Configure an HTTPS Mercado Pago Orders notification URL ending in `/webhooks/mercado-pago`. The endpoint validates the `x-signature`, `x-request-id`, and `data.id` query parameter; fetches the order using server-side credentials; checks the reference, amount, currency, accredited status and paid amount; and commits payment confirmation, notification deduplication and a `payment.confirmed` outbox event atomically. The caller of the execution endpoint and consumer of payment events must use authenticated, restricted infrastructure. Refunded, partially refunded, and charged-back provider orders are recorded as REVERSED; a reversal following confirmation emits `payment.reversed`. Reversed payments require manual resolution. Service Orders checks the authenticated payment-status endpoint before delivery; Billing refreshes the provider status for this check and fails closed if it cannot be verified.

The contracts follow the [Mercado Pago Orders API](https://www.mercadopago.com.br/developers/en/reference/online-payments/checkout-pro-orders/create-order/post) and [notification documentation](https://www.mercadopago.com.br/developers/en/docs/checkout-pro-orders/notifications). The checkout, migration, webhook, database concurrency, and event integration have not been verified against a live provider or PostgreSQL.

## Development seed

`docker compose up -d --build` runs `npm run seed` automatically before starting the API (after database initialization and migrations). Set `SEED_ENABLED=false` in `.env` to skip demo data. The seeds insert missing fixtures only; restarting does not overwrite edited records, reset stock, or renew expired estimates.

Billing populates `estimates` with two pending snapshots: oil/filter replacement (R$ 365.00) and brake pad replacement (R$ 400.00). The demo order references are `000000000000000000000001` and `000000000000000000000002`; they do not create OS records in Service Orders. Item IDs match Execution's seeded catalog. Demo snapshots emit no outbox events or emails, and create no payment attempts or execution-completion records. Use the normal APIs with a real OS ID to test the integrated business flow. The script is `src/postgres-init/seed.js`; outside Docker run `npm run build` first, apply migrations, and load `DATABASE_URL` into the environment.

To run again manually with the configured Compose environment:

```bash
docker compose exec billing npm run seed
```

## Compact Docker Compose

The default Compose now starts five permanent containers: `billing`, `workers`, `postgres`, `rabbitmq`, and `mailpit`. The supervised `workers` container runs outbox publishing, execution consumption, email delivery, and the Saga as separate Node processes. If one worker exits, the group restarts; the API runs separately.

To replace the previous individual worker containers, preserving existing volumes:

```bash
docker compose up -d --build --remove-orphans
docker compose ps
docker compose logs -f workers
```

The same optimization is present in the Downloads checkout. Use one checkout consistently: both have the Compose project name `techchallenge-billing` and manage the same local stack. Worker processes still have their own memory; container reduction does not guarantee proportional RAM savings.
