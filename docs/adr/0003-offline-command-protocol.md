---
status: accepted
---

# Manter o protocolo offline independente do storage local

Mutations offline usam commands versionados e idempotentes que o servidor valida antes de virarem registros oficiais; pull usa cursor de change log mantido pelo servidor. TanStack DB com persistência SQLite local é o primeiro candidato de POC, com Dexie e IndexedDB como fallback. Separar o contrato de sync do storage evita acoplamento ao browser e mantém o servidor como autoridade em conflitos.
