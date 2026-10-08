# Gate de contexto tenant e audit trail no PostgreSQL (PR22/23)

Este gate verifica as policies reais de organizations/memberships e `tenant_audit_event` em PostgreSQL 18. Ele altera somente a branch Neon descartável indicada abaixo; nunca execute em production.

## Escopo

- aplica as migrations Drizzle do PR22/23;
- confirma FORCE RLS, policies de SELECT em organizations/memberships e policy INSERT no audit; runtime NOBYPASSRLS/não-owner; SELECT-only nas tabelas de controle e INSERT-only no audit;
- cria usuários, organizações e memberships sintéticos pela conexão owner do banco descartável;
- verifica a idempotência do onboarding e o evento `organization.created` na mesma transação owner; o runtime não recebe INSERT em organizations/memberships;
- testa contexto ausente, leituras próprias, isolamento cross-tenant, INSERT com GUCs falsificados, audit insert autorizado/cross-tenant, SELECT/UPDATE/DELETE negados, rollback do evento junto com a mutação e reuso do backend;
- valida purge dos eventos com a organização e remove as fixtures ao terminar, inclusive quando a validação falha.

O gate conecta diretamente ao Neon e usa SET ROLE para executar leituras tenant e INSERT de audit como polaris_pr11_runtime. O onboarding sintético, incluindo `organization.created`, e a preparação de usuários/organizações/memberships usam a conexão owner privilegiada, que precisa ser owner das tabelas e ter BYPASSRLS. A migration 0008 remove policies/grants de INSERT temporários; a migration 0009 cria audit com policy de INSERT e grant mínimo. O migrator PostgreSQL instalado do Drizzle aplica migrations pendentes numa transação, então 0007–0009 entram juntas. O runtime não lê eventos; o gate verifica leitura somente pelo owner. GUCs podem ser alterados pelo runtime: as policies ajudam contra contexto incorreto da aplicação, não contra SQL arbitrário. O bootstrap PR11 criou a fixture RLS fora do journal Drizzle; a preparação inicial aceita somente o fixture esperado e journal vazio, removendo apenas essa tabela sintética para que db:migrate recrie a cadeia. Em uma branch já migrada pelo PR22/23, pule a preparação e execute apenas `db:migrate` e `poc:tenant:verify`. O gate PR11 segue cobrindo Worker → Hyperdrive → Neon, pooling e reset transaction-local. Nenhuma rota tenant ou tela de histórico é publicada nesta etapa.

## Pré-requisitos

- Use somente a conexão direta que o responsável identificou como banco descartável para testes; não use production.
- Banco neondb em PostgreSQL 18, região AWS South America East 1 (São Paulo).
- URL owner direta, sem -pooler, para essa branch; o owner precisa ter BYPASSRLS e ser owner das tabelas tenant.
- Papel polaris_pr11_runtime existente, sem BYPASSRLS e sem ownership das tabelas.
- Dependências do monorepo instaladas pelo lockfile.

Confirme que o hostname digitado corresponde exatamente à URL direta fornecida para o teste descartável. O CLI Neon não está autenticado neste ambiente; não crie nem selecione outro projeto automaticamente.

## Aplicar a migration e executar o gate

Responda `yes` à pergunta de preparação somente para uma fixture PR11 intocada, com journal Drizzle vazio. Para a branch Neon já migrada pelo PR22/23, responda outro valor: o bloco pula `poc:tenant:prepare` e roda apenas migrations pendentes e o gate.

Na raiz do repositório, rode o bloco abaixo. O URL é solicitado como SecureString, não é escrito em arquivo nem impresso pelo script. Digite o hostname sem credenciais quando solicitado.

    $secureUrl = Read-Host "Direct owner URL for the user-authorized disposable Neon test database" -AsSecureString
    $urlPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureUrl)
    try {
      $env:DATABASE_URL = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($urlPointer)
      $env:POLARIS_TENANT_CONTEXT_TEST_DATABASE_URL = $env:DATABASE_URL
      $env:POLARIS_TENANT_CONTEXT_TEST_CONFIRM_DISPOSABLE = "polaris-pr22-tenant-context-disposable"
      $env:POLARIS_TENANT_CONTEXT_TEST_EXPECTED_HOSTNAME = Read-Host "Disposable branch endpoint hostname"
      $preparePr11Fixture = Read-Host "Is this an untouched PR11 fixture with an empty Drizzle journal? Type yes to prepare"
      if ($preparePr11Fixture -ceq "yes") {
        bun run --filter @polaris/db poc:tenant:prepare
        if ($LASTEXITCODE -ne 0) { throw "PR22 fixture reconciliation failed." }
      }
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

O gate deve imprimir status passed e confirmar: PostgreSQL major 18 e server_version observado; runtime NOBYPASSRLS/sem ownership; owner privilegiado identificado; RLS ENABLE/FORCE nas três tabelas; SELECT-only em organizations/memberships; INSERT-only em tenant_audit_event, sem SELECT/UPDATE/DELETE; contexto ausente sem linhas; membership/capability/organização validados; cross-tenant reads/writes negados; `organization.created` no mesmo commit do onboarding; audit insert autorizado e rollback do evento junto com a mutação; cascade de eventos ao purgar organização.

Eventos tenant não têm expiração automática. A purge física da organização remove seus eventos por cascade; retenção legal e legal hold precisam de decisão antes do go-live.

Se a limpeza falhar, preserve o resultado do erro, confirme que a branch continua descartável e remova as fixtures ou descarte a branch antes de reutilizá-la. Nunca rode o gate contra production.
