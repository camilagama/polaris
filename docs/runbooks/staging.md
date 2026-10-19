# Staging fixo

Status: configuração no repositório, nada criado. Os recursos, os segredos e o primeiro deploy são do responsável (Arrascaeta ou o usuário). Decisões e motivos: [ADR 0097](../adr/0097-staging-fixo-e-producao-em-conta-separada.md).

O staging é um ambiente fixo na conta Cloudflare atual, com dados **só sintéticos**. A exceção são o nome e o e-mail das pessoas de teste que entram pelo Google: são dados pessoais de quem testa, e saem do banco quando a pessoa deixa de testar (seção 4). A produção vai para outra conta Cloudflare e outra organização ou projeto Neon, no go-live (Fase 15).

## Gatilho

- Criar o staging pela primeira vez (seções 1 a 6).
- Ligar o deploy automático (seção 7), depois de criar os recursos e segredos. O ADR 0096 (expand/contract), pré-requisito, já está na `main`.
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
     (o marcador também faz o executor dos gates recusar este banco: `connectToGateTarget` recusa `production`, `staging` e `restore-drill`, mesmo que alguém aponte um gate para a URL direta daqui.)
   - `CREATE ROLE polaris_pr11_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS;` (o papel de tenant vive fora das migrations, como no CI).
3. Aplicar as migrations do zero, sempre com **a mesma variável** no verify e no migrate, para que uma URL errada não passe no verify e migre outro banco. A URL não é escrita na linha de comando (iria para o histórico do shell): `read -rs STAGING_MIGRATOR_DATABASE_URL && export STAGING_MIGRATOR_DATABASE_URL`, e então:

   ```sh
   bun run --filter @polaris/db staging:verify-database before-migrate \
     && DATABASE_URL="$STAGING_MIGRATOR_DATABASE_URL" bun run --filter @polaris/db db:migrate \
     && bun run --filter @polaris/db staging:verify-database after-migrate
   ```

   O verify só aceita o banco cujo `ALTER DATABASE` gravou o marcador. Uma opção de conexão (`?options=`) é recusada.
4. Criar um login por binding, cada um membro de **um** grupo, sem `SUPERUSER`, `CREATEROLE`, `CREATEDB`, `BYPASSRLS` nem `TEMP`, fora de `neon_superuser`, com `statement_timeout` e `CONNECTION LIMIT`. A senha não passa pela linha de comando nem pelo SQL:

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

   Os nomes dos logins têm `staging` (por exemplo, `polaris_staging_tenant`). Modelo, no psql: `CREATE ROLE polaris_staging_tenant LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS CONNECTION LIMIT 5 IN ROLE polaris_pr11_runtime;`, depois `\password polaris_staging_tenant` (o psql pede a senha e manda só o hash; ela não vai para o histórico nem para o log do servidor), `ALTER ROLE polaris_staging_tenant SET statement_timeout = '10s';` e `REVOKE TEMPORARY ON DATABASE neondb FROM …` se o login tiver recebido `TEMPORARY`. A senha entra depois só na criação da configuração Hyperdrive. Ao fim, `staging:verify-database after-migrate` lista cada login com o grupo e falha se algum ficar sem grupo.

## 2. Recursos Cloudflare (responsável, conta atual)

- Filas: `polaris-critical-staging`, `polaris-default-staging`, `polaris-media-staging` e `polaris-dlq-staging` (`wrangler queues create <nome>`). O sufixo de ambiente vai no fim: o consumidor e o tratamento da DLQ reconhecem a fila por `polaris-<fila>-<ambiente>` ([ADR 0085](../adr/0085-dlq-incidente-operacional-e-retry-no-admin.md)), e um teste confere os nomes do `wrangler.jsonc`.
- R2: bucket privado `polaris-media-staging`. O `polaris-media` antigo da conta não é usado.
- Hyperdrive: as 8 configurações da tabela acima, cada uma com `--caching-disabled` e `--origin-connection-limit` igual ao limite do login, apontando para o host direto do projeto `polaris-staging` (sem pooler). Com a do PR11, a conta fica com 9 das 10 do plano Free. Apagar a do PR11 é item do go-live, decidido pelo responsável.
- Os namespaces de rate limit `902016` a `902020` já estão no `wrangler.jsonc`. São reservados no primeiro deploy.

## 3. Preencher a configuração (PR do responsável ou do dev)

Trocar cada `PLACEHOLDER-…` de `env.staging` nos três `wrangler.jsonc`: o `account_id` da conta atual (não é segredo), os IDs das 8 configurações Hyperdrive e as URLs `workers.dev` (`BETTER_AUTH_BASE_URL` e `CATALOG_ORIGIN`). Depois, `bun run verify:staging-isolation` tem de passar. Enquanto houver placeholder, ele falha e o workflow não implanta.

## 4. Cliente OAuth do Google (responsável)

Quem cria é o usuário ou o Arrascaeta, num projeto do Google Cloud só do staging, nunca o da produção.

1. No [console do Google Cloud](https://console.cloud.google.com/), criar o projeto `polaris-staging`.
2. Em **Google Auth Platform → Branding**, preencher o nome `Polaris (staging)` e o e-mail de suporte.
3. Em **Audience**, escolher o tipo **External** e deixar o status de publicação em **Testing**. Não publicar o app.
4. Ainda em **Audience**, em **Test users**, adicionar os e-mails de teste (a allowlist; o limite é de 100). Só esses e-mails conseguem entrar. Qualquer outro recebe o erro de acesso do Google.
5. Em **Data Access**, deixar só os escopos `openid`, `email` e `profile`.
6. Em **Clients → Create client**, escolher **Web application**, só com o URI de redirecionamento autorizado `https://polaris-web-staging.<subdomínio>.workers.dev/api/auth/callback/google`. O fluxo é do servidor e não precisa de origem JavaScript.
7. Gravar o ID e o segredo como segredos do Worker, sem passar pelo repositório: `wrangler secret put GOOGLE_CLIENT_ID --env staging` e `wrangler secret put GOOGLE_CLIENT_SECRET --env staging`, em `apps/web`.
8. Registrar só a data e quem criou.
9. Para tirar alguém, removê-lo de **Test users** não basta: a conta e as sessões continuam válidas no staging. É preciso também, com o dono no banco de staging, apagar as sessões dela (`DELETE FROM "session" WHERE user_id = '<id>';`) e tirá-la das organizações de teste pelos fluxos do app (membership ou encerramento da organização). Um lease offline já emitido vale até expirar (no máximo 72 horas).

**O limite do controle.** A allowlist vive no Google, fora do repositório: nenhum teste prova que o modo Testing continua ligado. Se o app for publicado no Google, qualquer conta Google entra e cria organização no staging. Por isso o status de publicação não muda nunca, e uma allowlist também no código é um acompanhamento proposto (ADR 0097).

O login por senha fica desligado (`EMAIL_PASSWORD_AUTH_ENABLED: "false"`), e a verificação de isolamento falha se ele for ligado. Sem Cloudflare Access. O Admin não é exposto.

## 5. Segredos do Worker `polaris-web-staging` (responsável)

`BETTER_AUTH_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SYNC_PAYLOAD_HASH_SECRET` e `OFFLINE_LEASE_SECRET`, com `wrangler secret put <NOME> --env staging`. Os `*_PREVIOUS_*` ficam vazios até a primeira rotação. Nenhum segredo de staging é reaproveitado na produção. As chaves de sandbox do Asaas e da Woovi só entram no Gate 7. O catálogo não tem segredo.

## 6. GitHub (responsável)

- Environment `staging`, com os segredos `CLOUDFLARE_API_TOKEN` (restrito à conta atual em "Account Resources", com validade curta e permissões mínimas: Workers Scripts Edit, Queues Edit e Hyperdrive Read, este só para a verificação `--remote`; sem R2; a lista final é conferida no primeiro deploy. O token alcança qualquer Worker e fila da conta, e por isso a conta atual não guarda nada de produção) e `STAGING_MIGRATOR_DATABASE_URL` (dono, URL direta).
- Variáveis do Environment, que não são segredo: `CLOUDFLARE_ACCOUNT_ID`, `STAGING_DATABASE_HOST` (o host do projeto `polaris-staging`), `STAGING_WEB_URL` e `STAGING_CATALOG_URL`.
- A restrição de branch do Environment **não** protege num `workflow_run`: o controle é o `if` do job do workflow.

## 7. Ligar o deploy automático (responsável)

Pré-requisito: o ADR 0096, de migrations compatíveis com a versão anterior do Worker, na `main` (já está, desde o #162). Sem ele, uma migration pode quebrar o Worker que ainda está no ar.

O workflow `.github/workflows/deploy-staging.yml` só roda com a variável de repositório `STAGING_DEPLOY_ENABLED` igual a `true`. Enquanto ela não existir, o workflow fica desligado. Para desligar de novo, apague a variável.

## 8. Verificação

- `bun run verify:staging-isolation` (estática) e, depois da build de staging, `node scripts/verify-staging-isolation.mjs --built`.
- `node scripts/verify-staging-isolation.mjs --remote`, com o token de staging e `STAGING_DATABASE_HOST`: cada Hyperdrive aponta para o host direto de staging, com caching desligado e com um login de staging que não é o dono. A leitura fica presa ao `account_id` de `env.staging` e só roda se a verificação estática passar.
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
