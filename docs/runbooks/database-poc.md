# Database and Hyperdrive POC (histórico)

> **Histórico.** Esta prova da Fase 1 saiu do repositório: a migration 0108 apagou `db_poc_operations`, o script `poc` de `packages/db` foi removido e a rota `POST /api/poc/database` e o `DB_POC_ENABLED` já não existiam no código ([emenda do ADR 0027](../adr/0027-separacao-de-roles-auth-tenant-e-superficies-poc.md#emenda-30102026-as-superfícies-de-prova-saíram-do-banco-e-da-configuração)). O texto abaixo fica como registro do que foi provado; os comandos não funcionam mais.

This POC uses one disposable table, `db_poc_operations`. It contains no product or tenant data.

## Validate PostgreSQL 18 with Drizzle and pg

Set `DATABASE_URL` to a disposable PostgreSQL 18 connection string in the current shell, then run from `packages/db`:

```powershell
$env:DATABASE_URL = "<connection-string-for-disposable-postgresql-18>"
bun run poc
```

The runner checks the server major version, creates a session-scoped temporary table from the checked-in Drizzle migration SQL, and verifies a query, a committed transaction, a rolled-back transaction, and reuse of the single `pg.Pool` connection. Closing the pool discards the temporary table and all POC rows. This works with a restricted runtime role that has TEMP permission but cannot create persistent schemas/tables.

The migration itself remains reviewable at `packages/db/drizzle/0000_watery_ravenous.sql`. Apply persistent schema changes only through an authorized migration role; do not grant DDL privileges to the runtime role or use schema push as a deployment migration process. Generate future migrations with `bun run db:generate`.

## Worker probe

`POST /api/poc/database` is disabled by default (`DB_POC_ENABLED=false`). To enable it only for a local probe, put `DB_POC_ENABLED=true` in the untracked `apps/web/.dev.vars` file, then run the Worker with a local Hyperdrive connection string. The route runs `SELECT 1` and returns only a generic status.

## Hyperdrive scope

`apps/web/wrangler.jsonc` declares a `HYPERDRIVE` binding with a local-only placeholder ID and a loopback connection string. Override `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE` for a different local Postgres connection. Turborepo passes this variable only to the uncached `dev` task. Replace the placeholder ID with a real Hyperdrive resource before deploying.

Wrangler local development with the default config connects directly to `localConnectionString`; it does not exercise Hyperdrive's remote pooling or query cache. The Worker local probe and PostgreSQL 18.6 POC passed. PR11's separate [RLS/Hyperdrive runbook](./rls-hyperdrive-gate.md) covers the real remote binding and its disposable Neon fixture.

No database URL is committed. This workspace has no local PostgreSQL service, so use a disposable PostgreSQL 18 URL for the POC runner.
