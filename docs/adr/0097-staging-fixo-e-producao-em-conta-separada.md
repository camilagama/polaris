---
status: accepted
---

# Staging fixo na conta atual e produção em conta separada

> O número deste ADR (0097) é o próximo livre na `main` e nos PRs abertos no momento da escrita (o 0095 é o dos alertas, na `main`, e o 0096 é o das migrations compatíveis com a versão anterior do Worker, no PR #162); pode mudar se outro entrar antes. As decisões abaixo marcadas como **decisão** foram tomadas pelo responsável (Arrascaeta) na revisão do desenho t067, com as correções de arquitetura (Filipe Luís) e de segurança (Rodrigo Caio).

## Contexto

Os itens 3, 14, 15 e 16 do [release-checklist](../runbooks/release-checklist.md), o Gate 5 manual e a prova Worker → Hyperdrive → Neon com código tenant real (go-live e [ADR 0025](0025-estrategia-de-testes-de-banco.md)) precisam de um ambiente real. Até aqui nenhum `wrangler.jsonc` tinha ambientes, os Hyperdrive eram `local-only` e não havia deploy (PR131 e PR132 do plano). Tudo fica no plano grátis, com o teto de US$ 10 do [ADR 0076](0076-teto-de-custo-e-free-tier-primeiro.md). O usuário decidiu por um staging fixo na conta Cloudflare atual, sem Cloudflare Previews, e pela produção numa segunda conta grátis, criada no go-live.

## Decisão

### Configuração dos Workers

- O **topo** de cada `wrangler.jsonc` serve só para uso local: nome `*-local`, `workers_dev: false`, Hyperdrive `local-only` e filas e bucket com sufixo `-local`. Um deploy que esqueça `--env` (ou `CLOUDFLARE_ENV` na build do Vite) falha, porque os recursos não existem, e nunca publica a produção.
- `env.staging` e `env.production` são explícitos nos três Workers e repetem todos os bindings e `vars`, que não são herdados. Os nomes são `polaris-<app>-staging` e `polaris-<app>`. Os IDs reais ficam como `PLACEHOLDER-…` até o responsável criar os recursos.
- O staging usa recursos próprios: filas `polaris-staging-*`, bucket `polaris-media-staging`, namespaces de rate limit `902016` a `902019` (os da produção são `901016` a `901019`, e os locais `900016` a `900019`) e uma configuração Hyperdrive por papel de banco, com query caching desligado. São 8 configurações: as 7 do web e a do catálogo. O Admin não tem nenhuma no staging (abaixo). Com a do PR11, a conta fica com 9 das 10 do plano Free.
- **Verificação de isolamento** (`scripts/verify-staging-isolation.mjs`, com teste):
  - estática, sobre os `wrangler.jsonc` e, com `--built`, sobre o `wrangler.json` que a build de staging gera, que é o arquivo que o deploy usa;
  - falha se algum valor do staging ainda for placeholder, se um ID, fila, bucket, namespace ou conta do staging for igual ao da produção ou do topo, se dois papéis dividirem uma configuração Hyperdrive, se o nome implantado não terminar em `-staging`, se as Previews estiverem ligadas, se o login por senha estiver ligado ou se o Admin estiver exposto;
  - com `--remote`, lê cada configuração Hyperdrive de staging e confere o host do banco de staging, o caching desligado e que o login não é o dono do banco.
- **Marcador no banco:** o dono executa uma vez `ALTER DATABASE … SET polaris.environment = 'staging'`. O `staging:verify-database` (`packages/db/scripts/verify-staging-database.ts`), só de leitura, recusa qualquer banco sem esse marcador. A produção terá `production`.

### Login no staging (decisão)

- Cliente OAuth do Google próprio do staging, em modo **Testing**: só os e-mails da lista de usuários de teste do Google conseguem entrar. O passo a passo da criação está no [runbook do staging](../runbooks/staging.md#cliente-oauth-do-google-responsável). Quem cria é o usuário ou o Arrascaeta.
- Login por senha **desligado** (`EMAIL_PASSWORD_AUTH_ENABLED: "false"`, conferido pela verificação de isolamento).
- **Sem Cloudflare Access**, para não exigir cartão no Zero Trust.
- O **Admin não é exposto** no staging: sem `workers.dev`, sem rota, sem as variáveis `ACCESS_*` (sem elas, o Worker recusa toda requisição à API) e sem binding de banco. O workflow não o implanta. Ele falha fechado.
- Web e catálogo de staging não aceitam cadastro aberto: sem senha, o único caminho de entrada é o Google em modo Testing, e o catálogo não tem cadastro.

### Banco (decisão)

- O staging tem um projeto Neon Free próprio (`polaris-staging`), com dados só sintéticos. O projeto dos gates (`green-tooth-16857010`, branch `production`) não é usado como staging.
- O projeto dos gates **nunca recebe dado real**. Isso fecha a ressalva da emenda de 18/10/2026 do [ADR 0025](0025-estrategia-de-testes-de-banco.md): a prova de liberação em branch filha de `production` continua válida, porque a `production` dos gates não guarda dado de cliente.
- **Decisão:** no go-live, a produção fica numa organização ou projeto Neon separado, na conta de produção. A chave de API do staging não alcança a produção.

### Deploy contínuo

- `.github/workflows/deploy-staging.yml`, disparado por `workflow_run` depois do CI verde da `main`, com build sem segredos num job separado e os segredos só no passo que os usa. Nunca `pull_request_target`. A restrição de branch do Environment do GitHub não protege no `workflow_run`: o controle é o `if` do job, que exige evento `push`, o próprio repositório, a branch `main` e um commit que ainda seja a ponta de `origin/main`, conferido antes do checkout. O repositório é público.
- O deploy contínuo **depende** do ADR de migrations compatíveis com a versão anterior do Worker (expand/contract, [ADR 0096](0096-migrations-compativeis-com-a-versao-anterior-do-worker.md), tarefa t070): a migration vai ao banco antes do Worker, e o Worker que ainda está no ar tem de continuar funcionando. Até esse ADR estar na `main`, o workflow fica **desligado** por uma variável do repositório (`STAGING_DEPLOY_ENABLED`, que não existe enquanto ninguém a cria). O procedimento está no runbook.

### Itens do release-checklist no staging

- **Itens 3 e 15:** o staging é **ensaio**. A prova vale de novo no go-live, contra o banco de produção.
- A cada migrate, o workflow roda a parte só de leitura do gate `definer-hardening` ([ADR 0093](0093-funcoes-security-definer-e-privilegios-padrao.md)) contra o banco de staging (`staging:verify-database after-migrate`).
- **Item 14:** a cota do binding `IMAGES` é provocada pelo caminho real de miniatura (envio de imagem sintética pelo app, com miniaturas geradas pelo Worker), e não por uma rota de diagnóstico, que não existe.
- **Item 16 (decisão):** uma versão temporária, enviada com `wrangler versions upload --env staging`, lança uma exceção não capturada. Depois, a conferência nos Workers Logs e o rollback. **Nunca** uma rota de falha no código.

## Alternativas descartadas

- **Cloudflare Previews:** por decisão do usuário. Além disso, compartilhariam os bindings da produção.
- **Cloudflare Access no staging:** o Zero Trust Free pode exigir cartão. O Google em modo Testing já restringe quem entra.
- **Login por senha com Resend e Turnstile no staging:** mais segredos e mais superfície para o mesmo fim.
- **Rota de falha (`/__staging/fault`) para o item 16:** código de falha no Worker de produção, ainda que atrás de variável e token. A versão temporária não deixa nada no código.
- **Staging como branch do projeto dos gates:** misturaria fixtures com o staging, e as branches somam na mesma cota.
- **Staging e produção na mesma conta:** dividiriam as 10 configurações de Hyperdrive, os 5 crons e as 100.000 requisições por dia, e a separação ficaria só nos nomes.

## Consequências

- Um deploy por engano do topo falha, e o de staging falha enquanto houver placeholder.
- A conta atual fica com 9 das 10 configurações de Hyperdrive. Um papel novo com configuração própria ocupa a última vaga.
- O Admin só é provado no go-live, atrás do Access da conta de produção. Isso inclui o item 16 para o Admin, que no staging não tem como ser invocado.
- O staging consome as cotas Free da conta atual (100.000 requisições por dia, 10.000 operações de fila por dia, 5.000 transformações do Images por mês). A produção, em outra conta, não disputa essas cotas.
- O primeiro deploy e a criação dos recursos e segredos são do responsável. A lista está no [runbook do staging](../runbooks/staging.md).
