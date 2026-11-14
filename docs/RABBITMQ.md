# Local RabbitMQ and asynchronous execution completion

## Start each repository independently

Each repository owns its API, database, and workers. No startup script, profile flag, sibling directory, or checkout of another repository is required.

Configure each repository's `.env` from its own `.env.example`, preserving existing database passwords and API/JWT keys. Use the same RabbitMQ user, password, and vhost in every `RABBITMQ_URL`; URL-encode credentials in the connection URL.

Run this command **inside each repository**:

```bash
docker compose up -d --build
```

| Repository | Starts by default |
| --- | --- |
| Billing | PostgreSQL, migrations/API, outbox publisher, execution consumer, email worker, RabbitMQ, Mailpit |
| Execution | MongoDB, replica-set initializer, API, execution publisher |
| Service Orders | MongoDB, API, billing consumer, execution consumer |

For local development, start Billing first because its Compose owns the one shared RabbitMQ broker. Execution and Service Orders connect through the published AMQP port; their Compose files do not reference Billing's files or Docker network. They can also start before the broker: messaging workers retry the connection until it becomes available. APIs retain their existing HTTP contracts and cross-service HTTP URL configuration.

- Billing workers: `RABBITMQ_URL=amqp://<user>:<password>@rabbitmq:5672/<vhost>`.
- Execution / Service Orders on the same Docker host: `RABBITMQ_URL=amqp://<user>:<password>@host.docker.internal:5672/<vhost>`. Their Compose files include the host-gateway mapping for Linux Docker Engine. On Linux, also set Billing's `RABBITMQ_BIND_ADDRESS` to a host address reachable from containers (for example `0.0.0.0` on a trusted development host); the default loopback bind is intended for Docker Desktop.
- Separate machines/environments: configure the reachable broker hostname in `RABBITMQ_URL` and provision access to that broker. The local broker ports bind to loopback; expose it through appropriate infrastructure for remote deployments.
- Management UI: http://localhost:15672. Credentials are Billing's `RABBITMQ_USER`, `RABBITMQ_PASSWORD`, and `RABBITMQ_VHOST`.
- Local email inbox: http://localhost:8025. Mailpit captures development mail; it does not deliver it to external recipients. Use `SMTP_HOST=mailpit`, `SMTP_PORT=1025`, `SMTP_SECURE=false`, with empty SMTP credentials. Configure another SMTP host explicitly for real delivery. [Mailpit Docker documentation](https://mailpit.axllent.org/docs/install/docker/).

Billing's messaging workers wait for healthy RabbitMQ and for API migrations to finish. Its email worker waits for migrations and Mailpit. All workers start by default and restart automatically; no Compose profiles are required. Workers that connect to an external broker reconnect independently of API startup.

### Existing local broker migration

The old standalone `compose.rabbitmq.yml` and orchestration scripts are superseded by each repository's default Compose file. If `oficina-rabbitmq` was created by that old standalone project, stop and remove only that container once before starting Billing's new Compose:

```bash
docker stop oficina-rabbitmq
docker rm oficina-rabbitmq
docker compose up -d --build
```

This migration was already applied to the current local environment. Do not remove volumes. The default named broker volume remains `oficina-messaging_rabbitmq_data`, with the same stable hostname, so existing credentials, queues, and dead letters survive. Set `RABBITMQ_DATA_VOLUME` when using a different pre-existing volume; preserve the credentials used to initialize it. Database volume names are unchanged.

Billing owns the local broker lifecycle: stopping Billing's entire Compose project also stops RabbitMQ, while the other repositories' workers reconnect when it returns. A separately provisioned broker is appropriate when infrastructure must have an independent lifecycle.

## Publishers, consumers, and queues

| Publisher | Exchange | Binding | Queue | Consumer behavior |
| --- | --- | --- | --- | --- |
| Billing outbox worker | `billing.events` | `estimate.#`, `payment.#` | `service-orders.billing` | Record estimate/payment events on the order with message-ID deduplication |
| Execution outbox worker | `execution.events` | `execution.completed` | `service-orders.execution` | Apply the order aggregate's completion transition and record the inbox receipt |
| Execution outbox worker | `execution.events` | `execution.completed` | `billing.execution` | Register completion against the latest eligible approved estimate |

Each main queue has a durable `.retry` queue and `.dlq`. Retry queues return a message to their own main queue after one second; one consumer's retry is not broadcast to the other consumer. Processing errors receive up to three retries after the initial delivery. Invalid event schemas go directly to the dead-letter queue.

The exchanges `billing.events.dlx` and `execution.events.dlx` route exhausted/rejected messages to the matching consumer's DLQ. Workers declare the same topology idempotently before publishing or consuming.

## Runtime processes

| Repository | Compose service | npm command |
| --- | --- | --- |
| Billing | `outbox-worker` | `npm run outbox-worker` |
| Billing | `execution-consumer` | `npm run execution-consumer` |
| Billing | `email-worker` | `npm run email-worker` |
| Execution | `execution-publisher` | `npm run execution-publisher` |
| Service Orders | `billing-consumer` | `npm run billing-consumer` |
| Service Orders | `execution-consumer` | `npm run execution-consumer` |

All workers start with their owning repository's default Compose command and restart automatically. The APIs keep their existing HTTP contracts.

## Execution completion and durability

With `EXECUTION_COMPLETION_TRANSPORT=rabbitmq`, finishing an execution persists the state transition in a MongoDB transaction. Finishing the last execution also creates exactly one `ExecutionOutbox` event in that same transaction. If event persistence fails, the execution finish is rolled back.

An `ExecutionBatches` document serializes scheduling and finishing for each order. A completed batch accepts idempotent scheduling retries for its existing services and rejects additional services. The publisher sends the outbox event independently of the HTTP request and consumer availability.

The local Execution MongoDB now runs as the single-member development replica set `execution-rs`. The initializer is idempotent and uses the existing `execution_data` volume. Containers connect with `replicaSet=execution-rs`; host-side tests use `directConnection=true` because the advertised member name belongs to Docker's network.

The completion event uses the same deterministic message ID as the previous HTTP completion notification:

```json
{
  "messageId": "<stable completion UUID>",
  "eventType": "execution.completed",
  "eventVersion": 1,
  "orderId": "<MongoDB ObjectId>",
  "occurredAt": "<last execution completion timestamp in ISO 8601>",
  "data": {
    "orderId": "<same order ID>",
    "executionIds": ["<completed execution ObjectId>"]
  }
}
```

Service Orders' event consumer invokes the finalization use case without making a second HTTP notification to Billing. Its compare-and-set domain transition is idempotent even if the process stops between applying the transition and recording `ExecutionInbox`.

Billing's completion record and deduplication are transactional in PostgreSQL. It rejects a delayed completion that would authorize an estimate created or approved after the event's occurrence time. Queries and the delivery-time payment check continue to use authenticated HTTP.

Completion is eventually consistent: an execution finish can return HTTP 200 while the order and checkout gate are still waiting for their consumers. Repeated finish requests preserve the original event identity. `EXECUTION_COMPLETION_TRANSPORT=http` selects the existing synchronous compatibility path.

## Publication guarantees and recovery

- Messages and queues are durable; the broker stores data in its volume.
- Publishers require broker confirmation, use `mandatory: true`, detect returned messages, and impose a confirmation timeout.
- Outbox rows are marked published only after successful confirmation without a return.
- Publisher leases expire after 30 seconds, allowing recovery after a crashed worker.
- Failed publishes are retried with increasing delay, up to 60 seconds, with a maximum of ten attempts.
- Consumers acknowledge only after their application/database work succeeds. Repeated deliveries are expected and deduplicated.
- No network call occurs inside the Execution database transaction.

Inspect parked events in PostgreSQL `outbox` or MongoDB `ExecutionOutbox`: check the attempt count, last error, next-attempt time, and lease. After fixing the cause, an operator can reset that specific event's attempts and due time and clear its lease. Preserve its event/message ID.

Inspect consumer DLQs and worker logs before replaying. Replay a corrected/recoverable message to its original queue with the same message ID and reset `x-retry-count`; do not indiscriminately purge queues. The old isolated Billing example `os-teste-001` is not a MongoDB order ID, so its historical events are correctly rejected by the Service Orders consumer.

## Tests

Run each repository's type/build checks, tests, and `npm run check:architecture`.

Execution's atomic outbox tests use an isolated database on the local replica set:

```bash
TEST_EXECUTION_MONGO_URL='mongodb://127.0.0.1:27018/?directConnection=true' \
npm test -- --runInBand --coverage=false
```

The optional cross-service test requires the three source checkouts (or its project-directory environment overrides). Runtime startup does not. The test uses temporary MongoDB databases, a PostgreSQL schema, and an isolated RabbitMQ vhost. It checks normal delivery, deduplication, stopped consumers, retries, and dead-letter handling:

```bash
node scripts/test-rabbitmq-flow.cjs
```

Opt into the broker restart/recovery test explicitly:

```bash
RUN_RABBITMQ_RESTART_TEST=1 node scripts/test-rabbitmq-flow.cjs
```

That option briefly restarts the local `oficina-rabbitmq` container. The test does not charge payments and removes its own databases, schema, and vhost afterwards.
