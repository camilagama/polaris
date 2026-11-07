# Gate 2 — onboarding e RLS de Categories

## Escopo e segurança

Este gate roda somente na branch Neon autoexpirável gate2-runtime-proof do projeto polaris-pr11-rls-gate. A branch de origem production e qualquer banco de produto não devem ser alterados.

A migration 0012 cria Categories com ENABLE/FORCE RLS e grants SELECT/INSERT apenas à role tenant polaris_pr11_runtime. A migration 0013 do PR24 adiciona timestamps de lifecycle, índice único de nome normalizado e UPDATE tenant-scoped; DELETE físico continua sem grant. A migration 0012 também cria a role polaris_onboarding_runtime como NOLOGIN e concede somente EXECUTE à função SECURITY DEFINER create_initial_organization. A role tenant comum não executa essa função. O Worker autentica a sessão Better Auth e usa uma binding Hyperdrive separada, ONBOARDING_HYPERDRIVE, para o writer. A função verifica novamente o email verificado e grava organização, membership e organization.created na mesma chamada transacional.

O script do Worker cria duas roles de login temporárias, cada uma membro de apenas uma role base. Elas têm senha aleatória, validade de uma hora e são removidas em finally; a saída não mostra senhas nem URLs. O script inicia o Worker em uma porta local livre, passa as duas conexões às bindings Hyperdrive locais e encerra o processo após a prova. A URL owner não é passada ao Worker. O gate remoto PR11 já cobre o pooling real de Hyperdrive.

## Pré-requisitos

- Branch Neon gate2-runtime-proof, PostgreSQL 18, região AWS South America East 1 (São Paulo), expiração automática em 1 dia.
- URL owner direta para neondb, sem pooler.
- Role polaris_pr11_runtime existente, sem BYPASSRLS e sem ownership das tabelas.
- Role polaris_pr11_runtime NOLOGIN (grupo) e um login próprio dela: LOGIN, NOSUPERUSER, NOBYPASSRLS, membro com INHERIT e SET, com o nome em `POLARIS_GATE_RUNTIME_LOGIN` (só o nome, nunca senha nem URL). O executor (`bun scripts/run-gates.ts gate2-runtime`) cria o `polaris_gate_runner_*` e passa o nome; o `poc:gate2:verify` direto exige a variável apontando para um login assim. O gate só confere esse login no catálogo; a sessão do gate continua sendo a do dono, que assume o grupo com `SET ROLE`.
- Dependências instaladas com bun install --frozen-lockfile.

Use Read-Host -AsSecureString para digitar a URL e mantenha-a somente em variável de ambiente durante os testes. Não grave URL ou senha em arquivo, repositório, log ou comando visível. Não use o plugin Neon.

## Migrations e gate PostgreSQL

Na raiz do monorepo:

    $secureUrl = Read-Host "Direct owner URL for the auto-expiring gate2-runtime-proof Neon branch" -AsSecureString
    $urlPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureUrl)
    try {
      $env:POLARIS_GATE2_TEST_DATABASE_URL = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($urlPointer)
      $parsedUrl = [Uri]$env:POLARIS_GATE2_TEST_DATABASE_URL
      $env:POLARIS_GATE2_TEST_EXPECTED_HOSTNAME = $parsedUrl.Host
      $env:POLARIS_GATE2_TEST_CONFIRM_DISPOSABLE = "gate2-runtime-proof"
      $env:DATABASE_URL = $env:POLARIS_GATE2_TEST_DATABASE_URL
      bun run --filter @polaris/db db:migrate
      if ($LASTEXITCODE -ne 0) { throw "Gate 2 migration failed." }
      bun run --filter @polaris/db poc:gate2:verify
      if ($LASTEXITCODE -ne 0) { throw "Gate 2 database verification failed." }
    } finally {
      [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($urlPointer)
      Remove-Item Env:POLARIS_GATE2_TEST_DATABASE_URL -ErrorAction SilentlyContinue
      Remove-Item Env:POLARIS_GATE2_TEST_EXPECTED_HOSTNAME -ErrorAction SilentlyContinue
      Remove-Item Env:POLARIS_GATE2_TEST_CONFIRM_DISPOSABLE -ErrorAction SilentlyContinue
      Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue
      Remove-Variable secureUrl,urlPointer,parsedUrl -ErrorAction SilentlyContinue
    }

O gate confirma: PostgreSQL major 18; roles e privilégios; SECURITY DEFINER com search_path fixo e EXECUTE não público; função inacessível à role tenant; onboarding idempotente e auditado; Categories em FORCE RLS; unicidade de nomes sem distinção de caixa/espaços externos; grants UPDATE sem DELETE; isolamento e negação de escrita cruzada; archive/restore/tombstone auditados na mesma transação; rename único e auditado; rollback conjunto; cascade ao purgar a organização. As fixtures são removidas mesmo em falha.

## Gate Worker + Hyperdrive local

Depois que migration e gate PostgreSQL passarem, execute o teste Worker local. Ele cria uma sessão Better Auth de teste, inicia o Worker e usa roles temporárias para separar acesso tenant e onboarding:

    $secureUrl = Read-Host "Direct owner URL for gate2-runtime-proof" -AsSecureString
    $urlPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureUrl)
    try {
      $env:POLARIS_GATE2_TEST_DATABASE_URL = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($urlPointer)
      $env:POLARIS_GATE2_TEST_CONFIRM_DISPOSABLE = "gate2-runtime-proof"
      bun run --filter @polaris/web test:gate2-worker
      if ($LASTEXITCODE -ne 0) { throw "Gate 2 Worker verification failed." }
    } finally {
      [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($urlPointer)
      Remove-Item Env:POLARIS_GATE2_TEST_DATABASE_URL -ErrorAction SilentlyContinue
      Remove-Item Env:POLARIS_GATE2_TEST_CONFIRM_DISPOSABLE -ErrorAction SilentlyContinue
      Remove-Variable secureUrl,urlPointer -ErrorAction SilentlyContinue
    }

O teste configura `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE` e `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_ONBOARDING_HYPERDRIVE` somente no ambiente do processo Worker. Ele testa onboarding verificado/idempotente, `category.list/create/rename/archive/restore/delete`, filtros de lifecycle para leitura offline, nomes duplicados, negação cross-tenant e auditoria. URLs e senhas não são emitidas. Se o processo for interrompido, as senhas das roles temporárias deixam de funcionar após uma hora; a branch expira em um dia.

## Aprovação do Gate 2

O Gate 2 foi aprovado tecnicamente após os dois gates PostgreSQL e Worker local passarem. O PR24 completa o lifecycle e a UI de Categories; não adiciona sync offline. Credenciais reais Google, Resend e Turnstile, bindings persistentes de produção e UI de autenticação permanecem pré-go-live, não são configurados por este gate.
