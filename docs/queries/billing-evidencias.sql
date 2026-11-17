-- TechChallenge Billing: consultas de evidência, somente leitura.
-- Substitua todas as ocorrências de COLE_ID_DA_OS pelo ObjectId da OS.
-- Execute no banco billing pelo DBeaver, após abrir o port-forward.
-- Não use o UUID do orçamento no lugar do ID da OS.

-- 1. Orçamentos e versões. A validade em texto preserva os microssegundos.
SELECT id AS orcamento_id, order_id AS os_id, version AS versao,
       status, total_cents / 100.0 AS valor_reais,
       created_at AS criado_em, expires_at::text AS validade_exata,
       decision_at AS decidido_em, items AS itens
FROM estimates
WHERE order_id = 'COLE_ID_DA_OS'
ORDER BY version;

-- 2. Gate de conclusão recebido pelo Billing.
SELECT order_id AS os_id, estimate_id AS orcamento_id,
       message_id, completed_at AS recebido_em
FROM completed_executions
WHERE order_id = 'COLE_ID_DA_OS';

-- 3. Tentativas de pagamento e correlação com o Mercado Pago.
SELECT id AS tentativa_id, order_id AS os_id, estimate_id AS orcamento_id,
       status, provider_status AS status_provedor,
       amount_cents / 100.0 AS valor_reais, currency AS moeda,
       provider_order_id, created_at AS criado_em, updated_at AS atualizado_em
FROM payment_attempts
WHERE order_id = 'COLE_ID_DA_OS'
ORDER BY created_at;

-- 4. Notificações de pagamento já registradas.
SELECT n.notification_id, n.provider_order_id, n.processed_at,
       p.id AS tentativa_id, p.status
FROM processed_notifications n
JOIN payment_attempts p ON p.provider_order_id = n.provider_order_id
WHERE p.order_id = 'COLE_ID_DA_OS'
ORDER BY n.processed_at;

-- 5. Publicação dos eventos de negócio e envio de e-mail.
-- published_at = confirmação de publicação, não confirmação de consumo.
-- email_sent_at = aceitação pelo SMTP, não garantia de chegada à caixa de entrada.
SELECT o.id AS message_id, o.kind AS evento, e.id AS orcamento_id,
       o.created_at, o.published_at, o.attempts,
       o.next_attempt_at, o.last_error,
       o.email_sent_at, o.email_attempts, o.email_last_error,
       o.payload
FROM outbox o
JOIN estimates e ON e.id = o.aggregate_id
WHERE e.order_id = 'COLE_ID_DA_OS'
ORDER BY o.created_at;

-- 6. Resultados da Saga publicados pelo Billing.
SELECT id AS message_id,
       event->>'eventType' AS evento,
       event->>'occurredAt' AS ocorrido_em,
       event->'data'->>'sagaId' AS saga_id,
       event->'data'->>'commandId' AS command_id,
       event->'data'->>'commandType' AS comando,
       event->'data'->>'ok' AS sucesso,
       event->'data'->>'decision' AS decisao,
       event->'data'->>'error' AS erro_negocio,
       published_at, attempts, next_attempt_at, last_error, event
FROM saga_outbox
WHERE event->>'orderId' = 'COLE_ID_DA_OS'
ORDER BY event->>'occurredAt', id;

-- 7. Tentativas e recibos de comandos da Saga no Billing.
SELECT saga_id, order_id AS os_id, attempt AS tentativa,
       estimate_id AS orcamento_id, cancelled AS cancelada
FROM saga_participations
WHERE order_id = 'COLE_ID_DA_OS'
ORDER BY attempt;

SELECT command_id,
       result->>'messageId' AS resultado_message_id,
       result->'data'->>'commandType' AS comando,
       result->'data'->>'ok' AS sucesso,
       result->'data'->>'error' AS erro_negocio,
       result
FROM saga_inbox
WHERE result->>'orderId' = 'COLE_ID_DA_OS'
ORDER BY result->>'occurredAt', command_id;
