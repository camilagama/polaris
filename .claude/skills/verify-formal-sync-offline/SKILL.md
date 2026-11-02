---
name: verify-formal-sync-offline
description: "Verificação formal (TLA+, TLC) da promessa da sincronização offline: uma venda feita offline entra no servidor exatamente uma vez (nunca duas, e não some do aparelho sem entrar). Use ao mudar o outbox (apps/web/src/offline/outbox/), o sync-runner, a limpeza da fila no Sair ou na sessão recusada (logout-purge, wipeOutboxStore, dropCopyNow, closeStores), o sync.push do servidor (apps/web/src/server/sync/push.ts) ou runSyncCommand e sync_commands (packages/db). Um comando, menos de um minuto."
---

# verify-formal-sync-offline

Teste cobre os casos que alguém escreveu. Este modelo cobre **todas as ordens de passos** de um cenário pequeno: uma venda, até duas abas do mesmo navegador (três num cenário) dividindo a fila do IndexedDB, pedidos que se perdem na ida ou na volta, aba que fecha no meio, o servidor que aceita, recusa e grava ou recusa sem gravar, a pessoa que tenta de novo ou descarta, e o "Sair" (ou a sessão recusada) que apaga a fila vazia.

## A promessa

- **NoDoubleSale**: o servidor nunca aplica a mesma venda duas vezes. Dano: estoque baixado duas vezes, faturamento em dobro.
- **NoLostSale**: a venda não some do aparelho sem ter entrado no servidor, a não ser que a pessoa a descarte. Dano: venda que a pessoa fez e que ninguém vê, nem ela nem o servidor.

## Rodar

```sh
.claude/skills/verify-formal-sync-offline/check.sh
```

Baixa uma vez, com sha256 conferido, o TLC 1.7.4 e, sem Java 11+ no `PATH` nem em `JAVA`, um Temurin JRE 21.0.13+9, para `~/.cache/polaris-tla` (`POLARIS_TLA_CACHE` muda o lugar). Roda cada cenário de `cenarios/` com um worker e compara com o esperado. Sai 0 só quando todos batem; as saídas do TLC ficam na pasta que ele imprime no fim (`POLARIS_TLA_OUT` fixa a pasta). Leva ~20 s com o cache cheio.

| Cenário | O que mostra | Esperado |
| --- | --- | --- |
| `atual` | o desenho de hoje, duas abas, com a limpeza por transação | ok (o achado F1, abaixo, está corrigido) |
| `atual-so-duplicidade` | só NoDoubleSale, três abas, com a limpeza | ok |
| `uma-aba` | o desenho de hoje com uma aba | ok |
| `duas-abas-sem-limpeza` | duas abas sem o Sair nem a sessão recusada | ok |
| `quebrada-sem-idempotencia` | o servidor sem a busca em `sync_commands` e sem o índice único | NoDoubleSale violado (9 estados) |
| `quebrada-recuperacao-apaga` | `recoverInterrupted` apagando o que estava "enviando" | NoLostSale violado (4 estados) |
| `quebrada-limpeza-dividida` | a limpeza contando numa transação e limpando noutra (`WipeAtomic = FALSE`) | NoLostSale violado (5 estados): a venda da outra aba entre as duas some |
| `sanidade-caminho-feliz` | a venda consegue entrar e sair da fila | o invariante de sanidade violado (6 estados); se passar, o modelo ficou vazio |

`Invariante@N` no script é o invariante violado e o número de estados do contraexemplo mínimo (o TLC busca em largura). Com `atual` em ok, qualquer perda nova nesse cenário aparece como diferença.

## Achado F1 (corrigido): a limpeza da fila apagava uma venda da outra aba

**Correção:** `wipeOutboxStore` não apaga mais o banco. `clearOutboxDatabase` (`apps/web/src/offline/outbox/indexeddb-storage.ts`) conta os comandos e limpa todos os object stores numa só transação readwrite; com comando na fila e sem `discardPending`, a transação aborta e sobe `PendingCommandsError`. Sem `deleteDatabase`, nada fica pendente esperando a conexão de outra aba fechar, e uma venda de outra aba cai antes da transação (é contada e a limpeza recusa) ou depois (fica na fila). O banco esvaziado fica no aparelho; `anyOutboxOnDisk` conta comandos em vez de nomes, sem criar banco. No modelo, `WipeStart` (o `closeStores`) e `WipeClear` (a transação) substituem `WipeCount`, `WipeDelete` e `DeleteCompletes`; a variante `quebrada-limpeza-dividida` mostra que separar contar de limpar volta a perder a venda. Provas no navegador: `apps/web/e2e/offline-outbox.e2e.ts` (o par de abas abaixo e a corrida em duas conexões).

O caminho de antes, que o TLC achava no cenário `atual`, e o Chromium reproduz com o código real (`outbox-store.ts` empacotado, duas páginas no mesmo contexto: sem o Sair a aba nova vê 1 comando; com o Sair, 0):

1. Abas A e B da mesma loja e usuário, as duas com o outbox aberto (`openOutboxStore`). Fila vazia.
2. Em A começa a limpeza da fila, por um de dois caminhos:
   - **Sair** (`LogoutWorkspace.purge`): `closeStores` fecha a conexão de A; `purgeNamespace` → `wipeOutboxStore` conta 0 comandos.
   - **Sessão recusada** (`OfflineRuntime.dropCopyNow` com a fila vazia): o mesmo `closeStores` e o mesmo `purge` com `discardPending: false`.
3. `deleteOutboxDatabase` pede `indexedDB.deleteDatabase`. B ainda tem a conexão aberta: o pedido dispara `blocked` e a promessa rejeita ("O outbox está em uso."), mas **o pedido não é cancelado**: o navegador apaga o banco quando a última conexão fechar. Ninguém trata `versionchange`. O que a pessoa vê em A: no Sair, a limpeza falha (`purgeNamespace` propaga o erro, `wipeLocalStore` nem roda) e ela continua logada, porque a sessão só termina com a limpeza pronta (`logout-guard.ts`); na sessão recusada, A mostra `purge_failed`.
4. Em B, a pessoa faz uma venda offline: `Outbox.enqueue` grava na fila (a conexão aberta ainda escreve) e B mostra a venda pendente.
5. A conexão de B fecha. No caminho do Sair, quando B fecha ou recarrega a aba. No da sessão recusada, também sozinha: B recebe a mesma recusa, `dropCopyNow` vê a venda na fila, decide guardar a fila (só `wipeCollections`), mas antes já chamou `closeStores`.
6. O navegador conclui o `deleteDatabase`: a venda some sem ter entrado no servidor, sem aviso em B.

## O que está provado, e sob que limites

- `NoDoubleSale` vale em todas as ordens com até **três abas**, uma venda, um pedido por aba a caminho e pedidos de abas fechadas que ainda chegam ao servidor.
- `NoLostSale` vale com até **duas abas**, com e sem a limpeza da fila (com a limpeza por transação; a limpeza que conta e limpa em transações separadas quebra).
- Cada propriedade foi vista falhando numa variante quebrada (tabela acima).

Fora do modelo, de propósito:

- mais de uma venda e a ordem entre elas (a fila em lote, `not_processed`, o 413 que divide o lote: no modelo, tudo isso é "o envio falha e a venda volta a esperar");
- dois aparelhos (cada um tem a sua fila; o que divide os dois são conflitos de domínio, não a idempotência);
- a retenção de 90 dias de `sync_commands` e `command_too_old` (não há job que apague registros hoje);
- o conteúdo da recusa, a lease (assinatura, época, janela), o plano e as capacidades: no modelo são só "recusa gravada" e "recusa não gravada";
- o banco de coleções locais (SQLite/OPFS) e o pull;
- liveness (a venda chegar um dia): só segurança;
- os descartes de propósito, que tiram a venda da fila sem ela entrar e não contam como perda: "Sair e descartar" (`logout-guard.ts`, `discardPending: true`), `discardClosedQueue` da loja encerrada (`offline-runtime.ts`) e o `customer.update` de um cliente anonimizado, que o `sync-runner` descarta por privacidade (`dropsContent`). No modelo só há `PersonDiscards` de uma venda recusada e a limpeza com `discardPending: false`.

O modelo é mais permissivo que o código em dois pontos, de propósito (o que passa nele passa no código):

- as abas sincronizam ao mesmo tempo; no app, `RuntimeDependencies.exclusive` (`navigator.locks`, `ifAvailable`) deixa uma aba por vez. Não restrinja o modelo a isso: a trava é por navegador e some sem Web Locks;
- `net` é um conjunto, então dois pedidos de abas fechadas (`Gone`) a caminho viram um. Com a busca em `sync_commands`, o segundo só repetiria a resposta gravada; na variante sem idempotência a duplicidade já aparece com abas vivas.

Suposições: `runSyncCommand` é um passo atômico porque segura `pg_advisory_xact_lock` por (loja, commandId) antes de ler `sync_commands`, grava o resultado na mesma transação do savepoint da venda e o índice único `sync_commands_organization_command_unique` está por trás; cada método do `Outbox` é uma transação do IndexedDB; o IndexedDB segue a especificação (transações readwrite sobre os mesmos object stores, de conexões diferentes, não se intercalam; um `abort` não grava nada); nenhum código do app chama `deleteDatabase` num `polaris-outbox-*`.

## Cobertura e sincronia

Confirmado contra o código no commit **`662891ab`** (`origin/main`, sem mudança no código coberto desde `190e3f417cf206a1519fb100f4690bbf31ea3972`) mais a limpeza por transação (`clearOutboxDatabase`, ações `WipeStart` e `WipeClear`). Ação do modelo → código:

| Ação em `SyncOffline.tla` | Código |
| --- | --- |
| `MakeSale` | `apps/web/src/offline/outbox/outbox.ts` `Outbox.enqueue` (chamado por `apps/web/src/offline/sale-confirm.ts`) |
| `Recover` | `apps/web/src/offline/sync-runner.ts` `syncOutbox` → `Outbox.recoverInterrupted` |
| `MarkSending`, `Send` | `sync-runner.ts` `sendBatch` → `Outbox.markSending`, depois o `push` |
| `ServerHandle` | `apps/web/src/server/sync/push.ts` `pushOne` (um `withTenant` por comando) → `packages/db/src/sync-command-repository.ts` `runSyncCommand` |
| `RequestFails`, `AnswerLost` | o `catch` de `sendBatch` → `putBack` |
| `ClientApply` | `sync-runner.ts` `applyResults` / `putBack` → `Outbox.acknowledge`, `Outbox.reject`, `Outbox.retry` |
| `PersonRetries`, `PersonDiscards` | `Outbox.retry`, `Outbox.discard` (tela de atenção) |
| `TabCloses`, `TabOpens` | fechar ou abrir a aba; `OfflineRuntime.closeStores` (`apps/web/src/offline/runtime/offline-runtime.ts`); `apps/web/src/offline/outbox/outbox-store.ts` `openOutboxStore` |
| `WipeStart` | `OfflineRuntime.closeStores` no começo de `LogoutWorkspace.purge` e de `OfflineRuntime.dropCopyNow` |
| `WipeClear` | `apps/web/src/offline/logout-purge.ts` `purgeNamespace` → `outbox-store.ts` `wipeOutboxStore` → `apps/web/src/offline/outbox/indexeddb-storage.ts` `clearOutboxDatabase` (uma transação) |
| `WipeCountApart`, `WipeClearApart` | só a variante quebrada `quebrada-limpeza-dividida`; nenhum código |

Para ver se uma mudança toca o que está verificado:

```sh
git diff --stat 662891ab -- apps/web/src/offline/outbox apps/web/src/offline/sync-runner.ts apps/web/src/offline/logout-purge.ts apps/web/src/offline/runtime/offline-runtime.ts apps/web/src/server/sync/push.ts packages/db/src/sync-command-repository.ts packages/db/src/schema/sync-command.ts
```

Avance o commit acima só depois de conferir, ação por ação, que o modelo ainda descreve o código no commit novo.

## Ao mudar o código coberto

1. Leia a ação do modelo que representa o que mudou (tabela acima) e faça o modelo dizer o que o código diz agora. Um passo atômico do modelo tem de ser atômico no código (uma transação do IndexedDB, uma transação do PostgreSQL); se a mudança partir um passo em dois, parta a ação.
2. Rode `check.sh`.
3. Uma diferença é um bug no código ou um erro de modelo. Leia o contraexemplo com a skill `/statechart` do pstack (ela conta o caminho mínimo em palavras e desenha o gráfico) e refaça o caminho no código real, um passo por ação: num teste com o `Outbox` e o `MemoryOutboxStorage`, ou no navegador quando o IndexedDB importa (F1 foi refeito no Chromium com o Playwright, empacotando `outbox-store.ts` com `bun build --target browser` e abrindo duas páginas no mesmo contexto). Se o caminho não acontece no código, o modelo está errado: corrija o modelo, não o esperado.
4. Nunca enfraqueça `NoDoubleSale` nem `NoLostSale` para passar; um bug achado vira relato com o caminho nos nomes do código.
5. Mudou o comportamento de propósito: atualize o modelo, o esperado no `check.sh`, a tabela de cenários e o commit de sincronia no mesmo PR.

Para trazer o modelo de volta ao código depois de mudanças que não o conferiram, use `/maintain-formal-verification-skill` do pstack.
