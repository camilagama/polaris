---
status: accepted
---

# Usar Neon PostgreSQL 18 com Hyperdrive e RLS transacional

PostgreSQL 18 no Neon é o baseline relacional inicial; Hyperdrive fornece pooling com SQL query caching desabilitado para dados tenant e Admin. Cada operação tenant define o contexto da organização localmente dentro de uma transação explícita, depois de validar membership e capability no servidor, e RLS adiciona uma segunda camada de isolamento. Features tenant aguardam prova remota Worker → Hyperdrive → Neon cobrindo concorrência, rollback, falha/retry, contexto ausente, reuso de conexão e role runtime sem ownership ou BYPASSRLS.

GUCs transaction-local são contexto definido pelo runtime e podem ser alterados por qualquer sessão que use esse papel; eles não são uma prova de identidade contra SQL arbitrário. Por isso, o papel runtime recebe apenas SELECT em organizations/memberships e não pode criar organizations ou memberships. O use case de onboarding permanece interno e exige uma conexão privilegiada separadamente controlada; sua exposição a requests fica adiada até existir uma fronteira de escrita segura. RLS continua como defesa contra consultas sem o filtro/contexto esperado, não contra SQL injection com acesso direto à sessão.
