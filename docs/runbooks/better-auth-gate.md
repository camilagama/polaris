# Gate Auth — PR13 Better Auth base

## Escopo

Esta prova instala Better Auth 1.6.23 no Worker Hono do ERP e persiste identidade e sessões no PostgreSQL por Drizzle. O fluxo fica sob `/api/auth/*`.

O Worker retorna 503 quando `BETTER_AUTH_SECRET` não tem pelo menos 32 caracteres ou `BETTER_AUTH_BASE_URL` está ausente. O PR não habilita cadastro com senha, OAuth ou plugin Organization. `testUtils` aparece somente no fixture de teste, nunca na configuração de produção.

As tabelas `user`, `account`, `session` e `verification` ficam no schema `public`. Elas não usam RLS: Better Auth precisa localizar a sessão antes de existir contexto de usuário ou organização. A aplicação só as acessa pelo Worker; o cliente não recebe acesso SQL direto. Autorizações de tenant continuam no domínio Polaris e no Gate RLS.

## Migration e role runtime

`packages/db/drizzle/0002_reflective_tarot.sql` cria as quatro tabelas, índices e FKs. O gate reaplica a cadeia com `bun run db:migrate` depois de `bun run db:generate`.

O grant no migration segue o role de teste `polaris_pr11_runtime`, já criado pela bootstrap da prova RLS. Esse role recebe apenas CRUD nas tabelas de autenticação; não recebe ownership, `CREATE` ou `BYPASSRLS`. Um runtime role de produção precisa receber grants equivalentes no provisionamento do ambiente.

## Verificação automatizada

Na raiz do monorepo:

```powershell
bun run check
bun run build
```

`bun run check` inclui dois testes Vitest: configuração ausente falha fechada e o handler Hono lê e revoga uma sessão criada por fixture Better Auth em memória.

## Integração local Worker + PostgreSQL

Use uma branch Neon descartável criada a partir do projeto de teste. Não habilite Neon Auth e não use o plugin Neon. A URL direta da branch serve para migrations e para o fixture; o Worker local usa o binding Hyperdrive em modo `localConnectionString`.

1. Aplique as migrations na branch de teste com `DATABASE_URL` direto.
2. Crie `apps/web/.dev.vars` local e ignorado pelo Git:

   ```text
   BETTER_AUTH_SECRET=<segredo aleatório com pelo menos 32 caracteres>
   BETTER_AUTH_BASE_URL=http://127.0.0.1:8792
   ```

3. No terminal do Worker, configure `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE` com a URL direta da branch e inicie:

   ```powershell
   bun run dev -- --port 8792 --strictPort
   ```

4. Em outro terminal, configure `DATABASE_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_BASE_URL` e `AUTH_GATE_WORKER_URL=http://127.0.0.1:8792`. Execute:

   ```powershell
   bun run test:auth-gate
   ```

O script recusa qualquer `AUTH_GATE_WORKER_URL` que não seja localhost. Ele cria um usuário sintético, gera uma sessão pelo helper de teste, lê a sessão pelo Worker, revoga-a e confirma uma leitura autoritativa sem sessão. O fixture é removido em `finally`; a saída não inclui email, cookie, token ou URL.

Esse modo executa o Worker local com conexão direta ao banco; ele não mede o pooling/cache remoto do Hyperdrive. O Gate Auth remoto requer validação adicional com binding Hyperdrive próprio e role de teste com grants limitados. Não publique o endpoint de fixture.

## Evidência desta execução (2026-10-07)

- `bun run check` e `bun run build` passaram.
- Os dois testes Vitest passaram.
- A integração local Worker + PostgreSQL 18 na branch Neon `pr13-better-auth-gate` passou: leitura de sessão e revogação.
- A integração remota Worker → Hyperdrive → Neon passou em 2026-10-07: o Worker leu a sessão criada pelo fixture, revogou-a e confirmou leitura autoritativa nula.
- O role temporário tinha somente CRUD nas quatro tabelas Better Auth. O Worker, a config Hyperdrive, o role e o usuário sintético foram removidos; a contagem do fixture ficou em zero.
- A branch Neon pr13-better-auth-gate expira em 2026-10-08 às 09:29 (America/Sao_Paulo); a branch production não foi alterada.
