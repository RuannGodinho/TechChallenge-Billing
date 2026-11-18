# Kubernetes — billing

Cobertura de APM, logs das APIs/workers, implantação e consultas NRQL: [New Relic](NEW-RELIC.md).

Imagem: ruanngodinho/techchallenge-billing. API: billing; workers: billing-workers; banco: postgres-deployment, mantido no infra-db.

## Organização e custo

O desenho reutiliza o TechChallenge-Fiap e o Terraform existentes. Não cria outro cluster, load balancer ou instalação de Metrics Server/New Relic.

| Serviço | API base | Workers agrupados | HPA da API | NodePort |
|---|---:|---:|---|---:|
| Service Orders | 1 | 1 (3 processos) | 1–4, CPU 60% | 30080 |
| Execution | 1 | 1 (2 processos) | 1–4, CPU 60% | 30081 |
| Billing | 1 | 1 (4 processos) | 1–4, CPU 60% | 30082 |

São **6 pods de aplicação em execução na base** e até **15** com as três APIs no máximo do HPA. Acrescentam-se 4 pods persistentes do infra-db, componentes do cluster/New Relic e pods temporários de rollout, inicialização e seed. Jobs concluídos continuam listados até serem removidos, conforme o padrão existente.

Cada API replica requests de 100m CPU/128Mi e limits de 500m/256Mi do Fiap. O HPA controla as réplicas; o manifest da API omite replicas para não redefinir a escala em cada deploy. Os workers mantêm uma réplica e o padrão do consumer existente, sem HPA nem novos valores de requests/limits. Agrupar processos reduz pods, mas não garante redução proporcional de RAM; os processos compartilham reinício e escala. O HPA das APIs não aumenta a quantidade de workers nem a capacidade dos nodes.

As configurações existentes de SPOT, tipos/quantidade de nodes e armazenamento permanecem iguais. O Terraform do infra-eks passa a usar EKS 1.37; a atualização de um cluster existente exige etapas por versão minor (ver README do infra-eks). Capacidade e escalabilidade em carga precisam ser verificadas no cluster; a configuração não foi aplicada na AWS. Não pressupor que um único t3.small acomode os workloads e todos os componentes do cluster.

## Ordem de implantação

1. TechChallenge-infra-eks: revisar o plano e aplicar os NodePorts/SSM dos três serviços.
2. TechChallenge-infra-db: executar CD com confirm=yes; cria os bancos e o RabbitMQ compartilhado.
3. TechChallenge-Fiap: executar CD primeiro, pois mantém Metrics Server e o operador New Relic compartilhados.
4. Execution e Billing: executar seus CDs; aguardam o banco/broker, aplicam instrumentação, API, HPA, workers e seed.
5. TechChallenge-lambda-auth: revisar o plano e aplicar as rotas dos serviços.

Os manifests usam o namespace default do padrão existente. A instrumentação fica em newrelic. Cada CD mantém os mesmos gatilhos e tags do Fiap: CI aprovado em main/develop/release ou execução manual com confirm=yes; release usa homolog, demais usam latest. Os branches compartilham o mesmo ambiente do modelo original.

Mantenha SAGA_ENABLED=false no ConfigMap do Orders durante o primeiro deploy. Após todos os participantes estarem prontos, altere esse valor para true e faça novo rollout do Orders para iniciar novas OS pelo fluxo Saga. Os workers dos participantes já ficam ativos. As chaves de integração e o broker devem ser consistentes antes desse passo.

## Validação no cluster

```bash
kubectl get deploy api-deployment service-orders-billing-consumer execution-deployment execution-workers billing billing-workers
kubectl get hpa api-hpa execution-hpa billing-hpa
kubectl top pods
kubectl get pods -A
kubectl get pvc
kubectl get events --sort-by=.lastTimestamp
```

Confirmar READY nos Deployments, TARGETS numéricos nos HPAs, PVCs Bound e ausência de Pending/OOMKilled. Verificar a escala com carga e medir memória/CPU dos workers antes de alterar limites, réplicas ou nodes.

O Gateway mantém JWT nas rotas /api: pecas, servicos, estoque, execucoes-servico e metricas vão ao Execution; orcamentos vai ao Billing; o restante continua no Orders. POST /webhooks/mercado-pago vai ao Billing sem JWT e valida assinatura no aplicativo. /internal permanece sem rota pública no Gateway. Configurar no Mercado Pago a URL HTTPS do Gateway com esse caminho; checkout exige as credenciais reais do provedor. Smoke tests locais de Docker não validam o pagamento nem a implantação AWS.

## Configuração deste repositório

Secrets de GitHub Actions: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, DOCKERHUB_USERNAME e DOCKERHUB_PASSWORD. Variables opcionais: TF_AWS_REGION (us-east-1), TF_CLUSTER_NAME (techchallenge-eks).

Secrets de runtime obrigatórios: DATABASE_URL, INTERNAL_API_KEY, GATEWAY_TRUST_SECRET, RABBITMQ_URL, SMTP_HOST, SMTP_PORT, SMTP_FROM e ESTIMATE_EMAIL_TO. SMTP_USER/SMTP_PASS dependem do provedor; JWT_SECRET é opcional no modo gateway. MERCADO_PAGO_ACCESS_TOKEN e MERCADO_PAGO_WEBHOOK_SECRET são necessários para validar pagamento e webhook. INTERNAL_API_KEY deve coincidir com BILLING_INTERNAL_API_KEY no Orders.

Use DATABASE_URL=postgresql://billing:<senha-codificada>@postgres-service:5432/billing; a senha precisa corresponder a POSTGRES_PASSWORD no infra-db. Codifique caracteres especiais da senha na URI. Use um SMTP acessível pelo cluster e ajuste SMTP_SECURE no ConfigMap conforme o provedor; Mailpit pertence ao desenvolvimento local. O init container migrate usa a mesma imagem/tag da API e o lock transacional existente, inclusive durante escala pelo HPA.

Compartilhe GATEWAY_TRUST_SECRET entre os três apps e o lambda-auth. Use o mesmo RABBITMQ_URL nos três apps, com usuário, senha e vhost do infra-db: amqp://<usuario-codificado>:<senha-codificada>@rabbitmq-service:5672/oficina. Não copie a URL de Docker com localhost/host.docker.internal para o EKS.

O CD gera o Secret a partir dos GitHub Secrets sem gravá-lo no repositório. k8s/secrets/api-secrets.yml.example contém somente placeholders; para deploy manual, copie para api-secrets.yml (ignorado pelo Git) e preencha. dockerhub-cred é compartilhado e atualizado pelo CD.

## Manifests

- k8s/Api-deployment.yml: API, probes /health e /ready; Billing também executa migrations.
- k8s/Api-service.yml: NodePort seguindo o padrão do Fiap.
- k8s/API-hpa.yml: HPA apenas da API.
- k8s/workers-deployment.yml: todos os workers próprios em um container supervisionado.
- k8s/api-seed-job.yml: seed uma vez; não recria se o Job já existe.
- k8s/instrumentation.yaml: reutiliza o operador New Relic instalado pelo Fiap.
- k8s/secrets/Api-configmap.yml e Secret: configuração de runtime.

A imagem/tag é aplicada localmente ao manifest antes do kubectl apply, incluindo migrate/seed. imagePullPolicy=Always mantém a atualização de tags latest/homolog. Cada grupo de workers é reiniciado pelo CD para reler configuração e imagem.
