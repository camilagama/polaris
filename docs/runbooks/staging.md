# Staging fixo

Status: configuração no repositório, nada criado. Os recursos, os segredos e o primeiro deploy são do responsável (Arrascaeta ou o usuário). Decisões e motivos: [ADR 0097](../adr/0097-staging-fixo-e-producao-em-conta-separada.md).

O staging é um ambiente fixo na conta Cloudflare atual, com dados **só sintéticos**. A produção vai para outra conta Cloudflare e outra organização ou projeto Neon, no go-live (Fase 15).

## Gatilho

- Criar o staging pela primeira vez (seções 1 a 6).
- Ligar o deploy automático (seção 7), só depois do ADR 0096 (expand/contract) estar na `main`.
- Provar os itens 3, 14, 15 e 16 do [release-checklist](./release-checklist.md) e o Gate 5 manual (seção 9).

## Pré-requisitos de acesso

- Wrangler e Neon CLI com o perfil autorizado pela [política de perfis de CLI](./cli-profile-policy.md), na conta **atual**. Nada aqui toca a conta de produção.
- Console do Google Cloud, para o cliente OAuth (seção 4).
- Administração do repositório no GitHub, para o Environment e a variável (seções 6 e 7).
- Nenhum valor de segredo, connection string ou token vai para o repositório, PR, log ou relatório. Os registros citam só nomes e datas.

## Alvo seguro

- Workers `polaris-web-staging` e `polaris-catalog-staging`. O Admin **não** é implantado no staging.
- Projeto Neon `polaris-staging`, com o marcador `polaris.environment = 'staging'`. Nunca o projeto dos gates (`green-tooth-16857010`), que nunca recebe dado real.
- O topo de cada `wrangler.jsonc` é só local: um deploy sem `--env staging` (ou sem `CLOUDFLARE_ENV=staging` na build) falha.

## 1. Banco (responsável)

1. Criar o projeto Neon Free `polaris-staging` em `aws-sa-east-1`, com PostgreSQL 18, só a branch `main` e compute de 0,25 CU com autosuspend de 5 min.
2. Com o dono (`neondb_owner`) e a URL **direta**, sem pooler:
   - `ALTER DATABASE neondb SET polaris.environment = 'staging';`
   - `CREATE ROLE polaris_pr11_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS;` (o papel de tenant vive fora das migrations, como no CI).
3. Aplicar as migrations do zero com a mesma URL: `bun run --filter @polaris/db db:migrate` com `DATABASE_URL` no ambiente do comando. Antes, `STAGING_MIGRATOR_DATABASE_URL=… bun run --filter @polaris/db staging:verify-database before-migrate`. Depois, o mesmo comando com `after-migrate`.
4. Criar um login por binding, cada um membro de **um** grupo, sem `SUPERUSER`, `CREATEROLE`, `CREATEDB`, `BYPASSRLS` nem `TEMP`, fora de `neon_superuser`, com `statement_timeout` e `CONNECTION LIMIT`. A senha entra por variável do psql e nunca aparece no histórico:

   | Binding | Grupo | Limite de conexões |
   | --- | --- | --- |
   | `HYPERDRIVE` | `polaris_pr11_runtime` | 5 |
   | `AUTH_HYPERDRIVE` | `polaris_auth_runtime` | 5 |
   | `ONBOARDING_HYPERDRIVE` | `polaris_onboarding_runtime` | 2 |
   | `MEDIA_CLEANUP_HYPERDRIVE` | `polaris_media_cleanup_runtime` | 2 |
   | `PRIVACY_HYPERDRIVE` | `polaris_privacy_runtime` | 2 |
   | `BILLING_HYPERDRIVE` | `polaris_billing_runtime` | 2 |
   | `OUTBOX_HYPERDRIVE` | `polaris_outbox_runtime` | 2 |
   | `CATALOG_HYPERDRIVE` (catálogo) | `polaris_catalog_runtime` | 2 |

   Os nomes dos logins têm `staging` (por exemplo, `polaris_staging_tenant`). Modelo: `CREATE ROLE polaris_staging_tenant LOGIN PASSWORD :'senha' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS CONNECTION LIMIT 5 IN ROLE polaris_pr11_runtime;`, seguido de `ALTER ROLE … SET statement_timeout = '10s'` e de `REVOKE TEMPORARY ON DATABASE neondb FROM …` se o login tiver recebido `TEMPORARY`. Ao fim, `staging:verify-database after-migrate` lista cada login com o grupo e falha se algum ficar sem grupo.

## 2. Recursos Cloudflare (responsável, conta atual)

- Filas: `polaris-staging-critical`, `polaris-staging-default`, `polaris-staging-media` e `polaris-staging-dlq` (`wrangler queues create <nome>`).
- R2: bucket privado `polaris-media-staging`. O `polaris-media` antigo da conta não é usado.
- Hyperdrive: as 8 configurações da tabela acima, cada uma com `--caching-disabled` e `--origin-connection-limit` igual ao limite do login, apontando para o host do projeto `polaris-staging`. Antes, apagar a do PR11, item aberto do go-live, para sobrar folga: 8 de 10.
- Os namespaces de rate limit `902016` a `902019` já estão no `wrangler.jsonc`. São reservados no primeiro deploy.

## 3. Preencher a configuração (PR do responsável ou do dev)

Trocar cada `PLACEHOLDER-…` de `env.staging` nos três `wrangler.jsonc`: o `account_id` da conta atual (não é segredo), os IDs das 8 configurações Hyperdrive e as URLs `workers.dev` (`BETTER_AUTH_BASE_URL` e `CATALOG_ORIGIN`). Depois, `bun run verify:staging-isolation` tem de passar. Enquanto houver placeholder, ele falha e o workflow não implanta.

## 4. Cliente OAuth do Google (responsável)

Quem cria é o usuário ou o Arrascaeta, num projeto do Google Cloud só do staging, nunca o da produção.

1. No [console do Google Cloud](https://console.cloud.google.com/), criar o projeto `polaris-staging`.
2. Em **Google Auth Platform → Branding**, preencher o nome `Polaris (staging)` e o e-mail de suporte.
3. Em **Audience**, escolher o tipo **External** e deixar o status de publicação em **Testing**. Não publicar o app.
4. Ainda em **Audience**, em **Test users**, adicionar os e-mails de teste (a allowlist; o limite é de 100). Só esses e-mails conseguem entrar. Qualquer outro recebe o erro de acesso do Google.
5. Em **Data Access**, deixar só os escopos `openid`, `email` e `profile`.
6. Em **Clients → Create client**, escolher **Web application**, com:
   - origem JavaScript autorizada: `https://polaris-web-staging.<subdomínio>.workers.dev`;
   - URI de redirecionamento autorizado: `https://polaris-web-staging.<subdomínio>.workers.dev/api/auth/callback/google`.
7. Gravar o ID e o segredo como segredos do Worker, sem passar pelo repositório: `wrangler secret put GOOGLE_CLIENT_ID --env staging` e `wrangler secret put GOOGLE_CLIENT_SECRET --env staging`, em `apps/web`.
8. Registrar só a data e quem criou. Para tirar alguém, basta removê-lo de **Test users**.

O login por senha fica desligado (`EMAIL_PASSWORD_AUTH_ENABLED: "false"`), e a verificação de isolamento falha se ele for ligado. Sem Cloudflare Access. O Admin não é exposto.

## 5. Segredos do Worker `polaris-web-staging` (responsável)

`BETTER_AUTH_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SYNC_PAYLOAD_HASH_SECRET` e `OFFLINE_LEASE_SECRET`, com `wrangler secret put <NOME> --env staging`. Os `*_PREVIOUS_*` ficam vazios até a primeira rotação. Nenhum segredo de staging é reaproveitado na produção. As chaves de sandbox do Asaas e da Woovi só entram no Gate 7. O catálogo não tem segredo.

## 6. GitHub (responsável)

- Environment `staging`, com os segredos `CLOUDFLARE_API_TOKEN` (só da conta atual, permissões mínimas: Workers Scripts Edit, Queues Edit, Hyperdrive Read e R2 Read; a lista final é conferida no primeiro deploy) e `STAGING_MIGRATOR_DATABASE_URL` (dono, URL direta).
- Variáveis do Environment, que não são segredo: `CLOUDFLARE_ACCOUNT_ID`, `STAGING_DATABASE_HOST` (o host do projeto `polaris-staging`), `STAGING_WEB_URL` e `STAGING_CATALOG_URL`.
- A restrição de branch do Environment **não** protege num `workflow_run`: o controle é o `if` do job do workflow.

## 7. Ligar o deploy automático (responsável)

Pré-requisito: o ADR 0096, de migrations compatíveis com a versão anterior do Worker, já está na `main`. Sem ele, uma migration pode quebrar o Worker que ainda está no ar.

O workflow `.github/workflows/deploy-staging.yml` só roda com a variável de repositório `STAGING_DEPLOY_ENABLED` igual a `true`. Enquanto ela não existir, o workflow fica desligado. Para desligar de novo, apague a variável.

## 8. Verificação

- `bun run verify:staging-isolation` (estática) e, depois da build de staging, `node scripts/verify-staging-isolation.mjs --built`.
- `node scripts/verify-staging-isolation.mjs --remote`, com o token de staging e `STAGING_DATABASE_HOST`: cada Hyperdrive aponta para o host de staging, com caching desligado e sem o login do dono.
- `staging:verify-database after-migrate`: marcador, parte só de leitura do `definer-hardening`, `TEMPORARY` de `PUBLIC` e os logins com o grupo de cada um.
- O smoke do workflow.

## 9. Itens do release-checklist no staging

- **Itens 3 e 15 (ensaio):** a saída de `before-migrate` (dono do banco e de `public`), a migration 0077 passando o bloco `DO` e a lista de logins de `after-migrate`. É ensaio: a prova vale de novo no go-live, contra a produção.
- **A cada migrate:** `after-migrate` roda a parte só de leitura do gate `definer-hardening`. Um achado deixa o workflow vermelho antes do deploy.
- **Item 14 (cota do Images, 9422):** pelo caminho real de miniatura. Com o login de teste, enviar pelo app imagens sintéticas distintas (cada envio gera as miniaturas no Worker) até a resposta mudar para `media_transform_quota_exceeded` ou para um 503. Registrar `code`, `message` e `Cf-Resized` dos eventos do Worker, sem segredo. Fazer nos **últimos dias do mês**, porque esgota as 5.000 transformações da conta até a virada. O limite de 20 envios por minuto vale também aqui. Depois, conferir no painel de cobrança que não houve cobrança. Não existe rota de diagnóstico, e nenhuma deve ser criada.
- **Item 16 (exceção não capturada):** por Worker (`polaris-web-staging` e `polaris-catalog-staging`):
  1. numa cópia local **não commitada**, fazer o `fetch` lançar uma exceção não capturada;
  2. `wrangler versions upload --env staging` dessa cópia;
  3. `wrangler versions deploy <versão>@100% --env staging`, uma requisição qualquer e a conferência nos Workers Logs do Worker (sim ou não);
  4. rollback imediato: `wrangler rollback --env staging` para a versão anterior;
  5. descartar a cópia local.

  Nunca uma rota de falha no código. O Admin não é exposto no staging, então o item 16 dele fica para o go-live, atrás do Access da produção.
- **Gate 5 manual:** a build de staging tem `VITE_OFFLINE_RUNTIME_ENABLED=true`. O checklist do [runbook do Gate 5](./gate-5-offline.md) roda contra a URL `workers.dev` com o login de teste, por BrowserStack (uma sessão por vez) ou aparelho físico.

## Rollback ou forward-fix

- Worker: `wrangler rollback --env staging` para a versão anterior. A migration fica, porque é compatível com o Worker anterior (ADR 0096).
- Migration com falha: o workflow para antes do deploy, e o Worker anterior continua no ar. A correção é um commit novo (forward-fix). Nunca editar uma migration já aplicada.
- Dado do staging corrompido: o staging não guarda nada real. O responsável pode recriar o banco a partir da seção 1.
- Desligar tudo: apagar a variável `STAGING_DEPLOY_ENABLED`.

## Escalonamento

O responsável pelo projeto, como nos demais runbooks.
