---
status: accepted
---

# Usar Neon PostgreSQL 18 com Hyperdrive e RLS transacional

PostgreSQL 18 no Neon é o baseline relacional inicial; Hyperdrive fornece pooling com SQL query caching desabilitado para dados tenant e Admin. Cada operação tenant define o contexto da organização localmente dentro de uma transação explícita, depois de validar membership e capability no servidor, e RLS adiciona uma segunda camada de isolamento. Features tenant aguardam prova remota Worker → Hyperdrive → Neon cobrindo concorrência, rollback, falha/retry, contexto ausente, reuso de conexão e role runtime sem ownership ou BYPASSRLS.
