---
status: partially superseded
superseded_in_part_by: 0007, 0027
---

# Usar Neon PostgreSQL 18 com Hyperdrive e RLS transacional

PostgreSQL 18 no Neon é o baseline relacional inicial; Hyperdrive fornece pooling com SQL query caching desabilitado para dados tenant e Admin. Cada operação tenant define o contexto da organização localmente dentro de uma transação explícita, depois de validar membership e capability no servidor, e RLS adiciona uma segunda camada de isolamento. Features tenant aguardam prova remota Worker → Hyperdrive → Neon cobrindo concorrência, rollback, falha/retry, contexto ausente, reuso de conexão e role runtime sem ownership ou BYPASSRLS.

GUCs transaction-local são contexto definido pelo runtime e podem ser alterados por qualquer sessão que use esse papel; eles não são uma prova de identidade contra SQL arbitrário. Por isso, o papel runtime recebe apenas SELECT em organizations/memberships e não pode criar organizations ou memberships. RLS continua como defesa contra consultas sem o filtro/contexto esperado, não contra SQL injection com acesso direto à sessão.

## Nota de revisão (13/10/2026)

O parágrafo original sobre onboarding afirmava que o use case permanecia interno, com uma conexão privilegiada separada, e que sua exposição a requests ficava adiada. Ele foi substituído por esta nota porque contradizia o [ADR 0007](0007-gate2-onboarding-and-category-rls.md): o onboarding passou a ser exposto por uma função `SECURITY DEFINER` chamada por um binding Hyperdrive dedicado, com a role `polaris_onboarding_runtime`, sem DML direto da role tenant em organizations/memberships.

A premissa de uma única role runtime para autenticação e tenant é substituída pelo [ADR 0027](0027-separacao-de-roles-auth-tenant-e-superficies-poc.md), que separa a role de auth da role de tenant. Os demais pontos deste ADR continuam em vigor.
