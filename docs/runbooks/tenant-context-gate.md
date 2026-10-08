# Gate de contexto tenant no PostgreSQL (PR22)

Este gate verifica as policies reais de organizations/memberships em PostgreSQL 18. Ele altera somente a branch Neon descartável indicada abaixo; nunca execute em production.

## Escopo

- aplica a migration Drizzle do PR22;
- confirma FORCE RLS, policies, papel runtime sem ownership/BYPASSRLS e grants mínimos;
- cria usuários, organizações e memberships sintéticos com o papel runtime;
- verifica onboarding idempotente sob RLS;
- testa contexto ausente, leituras próprias, isolamento cross-tenant, INSERTs proibidos, rollback e reuso do mesmo backend;
- remove as fixtures ao terminar, inclusive quando a validação falha.

O gate conecta diretamente ao Neon e usa SET ROLE para executar como polaris_pr11_runtime. O bootstrap PR11 criou a fixture RLS fora do journal Drizzle; por isso a preparação somente aceita o fixture PR11 esperado: sementes org_a/org_b e, opcionalmente, uma linha UUID com valor retry survives once; policy/grants esperados e journal vazio. Ela remove apenas essa tabela sintética para que db:migrate recrie toda a cadeia; as sementes são repostas pelo gate. O gate PR11 já cobre Worker → Hyperdrive → Neon, pooling, concorrência e reset transaction-local no harness RLS. Este gate valida o novo schema Polaris sob o papel runtime; ele não adiciona nem publica uma rota de produto tenant. A resolução Better Auth é coberta pelos testes locais do compositor.

## Pré-requisitos

- Use somente a conexão direta que o responsável identificou como banco descartável para testes; não use production.
- Banco neondb em PostgreSQL 18, região AWS South America East 1 (São Paulo).
- URL owner direta, sem -pooler, para essa branch.
- Papel polaris_pr11_runtime existente, sem BYPASSRLS e sem ownership das tabelas.
- Dependências do monorepo instaladas pelo lockfile.

Confirme que o hostname digitado corresponde exatamente à URL direta fornecida para o teste descartável. O CLI Neon não está autenticado neste ambiente; não crie nem selecione outro projeto automaticamente.

## Aplicar a migration e executar o gate

Na raiz do repositório, rode o bloco abaixo. O URL é solicitado como SecureString, não é escrito em arquivo nem impresso pelo script. Digite o hostname sem credenciais quando solicitado.

    $secureUrl = Read-Host "Direct owner URL for the user-authorized disposable Neon test database" -AsSecureString
    $urlPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureUrl)
    try {
      $env:DATABASE_URL = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($urlPointer)
      $env:POLARIS_TENANT_CONTEXT_TEST_DATABASE_URL = $env:DATABASE_URL
      $env:POLARIS_TENANT_CONTEXT_TEST_CONFIRM_DISPOSABLE = "polaris-pr22-tenant-context-disposable"
      $env:POLARIS_TENANT_CONTEXT_TEST_EXPECTED_HOSTNAME = Read-Host "Disposable branch endpoint hostname"
      bun run --filter @polaris/db poc:tenant:prepare
      if ($LASTEXITCODE -ne 0) { throw "PR22 fixture reconciliation failed." }
      bun run --filter @polaris/db db:migrate
      if ($LASTEXITCODE -ne 0) { throw "PR22 migration failed." }
      bun run --filter @polaris/db poc:tenant:verify
      if ($LASTEXITCODE -ne 0) { throw "PR22 tenant context gate failed." }
    } finally {
      [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($urlPointer)
      Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue
      Remove-Item Env:POLARIS_TENANT_CONTEXT_TEST_DATABASE_URL -ErrorAction SilentlyContinue
      Remove-Item Env:POLARIS_TENANT_CONTEXT_TEST_CONFIRM_DISPOSABLE -ErrorAction SilentlyContinue
      Remove-Item Env:POLARIS_TENANT_CONTEXT_TEST_EXPECTED_HOSTNAME -ErrorAction SilentlyContinue
      Remove-Variable secureUrl,urlPointer -ErrorAction SilentlyContinue
    }

O comando db:migrate usa URL direta. A migration requer o papel runtime já provisionado. Se o role, host, versão, banco ou confirmação não corresponder, o script falha antes de criar fixtures. O gate verifica se o owner atual pode usar SET ROLE; se não puder, concede temporariamente membership no papel runtime a esse owner e revoga no finally. Se o processo for interrompido antes da limpeza, execute REVOKE polaris_pr11_runtime FROM neondb_owner no mesmo banco descartável antes de reutilizá-lo.

## Resultado exigido

O gate deve imprimir status passed e confirmar: PostgreSQL 18; role NOBYPASSRLS e não owner; RLS habilitado e forçado; grants SELECT/INSERT apenas; contexto ausente sem linhas; membership/capability/organização validados; reads e writes cross-tenant negados; onboarding e retry idempotentes sob RLS; rollback; reset do contexto após reusar o mesmo backend; UPDATE/DELETE negados.

Se a limpeza falhar, preserve o resultado do erro, confirme que a branch continua descartável e remova as fixtures ou descarte a branch antes de reutilizá-la. Não rode o gate contra production.