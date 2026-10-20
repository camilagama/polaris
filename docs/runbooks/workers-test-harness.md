# Harness de teste dos Workers (workerd)

Plano: PR 121 (T-121a) e PR 127 (T-127a). Os testes `*.workerd.test.ts` rodam o Worker de verdade dentro do `workerd`, pelo `@cloudflare/vitest-plugin` (Vitest 5), e chamam `exports.default.fetch(...)` de `cloudflare:workers`.

## Como roda

- Dentro de `bun run test` (job `checks`), como o projeto `admin-workerd` do `vitest.config.ts` raiz. Só esse arquivo: `bunx vitest run --project admin-workerd`.
- O plugin usa a sua própria cópia de `wrangler`, `miniflare` e `workerd` (versões exatas do plugin). O `wrangler` dos apps não muda e o deploy também não.
- Não precisa de PostgreSQL, de `.dev.vars`, de `.env` nem de credencial Cloudflare (não crie esses arquivos para o teste). O `wrangler.jsonc` do app é lido como está.

## O que o harness faz por conta própria

- **`resolve.alias` do `pg` na config raiz.** Dentro do `workerd`, `pg-protocol` resolve para um arquivo ESM de um pacote CommonJS e `pg-cloudflare` para um stub vazio (a condição `workerd` não é aplicada). Os dois alias (`pgWorkerdAliases`, em `scripts/workerd-harness.mjs`) só funcionam numa config raiz (`vitest.config.ts` ou `vitest.admin-worker.config.ts`), não dentro de um projeto. Todo Worker novo que use `pg` herda isso.
- **Hyperdrive em porta fechada.** O Admin aponta `ADMIN_HYPERDRIVE` para `127.0.0.1:1` (`miniflare.hyperdrives`), no lugar da `localConnectionString` do app, porque um PostgreSQL local na porta padrão poderia responder. Uma consulta falha fechada e o teste observa essa falha.
- **Guarda de host** (`scripts/workerd-harness.mjs`): `assertAllowedHyperdriveHost` segue a regra dos gates (`packages/db/scripts/gate-hosts.ts`). Fora do CI só passa a porta fechada do loopback; com `CI=true` também passa o loopback em qualquer porta e o serviço do job `database`. Recusa qualquer outro host, o protocolo que não é PostgreSQL e `host`, `hostaddr` ou `service` na query. Todo projeto monta o seu `miniflare.hyperdrives` por `harnessHyperdrives(...)`; os que precisam de PostgreSQL (T-121b, T-127a) devem fazer o mesmo.
- **Sem `.dev.vars` e sem `.env`.** Um teste do Admin falha se o `env` do Worker ganhar qualquer binding fora da lista, e outro falha se o Hyperdrive deixar de ser o de porta fechada.
- **Descoberta.** O projeto `node` exclui `*.workerd.test.ts`, e um projeto que não casa arquivo passa em silêncio; `scripts/workerd-harness.test.mjs` falha se um `*.workerd.test.ts` não tiver um projeto de Workers na config raiz.
- **Cloudflare Access simulado.** A config gera um par RSA na partida (nada é gravado), serve a chave pública como o JWKS do time por `outboundService` e entrega a privada só ao teste, que assina os tokens. Qualquer outra saída de rede responde 502.

## Projetos com PostgreSQL

Projetos que precisam de banco (Web e Catalog na T-121b, o Admin completo na T-127a) têm a sua própria config na raiz, fora do `bun run test`, e rodam no job `database` por um gate. O `*.workerd-db.test.ts` não entra no projeto `node` nem no `admin-workerd`, e `scripts/workerd-harness.test.mjs` falha se um deles não tiver a config e o gate.

### Admin completo contra PostgreSQL (T-127a, gate `admin-worker`)

- **O que roda.** `apps/admin/src/worker.workerd-db.test.ts` chama o `fetch` real do Worker no `workerd`, com o Access simulado, e o Hyperdrive do Admin e do billing apontando para o PostgreSQL do job. A cadeia inteira corre junta: token, principal no banco, capacidade, rota, função do banco e auditoria.
- **Como roda.** `bun run --filter @polaris/db gates:ci admin-worker` (ou a suíte `ci`/`gate9`), com `CI=true` e o PostgreSQL 18 local migrado do zero. O gate `packages/db/scripts/verify-admin-worker-gate.ts` cria os logins temporários (Admin, billing e tenant), dois principais (dono e desativado), quatro organizações e dois clientes, entrega isso à config `vitest.admin-worker.config.ts` por variáveis de ambiente (`POLARIS_ADMIN_WORKER_*`, que o gate lê e nunca imprime), roda o Vitest e depois lê o banco como dono. Sem essas variáveis o projeto para; ele nunca adivinha um banco. Local só passa com `CI=true`: o guarda de host do harness recusa o resto.
- **O que prova.**
  - *Sem Access:* sem token, token que não é JWT, expirado, assinado por chave que o time não publicou, de outra audiência, de outro time, login de quem não é operador, de um operador com o mesmo `sub` sob outro emissor (o principal é achado por emissor e `sub`) e de operador desativado: 401 ou 403, na leitura e na escrita, e o banco não ganha linha (organização B sem caso e sem auditoria; nas quatro organizações do gate só o dono aparece na auditoria, e o desativado não aparece em lugar nenhum). Um cabeçalho que só afirma a identidade não vale.
  - *Dono:* `whoami`, busca e diagnóstico de organização.
  - *Acesso JIT:* abrir caso, 403 antes da concessão, concessão de 15 min, lista mascarada, revelação de um campo, cliente de outra organização que não aparece nem se revela, revogação e 403 de novo; a auditoria tem os cinco eventos e nenhuma concessão fica aberta.
  - *Cobrança e reembolso:* o Admin **não tem comando de reembolso** (ADR 0073: nenhum comando que dependa de provedor existe antes do adaptador). O fluxo de cobrança é a concessão de entitlement, gravada antes e depois (a repetição do mesmo `commandId` também é gravada, mas é a mesma concessão: uma só linha no banco), atribuída ao operador e encerrada; recusada com 400 `case_not_open` em caso fechado. O teste prova que reembolso não tem rota (404). Quando o comando de reembolso existir, ele entra aqui.
  - *Suspensão:* suspender uma vez, o diagnóstico mostra, a organização deixa de abrir para os seus usuários (lido pelo papel de tenant), a época avança uma vez, reativar não a devolve, as outras organizações ficam como estavam e um operador desativado não consegue.
- **Mock do Access confinado.** `apps/admin/src/access-mock-confinement.test.ts` (projeto `node`, roda em todo `bun run test`) falha se qualquer arquivo fora das configs de teste, dos testes e do gate nomear a chave de teste, o time de teste, o assinador ou o `outboundService`; confere por nome os três `wrangler.jsonc` e os workflows; percorre os imports de `worker.ts` para provar que o Worker implantado não alcança teste, `vitest` nem `cloudflare:workers` nem uma variável de desvio da verificação, procura os marcadores no bundle de `apps/admin/dist` quando o `bun run build` já rodou (no CI roda antes dos testes) e exige que `apps/admin` não tenha arquivo local de variáveis. Há caso de controle: o teste prova que pegaria um marcador num `wrangler.jsonc`, num workflow ou no Worker.
- **Production guard.** `scripts/admin-production-guard.test.mjs` lê o `wrangler.jsonc` do Admin e falha se o topo, `env.staging` ou `env.production` não tiverem `workers_dev` e `preview_urls` em `false`, ou se algum tiver rota, domínio personalizado ou zona; confere o nome e as variáveis do Access na produção e que o topo e o staging não as definem (um Worker sem elas responde 503, nunca sem verificação). Os blocos são conferidos contra a lista de chaves que podem ter, não contra uma lista de proibidas: uma chave nova (`assets`, `alias`, `build`, `triggers`, `services`, outro `env`) falha ali e pede revisão do guarda. A metade do Worker (recusa sem JWT válido) é a do teste de cadeia e a do `route-surface.test.ts`: toda rota fora de `/health` está sob `/api` e responde 401 sem token.
- **O que não prova.** O Access real na frente do hostname real, e a recusa de `workers.dev` pela Cloudflare: isso é o item de go-live do Admin ([README, checklist de go-live](./README.md#checklist-de-go-live-cloudflare-e-neon)), a prova no ambiente de produção. Também não prova Hyperdrive real nem o pooler (o binding local é uma conexão direta).
- **Custo.** Medido no primeiro CI (20/10/2026): o gate leva 4 s (partida do `workerd` e 22 testes), e o job `database` ficou em 3 min 03 s contra 3 min 02 s da `main`, o mesmo minuto cobrado. Não há job novo nem mudança de workflow: o gate entra na suíte `ci`.
- **Defeito conhecido do Admin, achado por esta suíte e não corrigido aqui.** O pool de `createBillingStore` (`packages/db/src/billing-store.ts`) não tem ouvinte de `error` no pool nem nos clientes, e o Worker o fecha depois de cada comando de cobrança (`withBillingPorts`). Ao fechar, o driver emite `error` ("This socket has been closed.") que ninguém trata: no `workerd`, uma exceção não capturada depois de a resposta sair. Os comandos estão certos (respostas e banco conferidos). `withAdminDatabase` e os outros leitores já têm o ouvinte. A config `vitest.admin-worker.config.ts` deixa passar só esse erro, só do login de billing, e o gate imprime uma nota (`gate-note`) com a contagem; qualquer outro erro não tratado reprova. Quando o store ganhar o ouvinte, apague a exceção da config e a nota do gate.
- **Se falhar.** O gate imprime só as linhas que dizem o que falhou (a execução completa do Vitest não cabe nas últimas linhas que o executor mostra). Para reproduzir no seu PostgreSQL local de gates: `CI=true`, as variáveis `POLARIS_GATE_*` e `bun run --filter @polaris/db gates:ci admin-worker`.

## O que o harness não prova

Hyperdrive real e pooler (o binding local é uma conexão direta), Images real, cache de borda e a rede real do Cloudflare Access. Isso fica no smoke de staging e no checklist de go-live ([release-checklist](./release-checklist.md)).

## Ruído esperado

A suíte imprime `failed to connect to local database ... Connection refused`: é o Hyperdrive de porta fechada recusando a conexão, que é o que os testes do Admin esperam.

## Atualizar o plugin

`@cloudflare/vitest-plugin` fixa as versões exatas de `wrangler` e `miniflare`. Atualize o plugin como parte do grupo "Cloudflare" do Renovate e rode `bun run test` e `bun run build`; confira no `bun.lock` que o `wrangler` dos apps não mudou sem querer.
