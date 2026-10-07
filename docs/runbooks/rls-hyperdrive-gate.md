# RLS and Hyperdrive gate (PR11)

This is an isolated architecture proof. It uses only the synthetic organizations `org_a` and `org_b` and the table `rls_poc_operations`; it does not create Polaris business entities. The route is absent from the default Worker entrypoint and is included only by `worker/pr11.ts`. The separate Wrangler configuration is for local development; do not deploy `wrangler.pr11.jsonc`.

## Prerequisites

- A new, empty Neon project named `polaris-pr11-rls-gate` in AWS South America East 1 (São Paulo), with PostgreSQL 18 and the default `neondb` database.
- A direct (non-pooled) owner connection URL for that project. Do not use the existing `polaris_runtime` URL or a production database.
- Wrangler authenticated to the intended Cloudflare account with `account:read`, `workers:write`, and `offline_access` for token refresh, stored in Windows Credential Manager.
- Dependencies installed from `bun.lock`.

## Bootstrap the disposable project

From the repository root, provide the direct Neon owner URL to a hidden PowerShell prompt and run the bootstrap. Copy the endpoint hostname from the newly created project and enter it at the second prompt; the script requires an exact hostname match, the explicit disposable-project marker, no persistent table/view/sequence/foreign table in `public`, the direct endpoint in São Paulo, and PostgreSQL 18. It then creates a dedicated `NOBYPASSRLS` runtime role, applies the checked-in migration, seeds only synthetic rows, and creates the Hyperdrive resource with SQL response caching disabled and the origin connection limit set to four.

```powershell
$secureUrl = Read-Host "Direct owner URL for polaris-pr11-rls-gate" -AsSecureString
$urlPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureUrl)
try {
  $env:POLARIS_RLS_ADMIN_DATABASE_URL = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($urlPointer)
  $env:POLARIS_RLS_CONFIRM_DISPOSABLE = "polaris-pr11-rls-gate"
  $env:POLARIS_RLS_EXPECTED_HOSTNAME = Read-Host "Endpoint hostname shown by the new project"
  bun run --filter @polaris/db poc:rls:bootstrap
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($urlPointer)
  Remove-Item Env:POLARIS_RLS_ADMIN_DATABASE_URL -ErrorAction SilentlyContinue
  Remove-Item Env:POLARIS_RLS_CONFIRM_DISPOSABLE -ErrorAction SilentlyContinue
  Remove-Item Env:POLARIS_RLS_EXPECTED_HOSTNAME -ErrorAction SilentlyContinue
  Remove-Variable secureUrl,urlPointer -ErrorAction SilentlyContinue
}
```

The bootstrap stores the runtime password in the Cloudflare Hyperdrive resource; it does not write a database URL or password to the repository or print them. Wrangler receives the generated password as a short-lived process argument during creation, so it may be visible in process listings on the host while the command runs. The password is random, belongs only to this fixture role, and should be used on a host where unrelated users cannot inspect processes. The bootstrap updates `apps/web/wrangler.pr11.jsonc` with the non-secret resource ID. It intentionally accepts only a fresh project; if bootstrap stops after making database changes, preserve the disposable project for diagnosis and use a fresh test project for a clean rerun.

## Run the Worker through remote Hyperdrive

In `apps/web`, create an ignored local vars file and start Wrangler. The `remote: true` binding makes the local Worker use the real Cloudflare Hyperdrive resource; the Worker is not deployed.

```powershell
Set-Content .dev.vars "DB_RLS_POC_ENABLED=true"
bunx wrangler dev --config wrangler.pr11.jsonc
```

Leave Wrangler running. In a second terminal from the repository root, run the gate runner with the same direct owner URL supplied through a hidden PowerShell prompt:

```powershell
$secureUrl = Read-Host "Direct owner URL for polaris-pr11-rls-gate" -AsSecureString
$urlPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureUrl)
try {
  $env:POLARIS_RLS_ADMIN_DATABASE_URL = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($urlPointer)
  $env:POLARIS_RLS_CONFIRM_DISPOSABLE = "polaris-pr11-rls-gate"
  $env:POLARIS_RLS_EXPECTED_HOSTNAME = Read-Host "Endpoint hostname shown by the new project"
  bun run --filter @polaris/db poc:rls:verify
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($urlPointer)
  Remove-Item Env:POLARIS_RLS_ADMIN_DATABASE_URL -ErrorAction SilentlyContinue
  Remove-Item Env:POLARIS_RLS_CONFIRM_DISPOSABLE -ErrorAction SilentlyContinue
  Remove-Item Env:POLARIS_RLS_EXPECTED_HOSTNAME -ErrorAction SilentlyContinue
  Remove-Variable secureUrl,urlPointer -ErrorAction SilentlyContinue
}
```

The runner checks the database version and region, role ownership and `BYPASSRLS`, `FORCE ROW LEVEL SECURITY`, policy expressions, isolated and context-free reads, cross-tenant read/write behavior, rollback after application and SQL failures, transaction-local context on a reused backend, concurrent `org_a`/`org_b` requests, and recovery after the owner terminates an active Worker backend. The interruption case uses an idempotency key, expects the first transaction to roll back, and checks that the retry uses a new transaction with the organization context reapplied.

## Security boundaries and limits

- The test route returns 404 unless `DB_RLS_POC_ENABLED=true`; the main Worker config sets it to `false`. The PR11 config is only for `wrangler dev`.
- The `organizationId` in this harness selects one of two fixed synthetic fixtures. It is not authorization. Product requests must authenticate the user and verify organization membership and capability on the server before calling `withTenantTransaction`.
- A custom PostgreSQL setting is not an identity credential. SQL that can arbitrarily set `app.organization_id` can choose another context; RLS is defense in depth against omitted or incorrectly scoped queries, not a replacement for server authorization or SQL-injection prevention.
- `withRetryableTenantTransaction` retries only recognized connection failures, once by default. Callers must use an idempotency key or another safe replay contract; do not blindly retry a non-idempotent business command or an ambiguous commit.
- The gate is not complete until the real remote run returns the JSON success report. A local direct connection or a passing typecheck is not a substitute.
