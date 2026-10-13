---
status: accepted
---

# Manter o protocolo offline independente do storage local

Mutations offline usam commands versionados e idempotentes que o servidor valida antes de virarem registros oficiais; pull usa cursor de change log mantido pelo servidor. Separar o contrato de sync do storage evita acoplamento ao browser e mantém o servidor como autoridade em conflitos.

O storage local foi escolhido depois da prova de persistência: TanStack DB com SQLite WASM em OPFS para as coleções e IndexedDB para o outbox, com Dexie e IndexedDB como fallback. A escolha, os riscos e as condições estão no [ADR 0015](0015-offline-persistence-tanstack-db-opfs-indexeddb.md). Este ADR continua valendo: o protocolo não depende do storage, e o envelope do outbox é gravado por um adaptador próprio.
