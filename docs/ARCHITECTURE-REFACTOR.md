# Refactoring the restored endpoints

The original HTTP verbs, paths, payloads, and response shapes are preserved. Endpoint restoration was committed and pushed before this refactoring:

| Repository | Branch | Endpoint commit |
| --- | --- | --- |
| Billing | `feat/billing` | `a1e0e9e` |
| Execution | `feat/execution` | `2beb24c` |
| Service Orders | `feat/microsservices` | `a1e4140` |

## Billing

`OrcamentoController` now delegates to `ListarOrcamentosPorOrdemUseCase` and `AtualizarOrcamentoUseCase`. It receives no database connection and contains no SQL.

The `Orcamento` aggregate owns update eligibility, pending/decided state rules, expiry checks, and total consistency. A shared domain decision policy is used by both legacy updates and the existing internal decision use case. The application normalizes the incoming DTO and applies the domain policy within an abstract transaction boundary.

`OrcamentoRepository` and `LockedOrcamento` describe the required storage capabilities without PostgreSQL types. `OrcamentoPostgresGateway` supplies locking, queries, commits, rollback, and atomic outbox persistence. Storage rows are translated by a mapper; legacy HTTP fields are produced by a presenter. Concrete objects are assembled in the composition root.

## Execution

`AtomicEstoqueController` now delegates to stock query and movement use cases. Movement validation uses the domain value objects. The `AtomicStockPort` exposes stock views and atomic movement persistence without MongoDB types. `AtomicStockMongoGateway` preserves the existing atomic stock/history update and idempotency behavior; the presenter maps application views to the original response fields.

`ExecutionOrderPort` contains only `findById` and `complete`. Its read result is an Execution-owned view with the order identity and `canStart` eligibility. The HTTP adapter no longer reconstructs a Service Orders aggregate, validates only the remote fields it needs, and has no unsupported CRUD methods. Start/finish use cases depend on this narrow port. Execution reports completion of its signal; Service Orders owns the order-transition events.

## Service Orders

`ConcluirExecucaoOrdemUseCase` handles completion, persistence ordering, concurrency retries, observability, and notification. The `OrdemServico` aggregate applies its existing transition rules through `concluirExecucao`.

`OrderCompletionRepository` exposes lookup and compare-and-set transition persistence. The MongoDB gateway writes the transition decided by the domain rather than deciding the target status itself. Concurrent completions reload the order after a failed compare-and-set update.

`ExecutionCompletionNotifier` separates the application from HTTP and message-ID generation. The Billing adapter preserves the existing deterministic completion ID. A repeated finish request retries notification without writing another finalization transition. This remains synchronous retry handling rather than a durable background delivery mechanism.

The internal HTTP routes now authenticate, validate route parameters, invoke an injected controller, and map errors to HTTP responses. They do not access repositories or construct Billing clients.

## Dependency corrections

- `VeiculoId` no longer imports MongoDB. Its existing 24-hex-character identifier contract is validated without a database driver.
- The part type enum belongs to the domain; the previous validator module remains a compatibility export.
- Customer listing uses an optional observability port rather than importing the infrastructure logger.
- Composition roots assemble database and HTTP adapters outside the application/domain layers.

## Verification and scope

Each repository provides `npm run check:architecture`. The source import check rejects database/transport framework dependencies in domain/application code, outward imports into infrastructure/adapters, and direct database imports in controllers. CI runs this check alongside the normal build/type checks and tests.

The check enforces dependency boundaries; it does not prove every SOLID or DDD property. Existing inherited files outside these restored flows were not comprehensively redesigned.

Tests cover pure estimate invariants, narrow HTTP integration, movement validation, stock concurrency, completion compare-and-set retries, authentication, and HTTP compatibility. The cross-service flow is also exercised using separate temporary databases and actual HTTP calls, without charging payments or altering existing application records.
