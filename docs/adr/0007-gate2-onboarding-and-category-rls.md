---
status: accepted
---

# Fechar o Gate 2 com onboarding isolado e RLS de Categories

## Contexto

A fundação já tem Better Auth, organizations/memberships sob RLS, onboarding idempotente, capabilities centralizadas e o compositor de contexto tenant. O onboarding ainda era apenas um use case privilegiado, e não havia entidade de negócio com RLS nem operação tenant conectada ao Worker. A role principal do Worker não deve ganhar DML em organizations/memberships nem permissão para invocar um writer privilegiado.

## Decisão

- O endpoint RPC de onboarding autentica primeiro com Better Auth, usa somente o ID da sessão e exige email verificado.
- O endpoint chama o writer por um binding Hyperdrive separado, ONBOARDING_HYPERDRIVE. A role polaris_onboarding_runtime não tem login por padrão e recebe apenas EXECUTE na função create_initial_organization; a role polaris_pr11_runtime não recebe EXECUTE nem DML em organizations/memberships.
- A função SECURITY DEFINER usa search_path fixo em pg_catalog/pg_temp, referências totalmente qualificadas, nenhuma SQL dinâmica e EXECUTE revogado de PUBLIC. Ela revalida email verificado, aplica lock/idempotência e cria organização, membership e organization.created numa única chamada transacional. A função não autentica sessão; somente o Worker pode derivar o user ID da sessão e encaminhá-lo.
- Categories é a primeira entidade de negócio real. O slice de Gate 2 adiciona SELECT/INSERT com ENABLE/FORCE RLS, membership/organização ativas e capabilities catalog:read/category:create; category.created é gravado na mesma transação. A role tenant comum não recebe UPDATE ou DELETE nesta etapa.
- O slice não inclui UI, archive/delete, ligação com produto, estoque nem sincronização offline. O PR24 completo reutiliza a tabela e as operações mínimas, completando domínio, lifecycle e UI.

## Consequências

O deployment que habilitar onboarding precisa provisionar credencial e Hyperdrive próprios para a role polaris_onboarding_runtime. Nenhum recurso de produção é provisionado neste ADR. Gates devem confirmar que a role tenant não executa a função, a role de onboarding não tem DML direto, o fluxo HTTP usa a sessão server-side e RLS isola Categories em PostgreSQL 18.