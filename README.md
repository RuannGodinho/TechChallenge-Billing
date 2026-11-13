> Endpoint migration update: original Portuguese `/api` paths are restored in their owning service. See [restored endpoints and configuration](docs/ENDPOINT-MIGRATION.md). The extraction notes below describe earlier limitations; the endpoint inventory and execution-completion behavior are superseded by that document.

# Billing service (work in progress)

Independent TypeScript/Express Billing service with its own PostgreSQL database. This repository currently implements estimate snapshots, approval/rejection, the Service Orders estimate endpoints, transactional outbox records, and an SMTP email worker. It is not yet a complete billing or payment service.

## Local development

Use Node 20 and Docker Compose. Copy `.env.example` to `.env`, change the secrets, then run `docker compose up --build`. This starts PostgreSQL and the application and runs migrations. Outside Docker: install dependencies with `npm ci`, configure `DATABASE_URL` and `INTERNAL_API_KEY`, then run `npm run build`, `npm run migrate`, and `npm start`.

All `/internal` endpoints require `x-internal-api-key`, shared securely with Service Orders. `POST /internal/estimates` accepts `{ordemServicoId,valorTotal,pecas,servicos}` matching the Service Orders contract; parts require `id,nome,descricao,tipo,preco,quantidade`, services require `id,nome,descricao,preco`. A duplicate payload for the same order returns the existing estimate; different payloads create a new version. Money is checked in cents and totals must match. `GET /internal/orders/:id/estimate-approval` returns `{approved:boolean}` for the latest estimate. `POST /internal/estimates/:id/decision` accepts `{decision:"APPROVED"|"REJECTED"}` and repeats of the same decision are idempotent. Only the latest unexpired pending estimate may be decided.

The database transaction writes an outbox record with each creation or decision. **There is no execution event consumer, automatic deployment or end-to-end validation yet.** A duplicate estimate with identical items and total returns the existing version even after rejection; a distinct command identifier will be needed if identical new estimates are required. Do not deploy as complete billing.

## Estimate email worker

Configure the SMTP settings and `ESTIMATE_EMAIL_TO`, apply migrations, then run `npm run email-worker` in a separate process. Each estimate-created outbox record is sent independently of the future message publisher. Failed delivery retries up to ten times; inspect `email_last_error` and `email_attempts` in `outbox` for exhausted items. SMTP provides at-least-once delivery: a crash after the provider accepts a message but before the database commit can cause a duplicate. The configured recipient is currently global, matching the legacy service; customer-specific recipient lookup remains to be integrated.

## Kubernetes foundation

`k8s/billing.yaml` contains a service and deployment with a migration init container and email worker. Supply a versioned image and create `billing-secrets` with `DATABASE_URL`, `INTERNAL_API_KEY`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_FROM`, and `ESTIMATE_EMAIL_TO`; include SMTP credentials if required. PostgreSQL and messaging infrastructure must be provisioned separately. This manifest and migration flow have not been exercised in a cluster.

## RabbitMQ outbox publisher

Set `RABBITMQ_URL` and start `npm run outbox-worker` after migrations. The worker declares the durable topic exchange `billing.events`, the durable `service-orders.billing` queue (bound to `estimate.#` and `payment.#`), and a dead-letter exchange and queue. It sends persistent JSON messages with stable `messageId`, `eventType`, `eventVersion`, `orderId`, `occurredAt`, and `data`, and marks records published only after broker confirmation. The consumer must deduplicate by `messageId`: a crash between broker confirmation and database commit can publish a duplicate. Failed publishes are retried at most ten times; operators must inspect and reset `attempts` for unpublished rows after resolving the cause. Consumer retry limits and dead-letter rejection behavior belong to the consuming service. The broker and consumer must use this topology and credentials.

For Compose, `RABBITMQ_URL` must name a broker reachable from inside the containers; `localhost` there means the container itself. Supply an external broker with a non-guest user and its network address. For Kubernetes, include `RABBITMQ_URL` in `billing-secrets`. These integrations remain unverified against a live broker.

## Checkout and notifications

Set `MERCADO_PAGO_ACCESS_TOKEN` and `MERCADO_PAGO_WEBHOOK_SECRET` in the secret configuration. Apply all migrations. A trusted orchestrator must call `POST /internal/orders/:id/execution-complete` with `{ "messageId": "<UUID>" }` and `x-internal-api-key` after execution completes. This stores the latest approved estimate as the execution gate and accepts duplicate events with the same ID. **No service currently sends this signal automatically.**

Call `POST /internal/orders/:id/checkout` with `x-internal-api-key` and a UUID `idempotency-key` header. Only a completed execution and the same latest approved estimate are eligible. Persist the key and retry with the same key after errors; a different key is rejected while an attempt is open or paid. A provider timeout can leave the attempt in `CREATING`, so do not create a new key to work around it. `GET /internal/payments/:id` returns the status. `GET /internal/orders/:id/payment-status` rechecks the provider before reporting a confirmed payment. `POST /internal/payments/:id/reconcile` fetches the stored provider order again, for missed notifications.

Configure an HTTPS Mercado Pago Orders notification URL ending in `/webhooks/mercado-pago`. The endpoint validates the `x-signature`, `x-request-id`, and `data.id` query parameter; fetches the order using server-side credentials; checks the reference, amount, currency, accredited status and paid amount; and commits payment confirmation, notification deduplication and a `payment.confirmed` outbox event atomically. The caller of the execution endpoint and consumer of payment events must use authenticated, restricted infrastructure. Refunded, partially refunded, and charged-back provider orders are recorded as REVERSED; a reversal following confirmation emits `payment.reversed`. Reversed payments require manual resolution. Service Orders checks the authenticated payment-status endpoint before delivery; Billing refreshes the provider status for this check and fails closed if it cannot be verified.

The contracts follow the [Mercado Pago Orders API](https://www.mercadopago.com.br/developers/en/reference/online-payments/checkout-pro-orders/create-order/post) and [notification documentation](https://www.mercadopago.com.br/developers/en/docs/checkout-pro-orders/notifications). The checkout, migration, webhook, database concurrency, and event integration have not been verified against a live provider or PostgreSQL.
