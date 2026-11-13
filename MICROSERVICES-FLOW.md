# Microservices flow and endpoints

> This document records the initial setup and pre-restoration workflow. See [MICROSERVICES-RESTORED-ENDPOINTS.md](MICROSERVICES-RESTORED-ENDPOINTS.md) for the restored original paths and automatic execution completion now implemented.

This document describes the local Service Orders, Execution, and Billing workflow, based on the source code inspected during the local setup session on November 12, 2026 (America/Sao_Paulo).

The business flow is:

**Customer → Service Orders → Execution → Billing → Execution → Billing/payment → Service Orders/delivery.**

The workflow is partially integrated. In the inspected running environment, Service Orders had no Execution/Billing URLs or internal keys configured, and Billing had no Mercado Pago credentials. The completed API test exercised Billing directly; it was not an end-to-end test across all services.

For an endpoint-by-endpoint comparison against TechChallenge-Fiap's `main` branch, including renamed contracts and missing HTTP replacements, see [MICROSERVICES-ENDPOINT-COMPARISON.md](MICROSERVICES-ENDPOINT-COMPARISON.md).

## 1. Services and ownership

| Microservice | Repository | Local base URL | Responsibility | Database |
| --- | --- | --- | --- | --- |
| Service Orders | `TechChallenge-Fiap` | `http://localhost:3000` | Customers, vehicles, authentication, orders, lifecycle, status history | MongoDB `Node-Fiap` |
| Execution | `TechChallenge-Execution` | `http://localhost:3001` | Parts, services, inventory, execution scheduling | MongoDB `execution` |
| Billing | `TechChallenge-billing` | `http://localhost:3002` | Estimate snapshots, approval/rejection, checkout, payment confirmation | PostgreSQL `billing` |

Each service owns its database. Cross-service operations use HTTP or messaging rather than direct access to another service's database.

### Source locations used for this document

- Service Orders: `/Users/ruanngodinho/TechChallenge-Fiap`.
- Execution: `/Users/ruanngodinho/TechChallenge-Execution`.
- Running Billing project: `/Users/ruanngodinho/Downloads/TechChallenge-billing`.

This document is saved in `/Users/ruanngodinho/TechChallenge-Billing`. Its runtime observations refer to the Billing copy in Downloads inspected during the session.

## 2. Sequence diagram

```mermaid
sequenceDiagram
    actor User
    participant SO as Service Orders :3000
    participant EX as Execution :3001
    participant BI as Billing :3002
    participant MP as Mercado Pago

    User->>SO: POST /api/login
    SO-->>User: JWT

    User->>SO: POST /api/ordensServico
    SO->>EX: POST /internal/executions
    SO-->>User: Order RECEBIDA

    User->>SO: PUT order: EM DIAGNOSTICO
    User->>SO: PUT order: parts and services
    SO->>EX: GET parts/services; POST inventory/check
    SO->>BI: POST /internal/estimates
    SO-->>User: Order AGUARDANDO APROVACAO

    User->>BI: POST /internal/estimates/{id}/decision
    User->>SO: PUT order: EM EXECUCAO
    SO->>BI: GET estimate-approval
    SO->>EX: POST inventory/check and inventory/consume

    Note over SO,EX: Execution start/finish HTTP integration is missing

    User->>SO: PUT order: FINALIZADA
    User->>BI: POST execution-complete (manual integration step)
    User->>BI: POST checkout
    BI->>MP: POST /v1/orders
    BI-->>User: checkoutUrl
    User->>MP: Complete payment
    MP->>BI: POST /webhooks/mercado-pago
    BI->>MP: GET /v1/orders/{id}

    User->>SO: PUT order: ENTREGUE
    SO->>BI: GET payment-status
    BI->>MP: Recheck payment
    SO-->>User: Delivered if payment confirmed
```

## 3. Authentication and identifiers

### Service Orders

In local authentication mode, obtain a JWT through:

```http
POST http://localhost:3000/api/login
Content-Type: application/json

{"cpf":"<ACTIVE_CUSTOMER_CPF>"}
```

Protected Service Orders routes require:

```http
Authorization: Bearer <TOKEN>
```

In gateway authentication mode, login belongs to the external API Gateway/authentication flow; the local login route returns HTTP 410.

### Execution and Billing

All `/internal` endpoints in these services require:

```http
x-internal-api-key: <SERVICE_INTERNAL_API_KEY>
```

The inspected local Billing key was `oficina-billing-local`. Execution uses its own configured `INTERNAL_API_KEY`; Service Orders must use the matching value when calling each service.

The Mercado Pago webhook uses signature verification instead of the internal API key.

### Identifiers

- Execution expects MongoDB ObjectIds for orders, parts, and services.
- Billing estimate IDs and payment attempt IDs are UUIDs.
- Execution completion `messageId` and checkout `idempotency-key` must be UUIDs.
- Billing accepts order identifiers such as `os-teste-001` for an isolated estimate test, but that identifier is unsuitable for the complete Execution flow and the Service Orders billing-event consumer.

## 4. Prepare customers, vehicles, catalog, and inventory

### Service Orders endpoints

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `POST` | `/api/login` | Obtain a JWT in local authentication mode |
| `GET` | `/api/me` | Read the current authenticated user |
| `POST` | `/api/clientes` | Create a customer |
| `GET` | `/api/clientes` | List customers |
| `GET` | `/api/clientes/cpf/:cpf` | Find a customer by CPF |
| `GET` | `/api/clientes/:id` | Find a customer by ID |
| `PUT` | `/api/clientes/:id` | Update a customer |
| `DELETE` | `/api/clientes/:id` | Delete a customer |
| `POST` | `/api/veiculos` | Create a vehicle |
| `GET` | `/api/veiculos` | List vehicles |
| `GET` | `/api/veiculos/:id` | Find a vehicle |
| `PUT` | `/api/veiculos/:id` | Update a vehicle |
| `DELETE` | `/api/veiculos/:id` | Delete a vehicle |

Customer creation payload:

```json
{
  "nome": "Customer name",
  "email": "customer@example.com",
  "cpf": "<VALID_CPF>",
  "telefone": "<PHONE>",
  "status": "ATIVO"
}
```

Vehicle creation payload:

```json
{
  "placa": "<VALID_PLATE>",
  "modelo": "Vehicle model",
  "ano": 2020,
  "marca": "Vehicle brand"
}
```

Customer and vehicle routes require authentication. For an initial local login, use an existing active customer, such as one created by the project's seed.

### Execution endpoints

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `POST` | `/internal/parts` | Create a part |
| `GET` | `/internal/parts/:id` | Read part details and price |
| `POST` | `/internal/services` | Create a service |
| `GET` | `/internal/services/:id` | Read service details and price |
| `POST` | `/internal/inventory/receive` | Receive stock |
| `POST` | `/internal/inventory/check` | Check available stock |
| `POST` | `/internal/inventory/consume` | Consume stock for an order |
| `POST` | `/internal/executions` | Schedule services for an order |

Example service creation payload:

```json
{
  "nome": "Troca de oleo",
  "descricao": "Substituicao do oleo do motor",
  "preco": 150
}
```

Example stock receipt:

```http
POST http://localhost:3001/internal/inventory/receive
Content-Type: application/json
x-internal-api-key: <EXECUTION_INTERNAL_API_KEY>

{"pecaId":"<PART_ID>","quantidade":10,"operationId":"receipt-001"}
```

Quantities must be positive integers. The part must exist before stock can be received. Receipt operation IDs are idempotent per part.

## 5. Open an order: Service Orders → Execution

```http
POST http://localhost:3000/api/ordensServico
Authorization: Bearer <TOKEN>
Content-Type: application/json

{
  "cpfCnpj": "<CUSTOMER_CPF>",
  "veiculoId": "<VEHICLE_ID>",
  "pecas": [],
  "servicos": ["<SERVICE_ID>"]
}
```

Service Orders validates the customer and vehicle, then saves an order with status `RECEBIDA`. When services are present, it calls Execution:

```http
POST http://localhost:3001/internal/executions
Content-Type: application/json
x-internal-api-key: <EXECUTION_INTERNAL_API_KEY>

{
  "ordemServicoId": "<ORDER_ID>",
  "servicoIds": ["<SERVICE_ID>"]
}
```

Execution validates the services and schedules them idempotently by order/service pair. A successful scheduling request returns HTTP 204. Scheduling does not start the work.

If the order is saved but the downstream scheduling call fails, Service Orders can return HTTP 502 containing `orderId`. Reconcile that existing order before retrying creation.

## 6. Diagnose and generate an estimate: Service Orders → Execution → Billing

First move the order into diagnosis:

```http
PUT http://localhost:3000/api/ordensServico/<ORDER_ID>
Authorization: Bearer <TOKEN>
Content-Type: application/json

{"status":"EM DIAGNOSTICO"}
```

Then submit the complete diagnosed items:

```http
PUT http://localhost:3000/api/ordensServico/<ORDER_ID>
Authorization: Bearer <TOKEN>
Content-Type: application/json

{
  "pecas": [
    {"pecaId":"<PART_ID>","quantidade":1}
  ],
  "servicos": ["<SERVICE_ID>"]
}
```

Service Orders performs these calls:

1. Execution `GET /internal/parts/:id` for each part.
2. Execution `POST /internal/inventory/check` for each part and quantity.
3. Execution `GET /internal/services/:id` for each service.
4. Billing `POST /internal/estimates` with the calculated total and item snapshots.
5. Execution `POST /internal/executions` for newly added services, when applicable.

After estimate creation succeeds, Service Orders moves the order to `AGUARDANDO APROVACAO`. Stock is checked during diagnosis; consumption occurs when entering execution.

Billing's estimate creation contract is:

```http
POST http://localhost:3002/internal/estimates
Content-Type: application/json
x-internal-api-key: oficina-billing-local

{
  "ordemServicoId": "<ORDER_ID>",
  "valorTotal": 150,
  "pecas": [],
  "servicos": [
    {
      "id": "<SERVICE_ID>",
      "nome": "Troca de oleo",
      "descricao": "Substituicao do oleo do motor",
      "preco": 150
    }
  ]
}
```

Part snapshots require `id`, `nome`, `descricao`, `tipo`, `preco`, and `quantidade`. Service snapshots require `id`, `nome`, `descricao`, and `preco`. Totals must match the items, with monetary validation performed in cents.

A new estimate returns HTTP 201. An identical payload for the same order returns the existing estimate; a changed payload creates a new version.

### Obtaining the estimate ID

Service Orders currently discards the response from Billing's estimate creation call, and Billing exposes no estimate lookup endpoint. Repeating `POST /internal/estimates` with the identical snapshot returns the existing estimate, including its ID. An isolated direct Billing creation also returns the ID immediately.

## 7. Approve or reject the estimate: Billing

```http
POST http://localhost:3002/internal/estimates/<ESTIMATE_ID>/decision
Content-Type: application/json
x-internal-api-key: oficina-billing-local

{"decision":"APPROVED"}
```

To reject, use `{"decision":"REJECTED"}`.

Only the latest, unexpired, pending estimate can receive a new decision. Repeating the same decision is idempotent. Approval does not automatically change the Service Orders status.

Check approval through:

```http
GET http://localhost:3002/internal/orders/<ORDER_ID>/estimate-approval
x-internal-api-key: oficina-billing-local
```

Expected approved response:

```json
{"approved":true}
```

## 8. Begin work: Service Orders → Billing → Execution

```http
PUT http://localhost:3000/api/ordensServico/<ORDER_ID>
Authorization: Bearer <TOKEN>
Content-Type: application/json

{"status":"EM EXECUCAO"}
```

Service Orders calls:

| Destination | Endpoint | Purpose |
| --- | --- | --- |
| Billing | `GET /internal/orders/:id/estimate-approval` | Require the latest estimate to be approved |
| Execution | `POST /internal/inventory/check` | Recheck each part before consumption |
| Execution | `POST /internal/inventory/consume` | Consume each required part |

Consumption payload:

```json
{
  "pecaId": "<PART_ID>",
  "quantidade": 1,
  "ordemServicoId": "<ORDER_ID>"
}
```

Consumption is atomic per part and idempotent for the same order/part/quantity. Reusing that key with a different quantity is a conflict. Multiple part consumptions are not a single transaction; a later failure can leave partial consumption requiring reconciliation.

**Integration gap:** Execution does not currently mount HTTP endpoints to start or finish individual executions. Changing the order status does not invoke those execution operations.

## 9. Finish work and notify Billing: manual integration step

Update the order:

```http
PUT http://localhost:3000/api/ordensServico/<ORDER_ID>
Authorization: Bearer <TOKEN>
Content-Type: application/json

{"status":"FINALIZADA"}
```

A trusted caller must separately notify Billing:

```http
POST http://localhost:3002/internal/orders/<ORDER_ID>/execution-complete
Content-Type: application/json
x-internal-api-key: oficina-billing-local

{"messageId":"<UUID>"}
```

Success returns HTTP 204. Billing associates the completion signal with the latest approved estimate and accepts duplicate signals with the same message ID.

**No service currently sends this notification automatically.** Marking an order `FINALIZADA` alone does not satisfy Billing's checkout gate.

## 10. Create checkout: Billing → Mercado Pago

```http
POST http://localhost:3002/internal/orders/<ORDER_ID>/checkout
x-internal-api-key: oficina-billing-local
idempotency-key: <UUID>
```

Billing requires the execution completion signal and the same latest approved estimate. Its current provider adapter calls:

```http
POST https://api.mercadopago.com/v1/orders
```

The checkout response includes:

```json
{
  "id": "<PAYMENT_ATTEMPT_ID>",
  "status": "...",
  "checkoutUrl": "https://..."
}
```

The customer follows `checkoutUrl` to complete payment. Retry failed checkout requests with the same persisted idempotency key. A timeout can leave an attempt in `CREATING`; creating a new key is not a recovery mechanism.

The provider paths above describe the adapter in the inspected repository. Live provider compatibility and checkout behavior were not validated during this session.

## 11. Confirm payment: Mercado Pago → Billing

Configure a publicly reachable HTTPS notification URL ending in:

```http
POST /webhooks/mercado-pago?data.id=<PROVIDER_ORDER_ID>
```

Billing verifies `x-signature`, `x-request-id`, and `data.id`, then fetches the authoritative provider order using:

```http
GET https://api.mercadopago.com/v1/orders/<PROVIDER_ORDER_ID>
```

It validates the reference, amount, currency, payment status, and paid amount before persisting confirmation and creating a `payment.confirmed` outbox event. A reversal after confirmation can emit `payment.reversed` and requires manual resolution.

Supporting endpoints:

| Method | Billing endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/internal/payments/:id` | Read a payment attempt |
| `POST` | `/internal/payments/:id/reconcile` | Recheck the provider after missed notifications |
| `GET` | `/internal/orders/:id/payment-status` | Verify whether payment is confirmed |

## 12. Deliver the vehicle: Service Orders → Billing

```http
PUT http://localhost:3000/api/ordensServico/<ORDER_ID>
Authorization: Bearer <TOKEN>
Content-Type: application/json

{"status":"ENTREGUE"}
```

Service Orders calls Billing:

```http
GET http://localhost:3002/internal/orders/<ORDER_ID>/payment-status
x-internal-api-key: oficina-billing-local
```

Billing rechecks Mercado Pago. Delivery proceeds only when the result is:

```json
{"paid":true}
```

Unpaid results or an unavailable payment check prevent delivery.

### Order lifecycle and consultation

```text
RECEBIDA → EM DIAGNOSTICO → AGUARDANDO APROVACAO
         → EM EXECUCAO → FINALIZADA → ENTREGUE
```

| Method | Service Orders endpoint | Purpose |
| --- | --- | --- |
| `POST` | `/api/ordensServico` | Create an order |
| `PUT` | `/api/ordensServico/:id` | Update items or advance status |
| `GET` | `/api/ordensServico` | List active orders; excludes finalized and delivered orders |
| `GET` | `/api/ordensServico/:cpfCnpj/detalhes` | Public order details lookup by CPF/CNPJ; no JWT required |

## 13. Asynchronous messaging and email

Billing writes outbox records alongside estimate creation, decisions, and payment changes. Its outbox worker can publish:

- `estimate.created`
- `estimate.approved`
- `estimate.rejected`
- `payment.confirmed`
- `payment.reversed`

```text
Billing PostgreSQL outbox
    → Billing outbox-worker
    → RabbitMQ exchange: billing.events
    → Queue: service-orders.billing
    → Service Orders billing-consumer
    → Order billingEvents array
```

The queue binds to `estimate.#` and `payment.#`. The consumer deduplicates by `messageId` and records events in the order. It does not automatically advance order statuses or implement an execution-completion saga. Malformed or repeatedly failing messages go to `service-orders.billing.dlq`.

The independent Billing email worker sends estimate-created emails using SMTP and the configured global `ESTIMATE_EMAIL_TO` recipient.

Workers are started separately:

| Service | Command | Configuration |
| --- | --- | --- |
| Billing | `npm run outbox-worker` | Reachable `RABBITMQ_URL` |
| Billing | `npm run email-worker` | SMTP settings and `ESTIMATE_EMAIL_TO` |
| Service Orders | `npm run billing-consumer` | Same RabbitMQ broker |

Service Orders also exposes its consumer through the Compose `messaging` profile. Billing Compose defines `outbox-worker` and `email-worker` services. Neither Billing worker is started by `docker compose up -d --build postgres billing`.

## 14. Local configuration and observed state

### Service Orders connectivity

For the current separate Docker Compose projects on macOS, configure Service Orders with:

```dotenv
EXECUTION_SERVICE_URL=http://host.docker.internal:3001
EXECUTION_INTERNAL_API_KEY=<Execution INTERNAL_API_KEY>
BILLING_SERVICE_URL=http://host.docker.internal:3002
BILLING_INTERNAL_API_KEY=oficina-billing-local
```

Recreate the relevant container after changing its environment. If all services instead share a Docker network, use their resolvable service names. For a Node process running directly on the host, use `localhost` URLs.

### Billing configuration used in the completed test

```dotenv
PORT=3002
INTERNAL_API_KEY=oficina-billing-local
POSTGRES_PASSWORD=billing-local
DATABASE_URL=postgresql://billing:billing-local@localhost:5433/billing
```

The Compose configuration overrides `DATABASE_URL` inside the Billing container to use `postgres:5432`. The host URL above is for access from the host. Preserve an existing PostgreSQL volume's original password when reusing that volume.

Billing was started from `/Users/ruanngodinho/Downloads/TechChallenge-billing` with:

```bash
docker compose up -d --build postgres billing
```

The Billing startup command runs migrations before starting the API.

### Additional integrations

Checkout needs `MERCADO_PAGO_ACCESS_TOKEN`, `MERCADO_PAGO_WEBHOOK_SECRET`, and a reachable HTTPS webhook URL. Messaging needs a broker reachable from both services and their workers. SMTP delivery needs a reachable SMTP server.

`localhost` inside a container refers to that container, so host-based dependencies require an appropriate host address or a shared Docker network.

### Snapshot observed during the session

| Component | Observed state |
| --- | --- |
| Service Orders API and MongoDB | Running |
| Execution API and MongoDB | Running |
| Billing API and PostgreSQL | Running; PostgreSQL healthy |
| Service Orders Execution/Billing URLs and internal keys | Not configured in the running API container |
| Billing Mercado Pago token and webhook secret | Not configured |
| RabbitMQ, outbox worker, email worker, billing consumer | Not running in the inspected container list |
| Full cross-service workflow | Not executed |

## 15. Completed isolated Billing test

The following results were confirmed against the running Billing API:

| Operation | Endpoint | Result |
| --- | --- | --- |
| Readiness | `GET /ready` | HTTP 200, `{"status":"ok"}` |
| Estimate creation | `POST /internal/estimates` | HTTP 201 |
| Approval | `POST /internal/estimates/:id/decision` | HTTP 200, status `APPROVED` |
| Approval lookup | `GET /internal/orders/os-teste-001/estimate-approval` | HTTP 200, `{"approved":true}` |

Test order ID: `os-teste-001`.

Estimate ID: `0af2b607-e17b-43b4-bce2-2327061046a4`.

Estimate total: R$150.00, with one oil-change service and no parts.

## 16. Health, documentation, and implementation references

All three services expose `GET /health` and `GET /ready`. Readiness checks database connectivity.

Service Orders documentation:

- Swagger UI: `http://localhost:3000/docs`.
- OpenAPI JSON: `http://localhost:3000/swagger.json`.

The historical Service Orders repository still contains former monolith route files. Parts, inventory, execution, and estimate routes in those files are not mounted by the current Service Orders application; use the owner endpoints documented above.

Primary implementation references, relative to each repository:

| Repository | File | Purpose |
| --- | --- | --- |
| Service Orders | `app.ts` | Mounted route groups |
| Service Orders | `src/Adapters/adapters/service-http.adapter.ts` | Execution/Billing HTTP calls |
| Service Orders | `src/application/usecases/ordem-servico/atualizar-itens-ordem-servico.usecase.ts` | Catalog lookup and estimate creation |
| Service Orders | `src/application/usecases/ordem-servico/alterar-status-ordem-servico.usecase.ts` | Approval, inventory, and delivery gates |
| Service Orders | `src/enterprise/value-objects/status-os.vo.ts` | Allowed order transitions |
| Service Orders | `src/infrastructure/messaging/billing-consumer.ts` | Billing event consumption |
| Execution | `src/main/server.ts` | Mounted internal endpoints |
| Billing | `src/server.ts` | Authentication and route mounting |
| Billing | `src/infrastructure/http/estimate-routes.ts` | Estimate endpoints |
| Billing | `src/infrastructure/http/payment-routes.ts` | Checkout, reconciliation, webhook endpoints |
| Billing | `src/application/usecases/payment-workflows.usecase.ts` | Payment orchestration |
| Billing | `src/mercado-pago.ts` | Provider requests and signature verification |

Remaining integration work includes execution start/finish endpoints, an automatic execution-completion producer, complete order/estimate ID propagation, messaging setup, and end-to-end validation of payment and delivery.
