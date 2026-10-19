# RLS and Hyperdrive gate (PR11)

This is an isolated architecture proof. It uses only the synthetic organizations `org_a` and `org_b` and the table `rls_poc_operations`; it does not create Polaris business entities. The route is absent from the default Worker entrypoint and is included only by `worker/pr11.ts`. The separate Wrangler configuration is for remote development; do not deploy `wrangler.pr11.jsonc`.

## Prerequisites

- A disposable Neon Free plan project named `polaris-pr11-rls-gate` in AWS South America East 1 (São Paulo), with PostgreSQL 18 and the default `neondb` database. The first run must be empty; a retry accepts only the exact verified PR11 fixture from an interrupted bootstrap.
- A direct (non-pooled) owner connection URL for that project. Do not use the existing `polaris_runtime` URL or a production database.
- `cf auth whoami` reports a valid token and exactly one Cloudflare account. The bootstrap uses `cf hyperdrive create`.
- Node.js is available on `PATH`, as required by the installed global `cf` CLI. The bootstrap resolves its Node executable and JavaScript entrypoint, then invokes Node directly so PowerShell does not rewrite the JSON `--body` argument.
- Wrangler authenticated separately to that same account for remote development. The `cf` and Wrangler CLIs keep separate authentication profiles. This repository still uses `wrangler.jsonc`; Cloudflare's current `cf dev` requires migrating Wrangler configuration first, so do not run it here.
- A `workers.dev` account subdomain must be configured before `wrangler dev --remote`. Cloudflare `workers.dev` URLs are public unless protected with Cloudflare Access; the PR11 endpoint uses only the disposable synthetic database, and the remote dev session should be stopped after the gate.
- Dependencies installed from `bun.lock`.

## Bootstrap the disposable project

From the repository root, provide the direct Neon owner URL to a hidden PowerShell prompt and run the bootstrap. Copy the endpoint hostname from the newly created project and enter it at the second prompt; the script requires an exact hostname match, the explicit disposable-project marker, no persistent table/view/sequence/foreign table in `public`, the direct endpoint in São Paulo, and PostgreSQL 18. It then creates a dedicated `NOBYPASSRLS` runtime role, applies the checked-in migration, seeds only synthetic rows, and creates the Hyperdrive resource with SQL response caching disabled and an origin connection limit of five.

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

The bootstrap stores the runtime password in the Cloudflare Hyperdrive resource; it does not write a database URL or password to the repository or print them. The generated password is part of the short-lived Node child process `--body` argument and may be visible in host process listings while the command runs. The password is random, belongs only to this fixture role, and should be used on a host where unrelated users cannot inspect processes. The bootstrap updates `apps/web/wrangler.pr11.jsonc` with the non-secret resource ID.

If Hyperdrive creation fails after the database fixture is prepared, a retry is allowed only when the project contains exactly the expected `rls_poc_operations` table, policy, runtime role, and two synthetic seed rows. The bootstrap validates that full state, rotates the runtime password, and resumes without dropping objects. Any other existing database state is rejected and left unchanged. If a Hyperdrive resource was created but writing its ID to Wrangler config failed, inspect the reported ID with `cf hyperdrive get <hyperdrive-id>` and confirm the exact test resource name and caching settings before deleting it manually and retrying.

## Run the Worker through remote Hyperdrive

In `apps/web`, start Wrangler in remote development mode. `wrangler dev --remote` runs this PR11 Worker in Cloudflare's network and uses the deployed Hyperdrive configuration, including its pooling and caching settings. This is a temporary development session, not `wrangler deploy`. The dedicated config enables only the synthetic RLS test route; all database writes target the disposable Neon fixture. The remote preview may have a public `workers.dev` URL unless an Access policy protects it.

The test route creates a one-connection `pg.Pool` for each Worker request and closes it when that request finishes. Hyperdrive owns the shared pool to the Neon origin; do not cache a `pg.Pool` globally across Worker requests.

```powershell
$cfIdentity = cf auth whoami --quiet | ConvertFrom-Json
if (-not $cfIdentity.tokenValid -or $cfIdentity.accounts.Count -ne 1) { throw "cf authentication must be valid for exactly one account." }
$env:CLOUDFLARE_ACCOUNT_ID = $cfIdentity.accounts[0].id
try {
  bunx wrangler whoami --account $env:CLOUDFLARE_ACCOUNT_ID
  if ($LASTEXITCODE -ne 0) { throw "Authenticate Wrangler to the same Cloudflare account first." }
  bunx wrangler dev --remote --config wrangler.pr11.jsonc
} finally {
  Remove-Item Env:CLOUDFLARE_ACCOUNT_ID -ErrorAction SilentlyContinue
}
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

The runner checks the database version and region, role ownership and `BYPASSRLS`, `FORCE ROW LEVEL SECURITY`, policy expressions, isolated and context-free reads, cross-tenant read/write behavior, rollback after application and SQL failures, transaction-local context reset across two transactions on the same request-scoped backend, 16 concurrent `org_a`/`org_b` requests, and recovery after the owner terminates an active Worker backend. Sixteen requests were measured to reuse a backend across both tenants. An initial 120-request burst against the prior globally shared `pg.Pool` implementation produced connection timeouts; the gate uses a bounded concurrency to prove RLS isolation, not to benchmark saturation. PostgreSQL may report an unset custom GUC as either `NULL` or an empty string after a transaction-local value is restored; both are accepted as absent context, and the runner separately requires zero visible rows. The interruption case uses an idempotency key, expects the first transaction to roll back, and checks that the retry uses a new transaction with the organization context reapplied.

## The same gate in CI

The `ci` suite runs this gate as `rls` (`apps/web/scripts/verify-rls-ci-gate.ts`): the same route and transactions, served by a local server that connects straight to the job's PostgreSQL as the runtime login. It proves the policy, `FORCE ROW LEVEL SECURITY`, cross-tenant reads and writes, rollback, the transaction-local context and the retry after a killed backend. It does not prove Hyperdrive's pooling (backend reuse across tenants), the disabled SQL caching or the region; the report says `not_applicable_local` for those, so the remote run above stays part of the release proof. The gate deletes its own retry row at the end, so the fixture goes back to its two seeds.

## Security boundaries and limits

- The test route returns 404 unless `DB_RLS_POC_ENABLED=true`; the main Worker config sets it to `false`. The PR11 config is only for `wrangler dev`.
- The `organizationId` in this harness selects one of two fixed synthetic fixtures. It is not authorization. Product requests must authenticate the user and verify organization membership and capability on the server before calling `withTenantTransaction`.
- A custom PostgreSQL setting is not an identity credential. SQL that can arbitrarily set `app.organization_id` can choose another context; RLS is defense in depth against omitted or incorrectly scoped queries, not a replacement for server authorization or SQL-injection prevention.
- `withRetryableTenantTransaction` retries only recognized connection failures, once by default. Callers must use an idempotency key or another safe replay contract; do not blindly retry a non-idempotent business command or an ambiguous commit.
- The gate is not complete until the real remote run returns the JSON success report. A local direct connection or a passing typecheck is not a substitute.
