# Database and Hyperdrive POC

This POC uses one disposable table, `db_poc_operations`. It contains no product or tenant data.

## Run against a disposable PostgreSQL 18 database

Set `DATABASE_URL` to a disposable PostgreSQL 18 connection string in the current shell, then run from `packages/db`:

```powershell
$env:DATABASE_URL = "<connection-string-for-disposable-postgresql-18>"
bun run poc
```

The runner applies the checked-in Drizzle migration, verifies a query, a committed transaction, a rolled-back transaction, and reuse of the single `pg.Pool` connection. It removes its test rows when it finishes. It rejects server versions other than PostgreSQL 18.

Generate a new reviewed migration after changing the schema with `bun run db:generate`. Do not use schema push as a deployment migration process.

## Worker probe

`POST /api/poc/database` is disabled by default (`DB_POC_ENABLED=false`). To enable it only for a local probe, put `DB_POC_ENABLED=true` in the untracked `apps/web/.dev.vars` file. The route runs `SELECT 1` through the HYPERDRIVE binding and returns only a generic status.

## Hyperdrive scope

`apps/web/wrangler.jsonc` declares a `HYPERDRIVE` binding with a local-only placeholder ID and a loopback connection string. Override `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE` for a different local Postgres connection. Replace the placeholder ID with a real Hyperdrive resource before deploying.

Wrangler local development connects directly to `localConnectionString`; it does not exercise Hyperdrive's remote pooling or query cache. The local runner validates `pg` and Drizzle against PostgreSQL 18. The Worker → Hyperdrive → Neon pooling/cache proof remains in PR11.

No database URL is committed. This workspace currently has no local PostgreSQL service or `DATABASE_URL`, so the runtime runner still needs a disposable PostgreSQL 18 connection before its database checks can be reported as passed.