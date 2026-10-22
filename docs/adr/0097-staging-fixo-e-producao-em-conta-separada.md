---
status: accepted
---

# Staging fixo na conta atual e produção em conta separada

> O número deste ADR (0097) é o próximo livre na `main` e nos PRs abertos no momento da escrita (o 0095 é o dos alertas, na `main`, e o 0096 é o das migrations compatíveis com a versão anterior do Worker, também na `main`); pode mudar se outro entrar antes. As decisões abaixo marcadas como **decisão** foram tomadas pelo responsável (Arrascaeta) na revisão do desenho t067, com as correções de arquitetura (Filipe Luís) e de segurança (Rodrigo Caio).

## Contexto

Os itens 3, 14, 15 e 16 do [release-checklist](../runbooks/release-checklist.md), o Gate 5 manual e a prova Worker → Hyperdrive → Neon com código tenant real (go-live e [ADR 0025](0025-estrategia-de-testes-de-banco.md)) precisam de um ambiente real. Até aqui nenhum `wrangler.jsonc` tinha ambientes, os Hyperdrive eram `local-only` e não havia deploy (PR131 e PR132 do plano). Tudo fica no plano grátis, com o teto de US$ 10 do [ADR 0076](0076-teto-de-custo-e-free-tier-primeiro.md). O usuário decidiu por um staging fixo na conta Cloudflare atual, sem Cloudflare Previews, e pela produção numa segunda conta grátis, criada no go-live.

## Decisão

### Configuração dos Workers

- O **topo** de cada `wrangler.jsonc` serve só para uso local: nome `*-local`, `workers_dev: false`, Hyperdrive `local-only` e filas e bucket com sufixo `-local`. Um deploy que esqueça `--env` (ou `CLOUDFLARE_ENV` na build do Vite) falha, porque os recursos não existem, e nunca publica a produção.
- `env.staging` e `env.production` são explícitos nos três Workers e repetem todos os bindings e `vars`, que não são herdados. Os nomes são `polaris-<app>-staging` e `polaris-<app>`. Os IDs reais de `env.staging` entraram depois de criados os recursos (22/10/2026); os de `env.production` ficam como `PLACEHOLDER-…` até o go-live.
- O staging usa recursos próprios: filas `polaris-<fila>-staging` (o sufixo de ambiente vai no fim, que é o que o consumidor e a DLQ reconhecem, [ADR 0085](0085-dlq-incidente-operacional-e-retry-no-admin.md)), bucket `polaris-media-staging`, namespaces de rate limit `902016` a `902020` (os da produção são `901016` a `901020`, e os locais `900016` a `900020`) e uma configuração Hyperdrive por papel de banco, com query caching desligado. São 8 configurações: as 7 do web e a do catálogo. O Admin não tem nenhuma no staging (abaixo). Com a do PR11, a conta fica com 9 das 10 do plano Free.
- **Verificação de isolamento** (`scripts/verify-staging-isolation.mjs`, com teste):
  - estática, sobre os `wrangler.jsonc` e, com `--built`, sobre o `wrangler.json` que a build de staging gera, que é o arquivo que o deploy usa;
  - falha se algum valor do staging ainda for placeholder, se um ID, fila, bucket, namespace ou conta do staging for igual ao da produção ou do topo, se dois papéis dividirem uma configuração Hyperdrive, se faltar no staging um binding, consumidor de fila ou variável que a produção precisa, se aparecer um tipo de binding que o staging não usa ou uma rota, se o nome implantado não terminar em `-staging`, se as Previews estiverem ligadas, se o login por senha estiver ligado com `AUTH_EMAIL_FROM` fora de `@araute.app` (emenda de 22/10/2026) ou se o Admin estiver exposto;
  - com `--remote`, lê cada configuração Hyperdrive de staging e confere o host do banco de staging, o caching desligado e que o login não é o dono do banco.
- **Marcador no banco:** o dono executa uma vez `COMMENT ON DATABASE <banco> IS 'polaris.environment=staging'` (o Neon não dá superusuário, e o `ALTER DATABASE … SET polaris.environment` de uma variável sem extensão que a registre só o superusuário faz: falha com 42501; o comentário muda só para o dono, que os logins de runtime não são). O `staging:verify-database` (`packages/db/scripts/verify-staging-database.ts`), só de leitura, recusa qualquer banco sem esse marcador, lido do comentário do banco (`shobj_description`) e não de uma opção da conexão; o texto tem de ser exatamente `polaris.environment=staging`. A forma antiga (`pg_db_role_setting`) continua valendo para o banco local e o de CI, onde o login é superusuário. O código que escreve e lê o marcador fica num só lugar, `packages/db/scripts/environment-marker.ts`. A produção terá `production`.

### Login no staging (decisão)

- Cliente OAuth do Google próprio do staging, em modo **Testing**: só os e-mails da lista de usuários de teste do Google conseguem entrar. O passo a passo da criação está no [runbook do staging](../runbooks/staging.md#cliente-oauth-do-google-responsável). Quem cria é o usuário ou o Arrascaeta.
- Login por senha **desligado** (`EMAIL_PASSWORD_AUTH_ENABLED: "false"`, conferido pela verificação de isolamento). *Mudou na emenda de 22/10/2026 abaixo: ligado no staging, com o remetente em `@araute.app`.*
- **Sem Cloudflare Access**, para não exigir cartão no Zero Trust.
- O **Admin não é exposto** no staging: sem `workers.dev`, sem rota, sem as variáveis `ACCESS_*` (sem elas, o Worker recusa toda requisição à API) e sem binding de banco. O workflow não o implanta. Ele falha fechado.
- Web e catálogo de staging não aceitam cadastro aberto (*o web deixou de valer assim na emenda de 22/10/2026 sobre a senha*): sem senha, o único caminho de entrada é o Google em modo Testing, e o catálogo não tem cadastro. **Limite:** essa allowlist vive no console do Google, fora do repositório, e nenhum teste prova que o modo Testing continua ligado. Uma allowlist também no código, que falhe fechada no staging, fica como acompanhamento proposto (mudança de auth, com revisão de segurança).
- Os nomes e e-mails das pessoas de teste são dados pessoais de quem testa. Quando alguém deixa de testar, sai da lista do Google e tem conta e sessões apagadas do banco de staging (runbook).

### Banco (decisão)

- O staging tem um projeto Neon Free próprio (`polaris-staging`), com dados só sintéticos. O projeto dos gates (`<id do projeto Neon dos gates>`, branch `production`) não é usado como staging.
- O projeto dos gates **nunca recebe dado real**. Isso fecha a ressalva da emenda de 18/10/2026 do [ADR 0025](0025-estrategia-de-testes-de-banco.md): a prova de liberação em branch filha de `production` continua válida, porque a `production` dos gates não guarda dado de cliente.
- **Decisão:** no go-live, a produção fica numa organização ou projeto Neon separado, na conta de produção. A chave de API do staging não alcança a produção.

### Deploy contínuo

- `.github/workflows/deploy-staging.yml`, disparado por `workflow_run` depois do CI verde da `main`, com build sem segredos num job separado e os segredos só no passo que os usa. Nunca `pull_request_target`. A restrição de branch do Environment do GitHub não protege no `workflow_run`: o controle é o `if` do job, que exige evento `push`, o próprio repositório, a branch `main` e um commit que ainda seja a ponta de `origin/main`, conferido antes do checkout. O repositório é público.
- O deploy contínuo **depende** do ADR de migrations compatíveis com a versão anterior do Worker (expand/contract, [ADR 0096](0096-migrations-compativeis-com-a-versao-anterior-do-worker.md), tarefa t070): a migration vai ao banco antes do Worker, e o Worker que ainda está no ar tem de continuar funcionando. O ADR 0096 já está na `main` (#162). Mesmo assim, o workflow fica **desligado** por uma variável do repositório (`STAGING_DEPLOY_ENABLED`, que não existe enquanto ninguém a cria) até os recursos e segredos existirem e o responsável ligá-lo. O procedimento está no runbook.

### Itens do release-checklist no staging

- **Itens 3 e 15:** o staging é **ensaio**. A prova vale de novo no go-live, contra o banco de produção.
- A cada migrate, o workflow roda a parte só de leitura do gate `definer-hardening` ([ADR 0093](0093-funcoes-security-definer-e-privilegios-padrao.md)) contra o banco de staging (`staging:verify-database after-migrate`), junto com a conferência dos atributos dos papéis `polaris_%_owner` e de todo papel que um runtime alcança (`NOLOGIN`, `NOSUPERUSER`, `NOCREATEROLE`, `NOCREATEDB`, `NOREPLICATION`, `NOBYPASSRLS`; do login do app não se cobra o `LOGIN`), com piso de contagem, e de que nenhum `polaris_%_owner` é membro de papel privilegiado.
- **Item 14:** a cota do binding `IMAGES` é provocada pelo caminho real de miniatura (envio de imagem sintética pelo app, com miniaturas geradas pelo Worker), e não por uma rota de diagnóstico, que não existe.
- **Item 16 (decisão):** uma versão temporária, enviada com `wrangler versions upload --env staging`, lança uma exceção não capturada. Depois, a conferência nos Workers Logs e o rollback. **Nunca** uma rota de falha no código.

## Emenda (22/10/2026): o web do staging em `dash.araute.app`

Registro datado; a decisão original acima permanece como está. Decidido pelo usuário em 22/10/2026.

- O web do staging passa a ser servido em `https://dash.araute.app`, por um **Custom Domain** da Cloudflare criado fora do `wrangler.jsonc` (zona `araute.app`, na mesma conta). O `env.staging` do web não tem `routes`: o token de deploy do CI não precisa de permissão de zona, e `wrangler deploy` sem `routes` deixa o Custom Domain como está. A [documentação do Wrangler](https://developers.cloudflare.com/workers/wrangler/configuration/) manda tirar `route` e `routes` e pôr `workers_dev = false` para gerir as rotas só pelo painel. Foi esse o modelo usado.
- `BETTER_AUTH_BASE_URL` do staging é exatamente `https://dash.araute.app`, e `workers_dev` do web fica `false`: a verificação de origem (`origin-check`) e os `trustedOrigins` do login aceitam uma origem só, e o `workers.dev` deixaria de funcionar para escrita. O cookie `__Secure-`, o URI do Google e os links dos e-mails seguem dessa variável.
- O **catálogo continua no `workers.dev`** (`CATALOG_ORIGIN` não muda).
- `verify:staging-isolation` troca "só `workers.dev`" por uma lista exata: o web aceita só `https://dash.araute.app` (outro subdomínio, `http`, porta, caminho ou userinfo reprovam), o catálogo segue como estava, `routes` continua proibido no config, e `BETTER_AUTH_BASE_URL` e `CATALOG_ORIGIN` da produção não podem ter o host do staging (a comparação ignora maiúsculas, porta e ponto final). O smoke aceita esse host só para o web, além dos `workers.dev` de staging que já aceitava.
- O cookie de sessão é `__Secure-` e do host (sem `Domain`), não `__Host-`. Enquanto a produção não estiver em `araute.app`, o único risco (um subdomínio irmão plantar cookie) exige controle da zona. Se a produção for para o mesmo domínio registrável, reavaliar o `__Host-`.
- Atenção: a zona tem um registro curinga `*.araute.app` com proxy, que responde 525. O registro específico do Custom Domain prevalece sobre ele. Um subdomínio sem Custom Domain continua dando 525.

## Emenda (22/10/2026): login por senha ligado no staging

Registro datado; a decisão de "Login no staging" acima fica como estava, no que esta emenda não muda. Decidido pelo usuário em 22/10/2026.

- O login por e-mail e senha fica **ligado só no staging**, aberto a qualquer pessoa, para os testes (inclusive no BrowserStack) não dependerem do SMS do Google. O usuário aceitou o risco de qualquer pessoa criar conta, porque os dados do staging são fictícios. A produção não muda (`EMAIL_PASSWORD_AUTH_ENABLED: "false"`).
- O `env.staging` do web leva `EMAIL_PASSWORD_AUTH_ENABLED: "true"` e `AUTH_EMAIL_FROM: "Polaris (staging) <nao-responda@araute.app>"`; o segredo `RESEND_API_KEY` (chave do Resend só de envio, presa ao domínio `araute.app`, já verificado) é do Worker de staging ([runbook](../runbooks/staging.md#5-segredos-do-worker-polaris-web-staging-responsável)). Os links dos e-mails de confirmação e de troca de senha saem de `BETTER_AUTH_BASE_URL`, isto é, de `https://dash.araute.app`.
- `verify:staging-isolation` troca "a senha fica desligada no staging" por "no staging, a senha só pode ser ligada com `AUTH_EMAIL_FROM` em `@araute.app`" (nome e endereço, ou o endereço sozinho; subdomínio, sufixo parecido e remetente de outro domínio reprovam). Com a senha desligada, o staging passa como antes. A produção ganha `AUTH_EMAIL_FROM: ""` só para a verificação de paridade (toda var do staging existe na produção); vazio, a senha segue desligada.
- "Sem cadastro aberto" deixa de valer para o web do staging: a allowlist do Google em modo Testing só restringe a entrada pelo Google. Os dados continuam sintéticos, e os nomes e e-mails de quem se cadastra são dados pessoais de quem testa, apagados como os demais (runbook).
- **Pendência:** com a senha ligada, todo POST de senha (cadastro, entrada, "esqueci a senha", reenvio) responde 503 `auth_abuse_protection_unavailable` enquanto `AUTH_ABUSE_PROTECTION_ENABLED` estiver `false`, por desenho ([auth-abuse-protection](../runbooks/auth-abuse-protection.md)). A flag fica `false` aqui porque ligá-la exige um widget do Turnstile para `dash.araute.app` e os dois valores `TURNSTILE_SECRET_KEY` (segredo) e `TURNSTILE_SITE_KEY` (var pública). O login por senha só funciona de ponta a ponta no staging depois disso.
- **Riscos aceitos.** O usuário aceitou em 22/10/2026 que qualquer pessoa crie conta no staging e, com isso, o risco herdado do [ADR 0100](0100-tela-de-entrada-senha-atras-de-flag-bloqueio-e-aceite-legal.md) (cadastro com o e-mail de outra pessoa e o Google dela travado pela conta não verificada), porque os dados são fictícios e quem testa sabe. O Resend passa a enviar confirmação, redefinição e desbloqueio a terceiros pelo domínio `araute.app`, com limite só por IP: pode haver reclamação, rejeição e esgotamento da cota diária do Resend. A chave presa ao domínio é a defesa em profundidade.
- **Antes de ligar a senha no deploy:** a migration 0094 no banco de staging e o alerta em `auth_verification_link_record_failed` ([email-auth](../runbooks/email-auth.md#ordem-de-implantação-da-gravação-do-link-e-alerta-antes-da-flag-da-senha)). **Antes de ligar o Turnstile:** a prova manual da 0098 (RLS forçada em `user`, `account` e `verification`) no staging.
- A alternativa "Login por senha com Resend e Turnstile no staging", abaixo, fica superada por esta decisão.

## Alternativas descartadas

- **Cloudflare Previews:** por decisão do usuário. Além disso, compartilhariam os bindings da produção.
- **Cloudflare Access no staging:** o Zero Trust Free pode exigir cartão. O Google em modo Testing já restringe quem entra.
- **Login por senha com Resend e Turnstile no staging:** mais segredos e mais superfície para o mesmo fim. (Superada pela emenda de 22/10/2026: o usuário decidiu ligar a senha no staging.)
- **Rota de falha (`/__staging/fault`) para o item 16:** código de falha no Worker de produção, ainda que atrás de variável e token. A versão temporária não deixa nada no código.
- **Staging como branch do projeto dos gates:** misturaria fixtures com o staging, e as branches somam na mesma cota.
- **Staging e produção na mesma conta:** dividiriam as 10 configurações de Hyperdrive, os 5 crons e as 100.000 requisições por dia, e a separação ficaria só nos nomes.

## Consequências

- Um deploy por engano do topo falha, e o de staging falha enquanto houver placeholder.
- A conta atual fica com 9 das 10 configurações de Hyperdrive. Um papel novo com configuração própria ocupa a última vaga.
- O Admin só é provado no go-live, atrás do Access da conta de produção. Isso inclui o item 16 para o Admin, que no staging não tem como ser invocado.
- O staging consome as cotas Free da conta atual (100.000 requisições por dia, 10.000 operações de fila por dia, 5.000 transformações do Images por mês). A produção, em outra conta, não disputa essas cotas.
- O primeiro deploy e a criação dos recursos e segredos são do responsável. A lista está no [runbook do staging](../runbooks/staging.md).
