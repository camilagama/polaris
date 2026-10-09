# PR28 inventory ledger gate

Run this gate only on the Neon test branch `pr28-inventory-gate` in the disposable project `polaris-pr11-rls-gate`. The branch is in AWS South America East 1 (São Paulo), PostgreSQL 18, and has automatic deletion enabled after one day. Do not use the Neon CLI or a connected Neon account plugin for this gate.

The gate applies pending migrations and verifies the real PostgreSQL schema, runtime grants, FORCE RLS, signed movement validation, atomic balance/ledger writes, the zero-balance projection, concurrency, tenant isolation, append-only permissions, and the default-variant history guard.

The gate creates synthetic auth users, organizations, products, variants, ledger entries, and audit events on the disposable branch. It does not delete stock movements because the ledger is append-only. Let Neon automatically expire the branch after the gate.

## Apply migrations and run the gate

From the repository root, use the direct owner URL from the Neon connection dialog with connection pooling turned off. The PowerShell prompt hides the URL; the script does not print it or save it to a file.

    $secureUrl = Read-Host "Direct owner URL for the pr28-inventory-gate branch" -AsSecureString
    $urlPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureUrl)
    try {
      $env:DATABASE_URL = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($urlPointer)
      $env:POLARIS_INVENTORY_GATE_DATABASE_URL = $env:DATABASE_URL
      $env:POLARIS_INVENTORY_GATE_CONFIRM_DISPOSABLE = "polaris-pr28-inventory-gate"
      $env:POLARIS_INVENTORY_GATE_EXPECTED_HOSTNAME = Read-Host "Endpoint hostname shown by the branch connection dialog"
      bun run --filter @polaris/db db:migrate
      if ($LASTEXITCODE -ne 0) { throw "PR28 migrations failed." }
      bun run --filter @polaris/db poc:inventory:verify
      if ($LASTEXITCODE -ne 0) { throw "PR28 inventory gate failed." }
    } finally {
      [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($urlPointer)
      Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue
      Remove-Item Env:POLARIS_INVENTORY_GATE_DATABASE_URL -ErrorAction SilentlyContinue
      Remove-Item Env:POLARIS_INVENTORY_GATE_CONFIRM_DISPOSABLE -ErrorAction SilentlyContinue
      Remove-Item Env:POLARIS_INVENTORY_GATE_EXPECTED_HOSTNAME -ErrorAction SilentlyContinue
      Remove-Variable secureUrl,urlPointer -ErrorAction SilentlyContinue
    }

The gate requires the exact disposable marker, database `neondb`, an unpooled endpoint in São Paulo, and PostgreSQL major version 18. It temporarily grants `SET ROLE` to the connection owner only if needed and revokes that membership in `finally`.
