# Main branch versus microservices: methods and endpoints

> Historical comparison before endpoint restoration. The subsequent implementation is documented in [MICROSERVICES-RESTORED-ENDPOINTS.md](MICROSERVICES-RESTORED-ENDPOINTS.md).

## Scope and baseline

Compared on November 12, 2026 (America/Sao_Paulo):

| Source | Revision inspected |
| --- | --- |
| TechChallenge-Fiap `main` | `51ca91e1d8c1e12b58936b7d067d2b960c0dc4fd`; confirmed against GitHub's remote `main` |
| Current Service Orders | `/Users/ruanngodinho/TechChallenge-Fiap`, branch `feat/microsservices`, HEAD `ec2d561`, including existing uncommitted changes |
| Current Execution | `/Users/ruanngodinho/TechChallenge-Execution`, branch `feat/execution`, HEAD `e1ea4a0` |
| Current Billing | `/Users/ruanngodinho/Downloads/TechChallenge-billing`, branch `feat/billing`, HEAD `458cd4b` |

The Billing copy in this document's directory has a different HEAD (`8ceddc9`). The comparison uses the Downloads copy that was started and tested in the preceding setup.

Remote baseline: [TechChallenge-Fiap main commit](https://github.com/RuannGodinho/TechChallenge-Fiap/commit/51ca91e1d8c1e12b58936b7d067d2b960c0dc4fd).

This is a source-level comparison of mounted HTTP routes, controller methods, and the orchestration adapters. It does not claim that every endpoint was exercised at runtime. Existing application changes were preserved.

## Main findings

The extraction is **not a complete endpoint rename**. It removes route groups from Service Orders, exposes a subset under new internal contracts, and leaves several previous capabilities without HTTP replacements.

| Classification of main's endpoints | Count | Meaning |
| --- | ---: | --- |
| Retained in Service Orders | 20 | Same HTTP verb and path; some order behavior changed |
| Moved and renamed to Execution | 4 | Part/service creation and individual lookup |
| Replaced with narrower or split commands | 2 | Inventory movement and estimate update |
| No mounted HTTP replacement | 14 | Catalog list/update/delete, inventory reads, estimate history, execution lifecycle/metrics |
| **Total unique main endpoints** | **40** | Includes `/health` and `/ready`; excludes Swagger infrastructure routes |

`POST /api/login` is registered in two mutually exclusive authentication branches and is counted once.

All nine original controller files in the current Service Orders working tree are byte-for-byte identical to `main`. Therefore their methods were not literally renamed or deleted there. The difference is primarily route mounting and dependency wiring. Four controller files copied to Execution are also identical to their main counterparts, but Execution's server uses direct use-case handlers rather than mounting those controllers.

Terminology used below:

- **Retained:** old verb/path remains mounted.
- **Moved/renamed:** a corresponding operation exists at a different owner/path; authentication may still change.
- **Redesigned/partial:** a replacement covers only part of the former contract.
- **Missing HTTP replacement:** the old route is unmounted and no equivalent route is mounted by the new owners. This does not mean its source file was deleted.

## 1. Retained endpoints: Service Orders, port 3000

| Main endpoint | Current endpoint | Result |
| --- | --- | --- |
| `GET /health` | Same | Retained |
| `GET /ready` | Same | Retained |
| `POST /api/login` | Same | Retained; local/gateway distinction unchanged |
| `GET /api/internal/auth/clientes/:cpf` | Same | Retained; `x-gateway-trust` authentication |
| `GET /api/me` | Same | Retained |
| `GET /api/clientes` | Same | Retained |
| `GET /api/clientes/cpf/:cpf` | Same | Retained |
| `GET /api/clientes/:id` | Same | Retained |
| `POST /api/clientes` | Same | Retained |
| `PUT /api/clientes/:id` | Same | Retained |
| `DELETE /api/clientes/:id` | Same | Retained |
| `GET /api/veiculos` | Same | Retained |
| `GET /api/veiculos/:id` | Same | Retained |
| `POST /api/veiculos` | Same | Retained |
| `PUT /api/veiculos/:id` | Same | Retained |
| `DELETE /api/veiculos/:id` | Same | Retained |
| `POST /api/ordensServico` | Same | Retained; scheduling now calls Execution over HTTP |
| `GET /api/ordensServico` | Same | Retained; responses add `statusHistory` |
| `PUT /api/ordensServico/:id` | Same | Retained; external dependencies and payment gate added |
| `GET /api/ordensServico/:cpfCnpj/detalhes` | Same | Retained; remains public; details use remote catalog lookups |

The customer, vehicle, authentication, and health route files are byte-for-byte unchanged from main. The order routes add downstream-service error handling without changing their verbs or paths.

### Behavior changes despite unchanged order URLs

- Order responses include status history.
- Catalog lookup, execution scheduling, stock operations, estimate creation, and approval checks now cross service boundaries.
- Downstream failures can return HTTP 502. Order creation may have already persisted the order; `orderId` is included when applicable.
- Transition to `ENTREGUE` now requires Billing's confirmed-payment check. Main did not have this payment gate.
- Stock consumption now receives the order ID to support the new idempotency contract.

## 2. Parts: five old routes, two replacements

New owner: Execution at `http://localhost:3001`.

| Main endpoint | Main controller method | Current replacement | Classification |
| --- | --- | --- | --- |
| `GET /api/pecas` | `getAllPecas` | None | Missing HTTP replacement |
| `GET /api/pecas/:id` | `getPecaById` | `GET /internal/parts/:id` | Moved/renamed |
| `POST /api/pecas` | `createPeca` | `POST /internal/parts` | Moved/renamed |
| `PUT /api/pecas/:id` | `updatePeca` | None | Missing HTTP replacement |
| `DELETE /api/pecas/:id` | `deletePeca` | None | Missing HTTP replacement |

The new handlers call `BuscarPecaPorIdUseCase.execute` and `CriarPecaUseCase.execute` directly. `PecaController` retains all five original method names in both repositories, but the new server does not mount it.

## 3. Services: five old routes, two replacements

New owner: Execution at `http://localhost:3001`.

| Main endpoint | Main controller method | Current replacement | Classification |
| --- | --- | --- | --- |
| `GET /api/servicos` | `getAllServicos` | None | Missing HTTP replacement |
| `GET /api/servicos/:id` | `getServicoById` | `GET /internal/services/:id` | Moved/renamed |
| `POST /api/servicos` | `createServico` | `POST /internal/services` | Moved/renamed |
| `PUT /api/servicos/:id` | `updateServico` | None | Missing HTTP replacement |
| `DELETE /api/servicos/:id` | `deleteServico` | None | Missing HTTP replacement |

The new handlers call `BuscarServicoPorIdUseCase.execute` and `CriarServicoUseCase.execute` directly. `ServicoController` retains all five original method names, but is not mounted by Execution's server.

## 4. Inventory: four old routes, movement command redesigned

New owner: Execution at `http://localhost:3001`.

| Main endpoint | Main controller method | Current replacement | Classification |
| --- | --- | --- | --- |
| `GET /api/estoque` | `getAllEstoque` | None | Missing HTTP replacement |
| `GET /api/estoque/:pecaId` | `getEstoqueByPecaId` | None | Missing HTTP replacement |
| `GET /api/estoque/movimentacoes` | `listaMovimentacoes` | None | Missing HTTP replacement |
| `POST /api/estoque/movimentacoes` | `createMovimentacao` | `POST /internal/inventory/receive` and `POST /internal/inventory/consume` | Redesigned/partial |

`POST /internal/inventory/check` is an additional availability command. It returns HTTP 204 when sufficient or HTTP 409 when insufficient; it does not replace the old stock-detail GET response.

### Old movement payload

```json
{
  "pecaId": "<PART_ID>",
  "tipo": "ENTRADA",
  "quantidade": 10,
  "origem": "compra"
}
```

### New receipt payload

```http
POST /internal/inventory/receive
```

```json
{
  "pecaId": "<PART_ID>",
  "quantidade": 10,
  "operationId": "receipt-001"
}
```

### New consumption payload

```http
POST /internal/inventory/consume
```

```json
{
  "pecaId": "<PART_ID>",
  "quantidade": 1,
  "ordemServicoId": "<ORDER_ID>"
}
```

The new API requires explicit idempotency identities, accepts positive integer quantities, and returns HTTP 204 instead of the old HTTP 201 movement document. General movement origins and arbitrary stock adjustments are not preserved as an equivalent exposed contract.

`EstoqueController` still contains its original four methods. The mounted implementation instead calls `OperarInventarioUseCase.check`, `.receive`, and `.consume` using the atomic per-part inventory gateway. Operations across multiple parts still lack a shared transaction.

## 5. Estimates: two old routes, decision operation narrowed

New owner: Billing at `http://localhost:3002`.

| Main endpoint | Main controller method | Current replacement | Classification |
| --- | --- | --- | --- |
| `PUT /api/orcamentos/:id` | `updateOrcamento` | `POST /internal/estimates/:id/decision` → `EstimateController.decide` | Redesigned/partial |
| `GET /api/orcamentos/:ordemServicoId` | `getOrcamentosByOrdemServicoId` | None | Missing HTTP replacement |

The previous update accepted `ordemServicoId`, `versao`, `status`, `valorTotal`, and `validadeEm`. The new decision endpoint accepts only an approval/rejection command. It does not support arbitrary edits to the amount, version, expiry, or order association.

### Decision request migration

Old:

```http
PUT /api/orcamentos/<OLD_ESTIMATE_ID>
Authorization: Bearer <JWT>
Content-Type: application/json

{"status":"APROVADO"}
```

New:

```http
POST /internal/estimates/<NEW_ESTIMATE_UUID>/decision
x-internal-api-key: <BILLING_INTERNAL_API_KEY>
Content-Type: application/json

{"decision":"APPROVED"}
```

| Old status | New counterpart | Note |
| --- | --- | --- |
| `PENDENTE` | `PENDING` | Set by estimate creation |
| `APROVADO` | `APPROVED` | Decision command |
| `REPROVADO` | `REJECTED` | Decision command |
| `EXPIRADO` | No equivalent decision command | Decision eligibility checks `expires_at`; callers cannot submit `EXPIRED` as a decision |

New decisions must target the latest estimate and, for a changed decision, an unexpired pending estimate. Repeating the same decision is idempotent. This is stricter than main's general update operation.

### Response and identifier changes

| Main response | New Billing response |
| --- | --- |
| MongoDB estimate ID | UUID estimate ID |
| `ordemServicoId` | `order_id` |
| `versao` | `version` |
| `valorTotal` in currency units | `total_cents` in cents; observed as a JSON string |
| Separate `pecas` and `itensServicos` arrays | Combined `items`, with `kind`, `precoCents`, and quantity |
| `validadeEm`, `criadoEm` | `expires_at`, `created_at`, plus `decision_at` |
| Portuguese status values | English status values |

The new `GET /internal/orders/:id/estimate-approval` returns only `{"approved":boolean}`. It is not a replacement for listing estimate versions and their full snapshots.

There is also no mounted `GET /internal/estimates/:id`. Service Orders currently discards the estimate creation response, making estimate ID discovery an integration gap. Reposting an identical snapshot returns the existing estimate, but does not restore the missing history/read API.

## 6. Execution lifecycle and metrics: all four old routes missing

Intended owner: Execution at `http://localhost:3001`.

| Main endpoint | Main controller method | Current replacement | Classification |
| --- | --- | --- | --- |
| `GET /api/execucoes-servico/:ordemServicoId` | `getExecucoesByOrdemServicoId` | None | Missing HTTP replacement |
| `PATCH /api/execucoes-servico/:id/iniciar` | `iniciarExecucao` | None | Missing HTTP replacement |
| `PATCH /api/execucoes-servico/:id/finalizar` | `finalizarExecucao` | None | Missing HTTP replacement |
| `GET /api/metricas/tempo-medio-servicos` | `getTempoMedioServicos` | None | Missing HTTP replacement |

`POST /internal/executions` schedules executions. It does not list, start, finish, or compute metrics for them.

All four `ExecucaoServicoController` methods and their associated use-case files still exist in Execution, but are not mounted. The start/finish use cases still depend on the inherited order gateway interface; the new service needs an appropriate cross-service integration before exposing them safely.

Main's `FinalizarExecucaoUseCase` automatically marked the order `FINALIZADA` when all executions finished. Although that code was copied, the new HTTP API cannot reach it. The equivalent automatic completion behavior is therefore unavailable through the current APIs.

Billing's new `POST /internal/orders/:id/execution-complete` records a trusted completion signal for checkout. It does not finish an Execution record or update a Service Orders order. No automatic producer currently sends that signal.

## 7. Internal method migration

These are orchestration methods, not all previously public endpoints. Their names mostly stayed the same while their implementations changed from in-process calls to HTTP.

| Main method/implementation | Current method/implementation | Result |
| --- | --- | --- |
| `PecaLookupAdapter.findById` | `PecaHttpAdapter.findById` → `GET /internal/parts/:id` | Adapter class replaced; method name retained |
| `ServicoLookupAdapter.findById` | `ServicoHttpAdapter.findById` → `GET /internal/services/:id` | Adapter class replaced; method name retained |
| `ExecucaoServicoPortAdapter.createExecucoesParaServicos` | `ExecutionHttpAdapter.createExecucoesParaServicos` → `POST /internal/executions` | Method name retained; remote scheduling |
| `EstoqueMovimentacaoAdapter.assertQuantidadeDisponivel` | `ExecutionHttpAdapter.assertQuantidadeDisponivel` → `POST /internal/inventory/check` | Method retained; optional order ID added |
| `EstoqueMovimentacaoAdapter.registrarSaidaOS` | `ExecutionHttpAdapter.registrarSaidaOS` → `POST /internal/inventory/consume` | Method retained; implementation requires order ID |
| `OrcamentoPortAdapter.createPendente` | `BillingHttpAdapter.createPendente` → `POST /internal/estimates` | Method retained; remote persistence and outbox |
| `OrcamentoPortAdapter.isLatestOrcamentoApproved` | `BillingHttpAdapter.isLatestOrcamentoApproved` → `GET /internal/orders/:id/estimate-approval` | Method retained; boolean HTTP result |
| No main equivalent | `BillingHttpAdapter.isPaymentConfirmed` → `GET /internal/orders/:id/payment-status` | New method and delivery gate |

The stock port now declares an optional third `ordemServicoId` parameter. Actual order stock-consumption calls supply it; the HTTP adapter rejects consumption without it.

### Underlying use cases

| Previous use case | Active replacement | Meaning |
| --- | --- | --- |
| `CriarExecucoesParaServicosUseCase` | `AgendarExecucoesUseCase` | Scheduling rewritten for the service boundary; trusts the authenticated caller for order existence and validates the local service catalog |
| `RegistrarMovimentacaoEstoqueUseCase` in the exposed movement flow | `OperarInventarioUseCase` and atomic inventory gateway | New operation-specific inventory implementation |
| `CriarOrcamentoPendenteUseCase` | `PrepareEstimateUseCase` + PostgreSQL gateway `create` | Snapshot validation, deduplication/versioning, transactional persistence |
| `VerificarUltimoOrcamentoAprovadoUseCase` | `CheckEstimateApprovalUseCase` + PostgreSQL gateway `isApproved` | Latest-estimate approval query |
| Approval/rejection portion of `AtualizarOrcamentoUseCase` | `DecideEstimateUseCase` + PostgreSQL gateway `decide` | Restricted decision operation |

These are implementation replacements rather than evidence that the old class files were deleted.

## 8. Newly mounted endpoints without a direct main HTTP equivalent

The current Execution server mounts eight business endpoints plus `/health` and `/ready`. Four are the catalog replacements above; inventory receipt/consumption partially replace one old movement endpoint. These additional routes expose previously internal orchestration operations:

| Owner | New endpoint | Handler/use case |
| --- | --- | --- |
| Execution | `POST /internal/inventory/check` | `OperarInventarioUseCase.check` |
| Execution | `POST /internal/executions` | `AgendarExecucoesUseCase.execute` |
| Billing | `POST /internal/estimates` | `EstimateController.create` |
| Billing | `GET /internal/orders/:id/estimate-approval` | `EstimateController.checkApproval` |
| Billing | `POST /internal/orders/:id/execution-complete` | `executionComplete` |
| Billing | `POST /internal/orders/:id/checkout` | `checkout` |
| Billing | `GET /internal/orders/:id/payment-status` | `paymentStatus` |
| Billing | `GET /internal/payments/:id` | `getPayment` |
| Billing | `POST /internal/payments/:id/reconcile` | `reconcileManually` |
| Billing | `POST /webhooks/mercado-pago` | `mercadoPagoWebhook` |

Billing also mounts the decision replacement documented above and its own `/health` and `/ready`, for nine business endpoints and two health endpoints in total.

The health URLs are the same on each service's own base URL. Swagger UI `/docs` and OpenAPI `/swagger.json` remain Service Orders documentation routes and are outside the 40-endpoint business/health baseline.

## 9. Compatibility impact

### Existing clients will need changes

1. Replace the four supported part/service paths and their service base URL.
2. Use internal service credentials for trusted integrations. The previous routes accepted a user JWT; new `/internal` routes accept `x-internal-api-key`. Browser/mobile clients need an authenticated public entry point rather than exposure of internal secrets.
3. Replace estimate status updates with decision commands, translate status values, and handle UUIDs and the new response schema.
4. Replace stock movements with receipt/consumption commands and preserve idempotency identifiers.
5. Account for the 14 missing read/update/delete/lifecycle endpoints. Renaming URLs cannot restore those capabilities.

No backward-compatible aliases, redirects, or proxy route groups for the removed `/api` paths are mounted in the inspected applications. A route file remaining in the repository does not make that endpoint available.

### Main functionality still requiring migration

- Part/service listing, updating, and deletion: six endpoints.
- Inventory listing, stock detail, and movement history: three endpoints.
- Estimate history/listing: one endpoint, plus general estimate editing beyond decisions.
- Execution listing, start, finish, and average-duration metrics: four endpoints.
- Automatic order completion when all executions finish, and the new reliable completion notification to Billing.

## 10. Evidence and verification

The route inventory was extracted from main's actual router registrations and `app.use` mounts, deduplicating conditional login registration. The current Service Orders mount list was compared with Execution's server and Billing's estimate/payment routers. Controllers were compared byte-for-byte to distinguish retained source from exposed behavior.

Important source files:

| Repository | File | Evidence |
| --- | --- | --- |
| Main baseline | [app.ts at main commit](https://github.com/RuannGodinho/TechChallenge-Fiap/blob/51ca91e1d8c1e12b58936b7d067d2b960c0dc4fd/app.ts) | Previously mounted route groups |
| Main baseline | [HTTP route directory](https://github.com/RuannGodinho/TechChallenge-Fiap/tree/51ca91e1d8c1e12b58936b7d067d2b960c0dc4fd/src/infrastructure/http) | Old endpoint contracts |
| Main baseline | [Controller directory](https://github.com/RuannGodinho/TechChallenge-Fiap/tree/51ca91e1d8c1e12b58936b7d067d2b960c0dc4fd/src/Adapters/controllers) | Old method names |
| Service Orders working tree | `app.ts` | Only customer, vehicle, auth, order, and health groups mounted |
| Service Orders working tree | `src/Adapters/adapters/service-http.adapter.ts` | New remote port implementations |
| Service Orders working tree | `src/infrastructure/composition-root/di-container.ts` | Wiring to HTTP adapters |
| Execution working tree | `src/main/server.ts` | Complete mounted Execution endpoint set |
| Execution working tree | `src/Adapters/controllers/*.ts` | Retained controllers, not mounted by the server |
| Execution working tree | `src/application/usecases/execucao-servico/finalizar-execucao.usecase.ts` | Copied automatic completion logic |
| Billing Downloads working tree | `src/server.ts` | Internal authentication and route mounting |
| Billing Downloads working tree | `src/infrastructure/http/estimate-routes.ts` | Estimate route set |
| Billing Downloads working tree | `src/infrastructure/http/payment-routes.ts` | Payment/completion/webhook route set |
| Billing Downloads working tree | `src/Adapters/controllers/estimate.controller.ts` | New decision contract |
| Billing Downloads working tree | `src/Adapters/gateways/estimate.postgres.gateway.ts` | New estimate response, IDs, versioning, and outbox |

See [MICROSERVICES-FLOW.md](MICROSERVICES-FLOW.md) for the complete workflow and local setup observations.
