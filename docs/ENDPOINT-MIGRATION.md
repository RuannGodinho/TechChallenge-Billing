# Restored endpoints in the owning microservices

The original HTTP verbs, Portuguese resource paths, and controller method names are restored in their owning services. Service Orders continues to own customers, vehicles, authentication, and orders. Existing internal endpoints remain available for compatibility.

Baseline: TechChallenge-Fiap main commit 51ca91e. The restored paths are now served by the owners listed below.

## Execution — http://localhost:3001

| Method | Original endpoint, now on Execution | Controller method |
| --- | --- | --- |
| GET | `/api/pecas` | `getAllPecas` |
| GET | `/api/pecas/:id` | `getPecaById` |
| POST | `/api/pecas` | `createPeca` |
| PUT | `/api/pecas/:id` | `updatePeca` |
| DELETE | `/api/pecas/:id` | `deletePeca` |
| GET | `/api/servicos` | `getAllServicos` |
| GET | `/api/servicos/:id` | `getServicoById` |
| POST | `/api/servicos` | `createServico` |
| PUT | `/api/servicos/:id` | `updateServico` |
| DELETE | `/api/servicos/:id` | `deleteServico` |
| GET | `/api/estoque` | `getAllEstoque` |
| GET | `/api/estoque/:pecaId` | `getEstoqueByPecaId` |
| GET | `/api/estoque/movimentacoes` | `listaMovimentacoes` |
| POST | `/api/estoque/movimentacoes` | `createMovimentacao` |
| GET | `/api/execucoes-servico/:ordemServicoId` | `getExecucoesByOrdemServicoId` |
| PATCH | `/api/execucoes-servico/:id/iniciar` | `iniciarExecucao` |
| PATCH | `/api/execucoes-servico/:id/finalizar` | `finalizarExecucao` |
| GET | `/api/metricas/tempo-medio-servicos` | `getTempoMedioServicos` |

The part/service controllers and use cases retain their original names. Inventory methods use an atomic implementation rather than the inherited read-modify-write implementation.

### Inventory

The original movement payload is accepted:

```json
{
  "pecaId": "<PART_ID>",
  "tipo": "ENTRADA",
  "quantidade": 10,
  "origem": "compra"
}
```

`tipo` supports `ENTRADA` and `SAIDA`; `origem` supports `compra`, `OS`, `ajuste`, and `ordem`. Successful movements return HTTP 201 and a movement document with the original field names.

An optional `idempotency-key` header identifies a movement for safe retries. Without it, each request creates a separate movement, as in the previous API. Reusing a key with different data returns HTTP 409. Stock updates and embedded movement records are atomic per part. Concurrent withdrawals cannot reduce stock below zero. History combines embedded movements with any older movement documents in Execution's own database.

### Execution completion

Starting an execution checks the order status through authenticated HTTP. Finishing the last execution automatically completes the order through Service Orders, which then notifies Billing. No service reads or writes another service's database.

```text
PATCH Execution /api/execucoes-servico/:id/finalizar
  → PATCH Service Orders /internal/ordensServico/:id/finalizar
  → POST Billing /internal/orders/:id/execution-complete
```

Repeated finish requests preserve execution timestamps and retry failed downstream completion. Service Orders uses an atomic status transition and a stable completion message ID, so retries do not duplicate finalization history or completion records. This is synchronous retry handling, not a durable background outbox: after a downstream failure, retry the finish request.

## Billing — http://localhost:3002

| Method | Original endpoint, now on Billing | Controller method |
| --- | --- | --- |
| GET | `/api/orcamentos/:ordemServicoId` | `getOrcamentosByOrdemServicoId` |
| PUT | `/api/orcamentos/:id` | `updateOrcamento` |

`POST /api/orcamentos` also exposes estimate creation under the Portuguese resource name. The existing internal estimate, approval, decision, payment, and webhook endpoints remain available.

The restored GET/PUT endpoints return the original field names: `ordemServicoId`, `versao`, `status`, `pecas`, `itensServicos`, `valorTotal`, `validadeEm`, and `criadoEm`. Monetary responses use currency units rather than cents. Estimate IDs remain PostgreSQL UUIDs; existing MongoDB estimate data is not migrated by this change.

Approve using the previous request shape:

```http
PUT /api/orcamentos/<ESTIMATE_UUID>
Content-Type: application/json
Authorization: Bearer <TOKEN>

{"status":"APROVADO"}
```

Statuses are `PENDENTE`, `APROVADO`, `REPROVADO`, and `EXPIRADO`. History returns all versions in descending version order. An order without estimates returns HTTP 404.

Updates accept the previous fields `ordemServicoId`, `versao`, `status`, `valorTotal`, and `validadeEm`, subject to the Billing invariants:

- Only the latest pending estimate can change; an identical decision is idempotent.
- A changed approval/rejection requires an unexpired estimate.
- The total must match the stored item snapshot, with valid cent precision.
- Versions must be positive and unique; dates and order identifiers must be valid.
- An estimate tied to completed execution or an active, paid, or reversed payment cannot be changed.

Changed item snapshots should be submitted through estimate creation to produce a new version. The existing idempotency hash is preserved on metadata/decision updates.

## Authentication

The moved `/api` routes accept the JWT issued by Service Orders when `AUTH_MODE=local`. Configure the same `JWT_SECRET` in all three services. Only HS256 JWTs are accepted by the restored owner APIs.

With `AUTH_MODE=gateway`, use the matching `GATEWAY_TRUST_SECRET` and the existing `x-gateway-trust`, `x-user-id`, `x-user-email`, and `x-user-cpf` headers.

Trusted service callers may use their owner's `x-internal-api-key` on `/api` routes. Existing `/internal` endpoints continue to require internal credentials. A user JWT alone cannot access the new Service Orders internal lookup/completion routes.

## Required configuration

Execution:

```dotenv
AUTH_MODE=local
JWT_SECRET=<same secret as Service Orders>
SERVICE_ORDERS_URL=http://host.docker.internal:3000
SERVICE_ORDERS_INTERNAL_API_KEY=<shared Execution-to-Service-Orders secret>
```

Service Orders:

```dotenv
EXECUTION_SERVICE_URL=http://host.docker.internal:3001
EXECUTION_INTERNAL_API_KEY=<Execution INTERNAL_API_KEY>
BILLING_SERVICE_URL=http://host.docker.internal:3002
BILLING_INTERNAL_API_KEY=<Billing INTERNAL_API_KEY>
SERVICE_ORDERS_INTERNAL_API_KEY=<shared Execution-to-Service-Orders secret>
```

Billing:

```dotenv
AUTH_MODE=local
JWT_SECRET=<same secret as Service Orders>
```

These host addresses are for the current separate Docker Compose projects on macOS. Use `localhost` when processes run directly on the host, or service names when containers share a network. Recreate containers after environment changes.

## Verification

- Execution: type checking and the full suite, including real MongoDB HTTP tests for catalog CRUD, movement history, concurrent stock consumption, execution lifecycle, metrics, and completion retries.
- Service Orders: type checking, ownership boundary tests, and internal completion authentication/retry tests.
- Billing: builds and existing tests in both local copies; restored estimate contracts exercised against a temporary PostgreSQL schema.

The optional database tests use `TEST_EXECUTION_MONGO_URL` and `TEST_BILLING_DATABASE_URL`. They create isolated test databases/schemas and remove them after completion.

Checkout still requires Mercado Pago credentials and provider validation. Broker and SMTP worker setup remain separate from restoring these APIs.
