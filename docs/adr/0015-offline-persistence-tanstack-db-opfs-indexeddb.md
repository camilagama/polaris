---
status: accepted
---

# Adotar TanStack DB com OPFS/SQLite WASM e IndexedDB como caminho de persistência offline

## Contexto

O [ADR 0003](0003-offline-command-protocol.md) separou o protocolo offline (commands idempotentes, cursor de change log) do storage local e deixou TanStack DB com SQLite como "primeiro candidato de POC", com Dexie e IndexedDB como fallback. A prova de persistência (laboratório sintético, [runbook](../runbooks/offline-persistence-gate.md)) foi executada e o Gate Foundation aprovou o caminho: recarga, fechamento e reabertura de aba, duas abas, migração de schema entre IDs de coleção, falha do arquivo OPFS e restauração do BFCache, em Chromium desktop e Pixel 5 emulado, e manualmente no Safari de um iPhone 12 (iOS 26.6.2).

A prova também registrou riscos que a escolha precisa carregar explicitamente: o pacote `@tanstack/db` está travado em `0.12.1` e se declara alpha; o worker OPFS/SQLite WASM tem cerca de 1,6 MiB (1.658,8 KiB) além do restante do bundle; Android Chrome real e Edge desktop real não foram testados; o WebKit do Playwright no Windows falha em `createSyncAccessHandle()` e por isso não entra no gate automatizado.

## Decisão

Decidido na revisão do checkpoint Gate 4 (13/10/2026), formalizando o que o Gate Foundation já aprovou:

- O caminho de persistência offline é TanStack DB para as coleções locais, com SQLite WASM sobre OPFS, e IndexedDB para o outbox de commands, para os receipts e para o journal de recuperação. Dexie sobre IndexedDB continua sendo o fallback, acionado se a prova em aparelho Android real reprovar OPFS.
- O protocolo do [ADR 0003](0003-offline-command-protocol.md) continua independente do storage. O envelope de command do outbox durável (identificador do command, tipo, organização, dispositivo, versão-base, lease e payload) é gravado por um **adaptador próprio** sobre IndexedDB, e não pelo mecanismo de mutations persistidas do TanStack DB. Assim, trocar o provider das coleções não muda o formato do que é enviado ao servidor.
- Falha de OPFS ou de IndexedDB é explícita: o runtime não degrada em silêncio para memória nem para `localStorage`. Incompatibilidade de schema falha fechada; a migração entre versões copia entre IDs de coleção versionados e mantém a versão anterior para rollback, sem reset destrutivo.
- Condições que o plano deve cumprir, nas etapas indicadas:
  - **Antes de iniciar o PR52 (outbox durável):** prova em Android Chrome real (OPFS, IndexedDB, persistência após fechar o processo). A emulação não substitui o aparelho. Edge desktop real entra na mesma rodada se houver ambiente.
  - **PR48/PR52:** chamar `navigator.storage.persist()`, registrar o resultado no modelo de dispositivo e tratar a negativa como estado visível, porque o armazenamento não persistente pode ser removido pelo sistema.
  - **PR49:** namespace de armazenamento por usuário e organização, e limpeza (ou bloqueio) dos dados locais no logout, para que outro usuário no mesmo navegador não leia dados da organização anterior. Logout com commands pendentes não pode descartá-los em silêncio.
  - **Antes de incorporar ao app principal:** medir cold start e consumo de dados móveis no iPhone e carregar o worker OPFS sob demanda, fora do caminho crítico das telas que não usam coleções locais.
- Versões do pacote alpha ficam travadas e só mudam por decisão explícita; cada atualização reexecuta o gate de persistência.

## Consequências

- O PR48 em diante pode assumir TanStack DB nas coleções locais sem redesenhar o domínio, e o outbox do PR52 já nasce desacoplado do provider.
- A dependência alpha é um risco aceito e monitorado: se o pacote quebrar compatibilidade ou o Android real reprovar, o fallback é Dexie para as coleções, mantendo o protocolo e o outbox.
- O custo de bundle do worker OPFS entra no orçamento de desempenho do app; a carga sob demanda deixa de ser opcional.
- O offline do app shell (service worker) continua fora desta decisão e pertence ao PR60 e seguintes.

## Alternativas consideradas

- **Dexie sobre IndexedDB como caminho principal.** Menor risco de maturidade e bundle, mas sem SQL local para consultas de catálogo e vendas recentes; permanece como fallback.
- **SQLite WASM direto, sem TanStack DB.** Remove a dependência alpha, mas obriga a construir a camada reativa e de consulta que o TanStack DB já oferece.
- **Esperar uma versão estável.** Adiaria toda a Fase 5 sem reduzir o risco real, que é o comportamento em aparelhos; o gate por versão cobre a regressão.
