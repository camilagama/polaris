# Staging fixo

Status: configuração preenchida no repositório (IDs reais, seção 3); os recursos de staging existem desde 22/10, falta o que a seção 5 em diante lista. Os recursos, os segredos e o primeiro deploy são do responsável (Arrascaeta ou o usuário). Decisões e motivos: [ADR 0097](../adr/0097-staging-fixo-e-producao-em-conta-separada.md).

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
- Projeto Neon `polaris-staging`, com o marcador `polaris.environment=staging` (comentário do banco). Nunca o projeto dos gates (`<id do projeto Neon dos gates>`), que nunca recebe dado real.
- O topo de cada `wrangler.jsonc` é só local: um deploy sem `--env staging` (ou sem `CLOUDFLARE_ENV=staging` na build) falha.

## 1. Banco (responsável)

1. Criar o projeto Neon Free `polaris-staging` em `aws-sa-east-1`, com PostgreSQL 18, só a branch `main` e compute de 0,25 CU com autosuspend de 5 min.
2. Com o dono (`neondb_owner`) e a URL **direta**, sem pooler:
   - `COMMENT ON DATABASE neondb IS 'polaris.environment=staging';`
     (o marcador também faz o executor dos gates recusar este banco: `connectToGateTarget` recusa `production`, `staging` e `restore-drill`, mesmo que alguém aponte um gate para a URL direta daqui.)
     Nota: o Neon não dá superusuário, e o PostgreSQL só aceita `ALTER DATABASE … SET polaris.environment` (variável sem extensão que a registre) de superusuário, então esse comando falha com `permission denied to set parameter` (42501), assim como `GRANT SET ON PARAMETER` e `ALTER ROLE … IN DATABASE … SET`. O comentário do banco só muda para o dono (ou superusuário), e os logins de runtime não são donos. O texto tem de ser exatamente esse, em minúsculas e sem espaço sobrando: `polaris.environment=staging-x`, `Polaris.environment=staging` ou `polaris.environment = staging` não são marcador. Conferir com `SELECT shobj_description(oid, 'pg_database') FROM pg_database WHERE datname = current_database();`.
   - `CREATE ROLE polaris_pr11_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS;` (o papel de tenant vive fora das migrations, como no CI).
3. Aplicar as migrations do zero, sempre com **a mesma variável** no verify e no migrate, para que uma URL errada não passe no verify e migre outro banco. A URL não é escrita na linha de comando (iria para o histórico do shell): `read -rs STAGING_MIGRATOR_DATABASE_URL && export STAGING_MIGRATOR_DATABASE_URL`, e então:

   ```sh
   bun run --filter @polaris/db staging:verify-database before-migrate \
     && DATABASE_URL="$STAGING_MIGRATOR_DATABASE_URL" bun run --filter @polaris/db db:migrate \
     && bun run --filter @polaris/db staging:verify-database after-migrate
   ```

   O verify só aceita o banco cujo comentário é exatamente `polaris.environment=staging` (ou, no banco local ou de CI, onde o login é superusuário, a forma antiga do `ALTER DATABASE … SET`). Uma opção de conexão (`?options=`) é recusada.

   O dono do Neon não é superusuário: é membro de `neon_superuser` ([papéis do Neon](https://neon.com/docs/manage/roles/)), que traz `CREATEDB`, `CREATEROLE`, `BYPASSRLS` e `REPLICATION`. Por isso uma migration não pode usar `ALTER ROLE … NOSUPERUSER` (42501, `permission denied to alter role`); a guarda é um `DO` que falha se `rolsuper` for verdadeiro. O gate `migrations-without-superuser` (suíte `ci`, `packages/db/scripts/verify-migrations-without-superuser-gate.ts`) replaya todas as migrations num banco novo com um dono assim (login, `CREATEROLE`, `CREATEDB`, `REPLICATION`, `BYPASSRLS`, sem `SUPERUSER`, membro de um `neon_superuser` com esses atributos, dono do banco e de `public`) e reprova qualquer comando que só superusuário consegue. O papel direto com os atributos reflete o que o staging mostrou: `NOBYPASSRLS`, `NOCREATEDB` e `NOREPLICATION` passam num `ALTER ROLE`, e o PostgreSQL só deixa tirar um atributo de quem o tem. O gate roda também as checagens somente-leitura do `definer-hardening` e dos atributos dos `polaris_%_owner` (as do `staging:verify-database after-migrate`): o dono, que o PostgreSQL 16+ faz membro `ADMIN OPTION`, sem `INHERIT` nem `SET`, de todo papel que cria, não é login de runtime (a isenção é só do dono: outro papel com `ADMIN OPTION` num grupo `*_runtime` continua sendo checado); com `INHERIT` ou `SET` num grupo `*_runtime` seria, e o gate prova que a checagem o reporta. Os atributos e as filiações dos `*_owner` e dos papéis alcançáveis também são provados aqui, como esse dono (sem `SUPERUSER`): numa transação revertida, `CREATEROLE` e `CREATEDB` em papéis descartáveis e uma filiação a um papel com `CREATEROLE` são reportados. `REPLICATION`, `BYPASSRLS` e `SUPERUSER` esse dono não consegue dar (nem as filiações aos papéis predefinidos, que pedem `ADMIN OPTION` neles): essas sondas rodam só no gate `definer-hardening`, que no CI roda como superusuário.
4. Criar um login por binding, cada um membro de **um** grupo, sem `SUPERUSER`, `CREATEROLE`, `CREATEDB`, `BYPASSRLS` nem `TEMP`, fora de `neon_superuser`, com `statement_timeout` e `CONNECTION LIMIT`. A senha não passa pela linha de comando (ver o bloco "A senha vai em texto" abaixo).

   | Binding | Grupo | Limite de conexões |
   | --- | --- | --- |
   | `HYPERDRIVE` | `polaris_pr11_runtime` | 5 |
   | `AUTH_HYPERDRIVE` | `polaris_auth_runtime` | 5 |
   | `ONBOARDING_HYPERDRIVE` | `polaris_onboarding_runtime` | 5 |
   | `MEDIA_CLEANUP_HYPERDRIVE` | `polaris_media_cleanup_runtime` | 5 |
   | `PRIVACY_HYPERDRIVE` | `polaris_privacy_runtime` | 5 |
   | `BILLING_HYPERDRIVE` | `polaris_billing_runtime` | 5 |
   | `OUTBOX_HYPERDRIVE` | `polaris_outbox_runtime` | 5 |
   | `CATALOG_HYPERDRIVE` (catálogo) | `polaris_catalog_runtime` | 5 |

   O Hyperdrive só aceita `origin_connection_limit` de 5 a 20, então todos os logins e todas as configurações ficam com 5, e o limite do login é sempre igual ao da configuração Hyperdrive. Os 8 logins somam 8 × 5 = 40 conexões, abaixo do limite do Neon com 0,25 CU.

   Os nomes dos logins têm `staging` (por exemplo, `polaris_staging_tenant`). Modelo, numa conexão direta (sem pooler) por script, na ordem:

   1. `CREATE ROLE polaris_staging_tenant LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS CONNECTION LIMIT 5 PASSWORD '<senha em texto>' IN ROLE polaris_pr11_runtime;`
   2. `ALTER ROLE polaris_staging_tenant SET statement_timeout = '10s';`
   3. `REVOKE TEMPORARY ON DATABASE neondb FROM polaris_staging_tenant;` se o login tiver recebido `TEMPORARY`.

   **A senha vai em texto, e o Neon recusa hash.** `ALTER ROLE` ou `CREATE ROLE … PASSWORD 'SCRAM-SHA-256$…'` falha com `Neon only supports being given plaintext passwords`, e o `\password` do psql manda o hash, então também falha (descoberto em 22/10). A senha entra em texto no `CREATE ROLE … PASSWORD`, num script que se conecta direto ao banco, lê a senha de um arquivo local com modo 600 e não a imprime (nem no log nem na saída de erro). Gerar uma senha forte por login, sem reaproveitar. Não criar esses logins pela API ou pelo console do Neon: o Neon põe os papéis criados por lá em `neon_superuser`, o que o `staging:verify-database` e esta seção proíbem. A senha entra depois só na criação da configuração Hyperdrive. Cuidados com essa senha em texto:

   - O script imprime só o SQLSTATE e a mensagem de erro, nunca o comando (o `CREATE ROLE` carrega a senha) nem a URL. Como o `CREATE ROLE … PASSWORD` não aceita parâmetro, o script monta o literal com `format('%L')` (ou `escapeLiteral`) e a senha gerada é só hexadecimal ou base64url, sem aspas nem barra invertida: um erro de sintaxe do PostgreSQL cita o trecho perto do erro, e uma aspa na senha o poria na mensagem.
   - O arquivo das senhas (criado com `umask 077`) é apagado depois de criados os 8 logins **e** as 8 configurações Hyperdrive (`shred -u`, que num sistema de arquivos com cópia na escrita ou journaling não garante o apagamento; basta que o arquivo nunca esteja em diretório versionado nem em backup). Depois disso a senha só existe dentro do Hyperdrive, que não a devolve: recriar uma configuração exige antes uma senha nova (`ALTER ROLE … PASSWORD '<nova>'`, em texto, pelo mesmo script e com um novo arquivo temporário).
   - Se a extensão `pg_stat_statements` existir no banco (`SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements'`), conferir se ficou registrado algum comando com a senha e zerar essas linhas. Rodar com o papel que executou o `CREATE ROLE` (o dono) ou um com `pg_read_all_stats`: sem isso o texto vem como `<insufficient privilege>` e a contagem dá zero com a senha lá (linha assim conta como "não conferida"). A busca é por `CREATE ROLE`/`ALTER ROLE`, não por `PASSWORD`, que casaria qualquer consulta que cite uma coluna `password`: `SELECT queryid, query FROM pg_stat_statements WHERE query ~* '(create|alter)\s+role'`. Zerar cada linha com `SELECT pg_stat_statements_reset(0, 0, <queryid>);` (a forma sem argumentos zera tudo, o que é mais do que o necessário). Sem a extensão, não há o que conferir. **Se o dono do Neon receber `permission denied` ao chamar `pg_stat_statements_reset`** (a função costuma ser só de superusuário, e o dono não é): a decisão para o **staging** é aceitar a linha na visão e registrar isso no resultado do passo (`pg_stat_statements_reset: permission denied para neondb_owner; N linhas com CREATE/ALTER ROLE ficam em pg_stat_statements`, só o número de linhas e o `queryid`, nunca o texto). Não pedir superusuário nem o plugin do Neon para zerar. A **produção** decide no go-live: ali a linha só pode ficar se o texto da consulta não carregar a senha, e isso se confere antes de criar os logins.

   Ao fim, `staging:verify-database after-migrate` lista cada login com o grupo e falha se algum ficar sem grupo. Ele também lê, só leitura, os atributos dos papéis `polaris_%_owner` **e de todo papel que um runtime alcança** (os grupos `*_runtime` e o que eles alcançam por `SET` ou `INHERIT`, como `polaris_closed_export_reader`, que o `polaris_privacy_runtime` pode assumir; é a consulta `roles` de `definer-hardening-checks.ts`, a mesma do `TEMPORARY` e do `CREATE`): cada um tem de ser `NOLOGIN`, `NOSUPERUSER`, `NOCREATEROLE`, `NOCREATEDB`, `NOREPLICATION` e `NOBYPASSRLS`. Um login do app é runtime e precisa logar, então só o `LOGIN` dele não é cobrado (os outros cinco são). Se algum não for, a saída lista o papel e o atributo (`polaris_x_owner: BYPASSRLS`) e o comando falha. Nenhuma migration dá um desses atributos a esses papéis, então não há exceção; se um dia um precisar, parar e explicar no PR. Há um piso de contagem (`MIN_OWNER_ROLES` = 14 e `MIN_REACHABLE_ROLES` = 10, em `owner-role-attributes.ts`): papel `*_owner` renomeado ou sumido, ou grupo ou `polaris_closed_export_reader` que deixou de ser alcançável, reprova em vez de passar com menos papéis. Nenhum `polaris_%_owner` pode ser membro (`INHERIT`, `SET` ou `ADMIN OPTION`, direto ou por cadeia) do dono do banco, de `neon_superuser`, de `pg_read_all_data`, `pg_write_all_data`, `pg_execute_server_program`, `pg_read_server_files`, `pg_write_server_files` nem de papel com `SUPERUSER`, `BYPASSRLS` ou `CREATEROLE`; a saída lista `polaris_x_owner->papel`.

## 2. Recursos Cloudflare (responsável, conta atual)

- Filas: `polaris-critical-staging`, `polaris-default-staging`, `polaris-media-staging` e `polaris-dlq-staging` (`wrangler queues create <nome>`). O sufixo de ambiente vai no fim: o consumidor e o tratamento da DLQ reconhecem a fila por `polaris-<fila>-<ambiente>` ([ADR 0085](../adr/0085-dlq-incidente-operacional-e-retry-no-admin.md)), e um teste confere os nomes do `wrangler.jsonc`.
- R2: bucket privado `polaris-media-staging`. O `polaris-media` antigo da conta não é usado.
- Hyperdrive: as 8 configurações da tabela acima, cada uma com `--caching-disabled` e `--origin-connection-limit 5` (o Hyperdrive aceita de 5 a 20; é o mesmo limite do login, regra que se mantém), apontando para o host direto do projeto `polaris-staging` (sem pooler). A senha do login **não** vai na linha de comando (iria para o histórico do shell e para a lista de processos): nem `--connection-string` nem `--origin-password` do `wrangler hyperdrive create`, que só aceita a senha por essas opções. Ao criar ou recriar uma configuração, usar a API do Cloudflare com o corpo JSON lido de arquivo (`--data-binary @arquivo.json`, com `Content-Type: application/json`). O corpo leva `"caching": {"disabled": true}` e `"origin_connection_limit": 5`, as mesmas regras das opções acima (o `verify:staging-isolation --remote` acusaria o erro só depois). Arquivo do corpo e do cabeçalho com `umask 077`, apagados também quando o comando falha: criar os dois com `mktemp` e registrar `trap 'rm -f "$CORPO" "$CABECALHOS"' EXIT` **antes** de escrever neles (um `rm` ao fim do caminho feliz deixaria a senha e o token em disco se o `curl` falhar, o `set -e` sair ou o comando for interrompido); o token também fica fora do `argv`, num arquivo de cabeçalhos (`curl -H @arquivo`); sem `-v` nem `--trace`, que imprimem o corpo. Recriar pede antes uma senha nova para o login (seção 1.4). Com a do PR11, a conta fica com 9 das 10 do plano Free. Apagar a do PR11 é item do go-live, decidido pelo responsável.
- Os namespaces de rate limit `902016` a `902020` já estão no `wrangler.jsonc`. São reservados no primeiro deploy.

## 3. Preencher a configuração (PR do responsável ou do dev)

Feito em 22/10 (t203): trocados os `PLACEHOLDER-…` de `env.staging` nos três `wrangler.jsonc`: o `account_id` da conta atual (não é segredo), os IDs das 8 configurações Hyperdrive e as URLs `workers.dev` (`BETTER_AUTH_BASE_URL` e `CATALOG_ORIGIN`). O `env.staging.account_id` do Admin também é preenchido, porque a verificação o exige mesmo com o Admin fora do staging. `bun run verify:staging-isolation` tem de passar; com placeholder ele falha e o workflow não implanta. Um recurso novo ou recriado repete este passo.

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

`BETTER_AUTH_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SYNC_PAYLOAD_HASH_SECRET`, `OFFLINE_LEASE_SECRET` e `BILLING_PAYER_KEY` (a chave do pagador do Pix, 32 caracteres ou mais, gerada uma vez e nunca rodada por rotina: ver o [runbook de provedores](./billing-providers.md)), com `wrangler secret put <NOME> --env staging`. Os `*_PREVIOUS_*` ficam vazios até a primeira rotação. Nenhum segredo de staging é reaproveitado na produção. As chaves de sandbox do Asaas e da Woovi só entram no Gate 7. O catálogo não tem segredo.

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
- `staging:verify-database after-migrate`: marcador, parte só de leitura do `definer-hardening`, `TEMPORARY` de `PUBLIC`, os atributos dos papéis `polaris_%_owner` e dos que um runtime alcança (com piso de contagem), a falta de membros privilegiados nos `polaris_%_owner` e os logins com o grupo de cada um.
- O smoke do workflow.

## 9. Itens do release-checklist no staging

- **Itens 3 e 15 (ensaio):** a saída de `before-migrate` (dono do banco e de `public`), a migration 0077 passando o bloco `DO` e a lista de logins de `after-migrate`. É ensaio: a prova vale de novo no go-live, contra a produção.
- **A cada migrate:** `after-migrate` roda a parte só de leitura do gate `definer-hardening` e a conferência dos atributos e das filiações desses papéis. Um achado deixa o workflow vermelho antes do deploy.
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
