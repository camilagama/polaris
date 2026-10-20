# Harness de teste dos Workers (workerd)

Plano: PR 121 (T-121a). Os testes `*.workerd.test.ts` rodam o Worker de verdade dentro do `workerd`, pelo `@cloudflare/vitest-plugin` (Vitest 5), e chamam `exports.default.fetch(...)` de `cloudflare:workers`.

## Como roda

- Dentro de `bun run test` (job `checks`), como o projeto `admin-workerd` do `vitest.config.ts` raiz. Só esse arquivo: `bunx vitest run --project admin-workerd`.
- O plugin usa a sua própria cópia de `wrangler`, `miniflare` e `workerd` (versões exatas do plugin). O `wrangler` dos apps não muda e o deploy também não.
- Não precisa de PostgreSQL, de `.dev.vars`, de `.env` nem de credencial Cloudflare (não crie esses arquivos para o teste). O `wrangler.jsonc` do app é lido como está.

## O que o harness faz por conta própria

- **`resolve.alias` do `pg` na config raiz.** Dentro do `workerd`, `pg-protocol` resolve para um arquivo ESM de um pacote CommonJS e `pg-cloudflare` para um stub vazio (a condição `workerd` não é aplicada). Os dois alias só funcionam na config raiz, não dentro de um projeto. Todo Worker novo que use `pg` herda isso.
- **Hyperdrive em porta fechada.** O Admin aponta `ADMIN_HYPERDRIVE` para `127.0.0.1:1` (`miniflare.hyperdrives`), no lugar da `localConnectionString` do app, porque um PostgreSQL local na porta padrão poderia responder. Uma consulta falha fechada e o teste observa essa falha.
- **Guarda de host** (`scripts/workerd-harness.mjs`): `assertAllowedHyperdriveHost` segue a regra dos gates (`packages/db/scripts/gate-hosts.ts`). Fora do CI só passa a porta fechada do loopback; com `CI=true` também passa o loopback em qualquer porta e o serviço do job `database`. Recusa qualquer outro host, o protocolo que não é PostgreSQL e `host`, `hostaddr` ou `service` na query. Todo projeto monta o seu `miniflare.hyperdrives` por `harnessHyperdrives(...)`; os que precisam de PostgreSQL (T-121b, T-127a) devem fazer o mesmo.
- **Sem `.dev.vars` e sem `.env`.** Um teste do Admin falha se o `env` do Worker ganhar qualquer binding fora da lista, e outro falha se o Hyperdrive deixar de ser o de porta fechada.
- **Descoberta.** O projeto `node` exclui `*.workerd.test.ts`, e um projeto que não casa arquivo passa em silêncio; `scripts/workerd-harness.test.mjs` falha se um `*.workerd.test.ts` não tiver um projeto de Workers na config raiz.
- **Cloudflare Access simulado.** A config gera um par RSA na partida (nada é gravado), serve a chave pública como o JWKS do time por `outboundService` e entrega a privada só ao teste, que assina os tokens. Qualquer outra saída de rede responde 502.

## Projetos com PostgreSQL

Projetos que precisam de banco (Web e Catalog na T-121b, o Admin completo na T-127a) terão a sua própria config, fora do `bun run test`, e rodam no job `database` com `--project`.

## O que o harness não prova

Hyperdrive real e pooler (o binding local é uma conexão direta), Images real, cache de borda e a rede real do Cloudflare Access. Isso fica no smoke de staging e no checklist de go-live ([release-checklist](./release-checklist.md)).

## Ruído esperado

A suíte imprime `failed to connect to local database ... Connection refused`: é o Hyperdrive de porta fechada recusando a conexão, que é o que os testes do Admin esperam.

## Atualizar o plugin

`@cloudflare/vitest-plugin` fixa as versões exatas de `wrangler` e `miniflare`. Atualize o plugin como parte do grupo "Cloudflare" do Renovate e rode `bun run test` e `bun run build`; confira no `bun.lock` que o `wrangler` dos apps não mudou sem querer.
