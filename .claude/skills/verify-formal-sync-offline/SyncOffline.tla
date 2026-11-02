---------------------------- MODULE SyncOffline ----------------------------
(***************************************************************************)
(* Uma venda feita offline num navegador com uma ou duas abas da mesma     *)
(* loja e do mesmo usuário, que dividem um outbox no IndexedDB.            *)
(*                                                                         *)
(* Promessa: a venda entra no servidor exatamente uma vez.                 *)
(*   NoDoubleSale: o servidor nunca aplica a venda duas vezes.             *)
(*   NoLostSale:   a venda não some do aparelho sem ter entrado no         *)
(*                 servidor, a não ser que a pessoa a descarte.            *)
(*                                                                         *)
(* Cada ação diz o arquivo e a função do código que ela representa.        *)
(* Caminhos relativos à raiz do repositório.                               *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS
    Tabs,            \* as abas abertas no navegador
    Idempotency,     \* "lookup": como o código; "none": variante quebrada
    RecoverDeletes,  \* FALSE: como o código; TRUE: variante quebrada
    WipeEnabled      \* TRUE: como o código; FALSE: sem "Sair" nem sessão recusada

ASSUME Idempotency \in {"lookup", "none"}
ASSUME RecoverDeletes \in BOOLEAN
ASSUME WipeEnabled \in BOOLEAN

Gone == "gone"   \* pedido de uma aba que fechou: a resposta não chega a ninguém

VARIABLES
    made,       \* a pessoa fez a venda (Outbox.enqueue)
    discarded,  \* a pessoa descartou a venda (Outbox.discard)
    entry,      \* o comando no outbox: "none" | "pending" | "sending" | "rejected"
    conn,       \* conn[t]: a aba t tem o outbox aberto (IndexedDbOutboxStorage)
    run,        \* run[t]: "idle" | "marked" | "sent" (syncOutbox em curso)
    net,        \* pedidos sync.push a caminho do servidor
    resp,       \* resp[t]: "none" | "accepted" | "rejected" | "failed"
    record,     \* sync_commands: "none" | "accepted" | "rejected"
    applied,    \* quantas vezes o servidor aplicou a venda
    wipe,       \* wipe[t]: "idle" | "counted" (wipeOutboxStore entre contar e apagar)
    delPending  \* indexedDB.deleteDatabase pedido e esperando as conexões fecharem

vars == <<made, discarded, entry, conn, run, net, resp, record, applied, wipe, delPending>>

Init ==
    /\ made = FALSE
    /\ discarded = FALSE
    /\ entry = "none"
    /\ conn = [t \in Tabs |-> TRUE]
    /\ run = [t \in Tabs |-> "idle"]
    /\ net = {}
    /\ resp = [t \in Tabs |-> "none"]
    /\ record = "none"
    /\ applied = 0
    /\ wipe = [t \in Tabs |-> "idle"]
    /\ delPending = FALSE

(* apps/web/src/offline/outbox/outbox.ts Outbox.enqueue, chamado pela venda *)
(* (apps/web/src/offline/sale-confirm.ts). Uma transação do IndexedDB. Uma  *)
(* conexão já aberta ainda escreve com um deleteDatabase esperando.         *)
MakeSale(t) ==
    /\ conn[t] /\ ~made /\ wipe[t] = "idle"
    /\ made' = TRUE
    /\ entry' = "pending"
    /\ UNCHANGED <<discarded, conn, run, net, resp, record, applied, wipe, delPending>>

(* apps/web/src/offline/sync-runner.ts syncOutbox -> outbox.recoverInterrupted *)
(* (outbox.ts): todo syncOutbox começa devolvendo "sending" para "pending".    *)
Recover(t) ==
    /\ conn[t] /\ run[t] = "idle" /\ wipe[t] = "idle"
    /\ entry = "sending"
    /\ entry' = IF RecoverDeletes THEN "none" ELSE "pending"
    /\ UNCHANGED <<made, discarded, conn, run, net, resp, record, applied, wipe, delPending>>

(* sync-runner.ts sendBatch -> outbox.markSending (outbox.ts). *)
MarkSending(t) ==
    /\ conn[t] /\ run[t] = "idle" /\ wipe[t] = "idle"
    /\ entry = "pending"
    /\ entry' = "sending"
    /\ run' = [run EXCEPT ![t] = "marked"]
    /\ UNCHANGED <<made, discarded, conn, net, resp, record, applied, wipe, delPending>>

(* sync-runner.ts sendBatch -> push (sync.push sai pela rede). *)
Send(t) ==
    /\ run[t] = "marked"
    /\ t \notin net
    /\ run' = [run EXCEPT ![t] = "sent"]
    /\ net' = net \cup {t}
    /\ UNCHANGED <<made, discarded, entry, conn, resp, record, applied, wipe, delPending>>

(* apps/web/src/server/sync/push.ts pushOne -> withTenant ->                  *)
(* packages/db/src/sync-command-repository.ts runSyncCommand. Um passo só:    *)
(* pg_advisory_xact_lock por (loja, commandId), leitura de sync_commands, a   *)
(* venda num savepoint e o registro do resultado na mesma transação, com o    *)
(* índice único sync_commands_organization_command_unique por trás.           *)
(* "rejected" cobre as recusas gravadas (invalid_creation_time, wrong_device, *)
(* authorization_revoked...); "notStored" as não gravadas (session_changed,   *)
(* entitlement_changed, command_too_old).                                     *)
Outcome(o) ==
    /\ applied' = IF o = "accepted" THEN applied + 1 ELSE applied
    /\ record' = CASE o = "accepted" -> "accepted"
                   [] o = "rejected" -> "rejected"
                   [] OTHER -> record

Reply(r, a) ==
    resp' = IF r = Gone THEN resp ELSE [resp EXCEPT ![r] = a]

ServerHandle(r) ==
    /\ r \in net
    /\ net' = net \ {r}
    /\ IF Idempotency = "lookup" /\ record # "none"
         THEN /\ Reply(r, record)
              /\ UNCHANGED <<record, applied>>
         ELSE \E o \in {"accepted", "rejected", "notStored"} :
                /\ Outcome(o)
                /\ Reply(r, IF o = "notStored" THEN "rejected" ELSE o)
    /\ UNCHANGED <<made, discarded, entry, conn, run, wipe, delPending>>

(* O pedido não chega, o servidor erra e desfaz a transação, ou a resposta se *)
(* perde: para a aba, push lança erro (sync-runner.ts sendBatch, catch).       *)
RequestFails(r) ==
    /\ r \in net
    /\ net' = net \ {r}
    /\ Reply(r, "failed")
    /\ UNCHANGED <<made, discarded, entry, conn, run, record, applied, wipe, delPending>>

AnswerLost(t) ==
    /\ resp[t] \in {"accepted", "rejected"}
    /\ resp' = [resp EXCEPT ![t] = "failed"]
    /\ UNCHANGED <<made, discarded, entry, conn, run, net, record, applied, wipe, delPending>>

(* sync-runner.ts applyResults / putBack: acknowledge, reject ou retry, cada  *)
(* um uma transação do outbox; num estado inesperado o método lança          *)
(* (OutboxCommandStateError / OutboxCommandNotFoundError) e nada muda.       *)
ClientApply(t) ==
    /\ conn[t] /\ run[t] = "sent" /\ resp[t] # "none"
    /\ entry' = CASE resp[t] = "accepted" /\ entry = "sending" -> "none"
                  [] resp[t] = "rejected" /\ entry = "sending" -> "rejected"
                  [] resp[t] = "failed" /\ entry \in {"sending", "rejected"} -> "pending"
                  [] OTHER -> entry
    /\ run' = [run EXCEPT ![t] = "idle"]
    /\ resp' = [resp EXCEPT ![t] = "none"]
    /\ UNCHANGED <<made, discarded, conn, net, record, applied, wipe, delPending>>

(* A pessoa toca "tentar de novo" na tela de atenção: outbox.retry. *)
PersonRetries(t) ==
    /\ conn[t] /\ wipe[t] = "idle" /\ entry = "rejected"
    /\ entry' = "pending"
    /\ UNCHANGED <<made, discarded, conn, run, net, resp, record, applied, wipe, delPending>>

(* A pessoa escolhe descartar a venda recusada: outbox.discard. *)
PersonDiscards(t) ==
    /\ conn[t] /\ wipe[t] = "idle" /\ entry = "rejected"
    /\ entry' = "none"
    /\ discarded' = TRUE
    /\ UNCHANGED <<made, conn, run, net, resp, record, applied, wipe, delPending>>

(* A conexão do outbox desta aba fecha: a aba fecha, recarrega ou morre, ou  *)
(* o runtime chama OfflineRuntime.closeStores (offline-runtime.ts), como na  *)
(* sessão recusada (dropCopyNow) e na troca de loja. Um pedido já na rede    *)
(* ainda chega ao servidor, mas a resposta não volta a ninguém.              *)
TabCloses(t) ==
    /\ conn[t]
    /\ conn' = [conn EXCEPT ![t] = FALSE]
    /\ run' = [run EXCEPT ![t] = "idle"]
    /\ resp' = [resp EXCEPT ![t] = "none"]
    /\ net' = IF t \in net THEN (net \ {t}) \cup {Gone} ELSE net
    /\ wipe' = [wipe EXCEPT ![t] = "idle"]
    /\ UNCHANGED <<made, discarded, entry, record, applied, delPending>>

(* A aba abre: apps/web/src/offline/outbox/outbox-store.ts openOutboxStore. *)
(* indexedDB.open espera atrás de um deleteDatabase pendente.               *)
TabOpens(t) ==
    /\ ~conn[t] /\ ~delPending /\ wipe[t] = "idle"
    /\ conn' = [conn EXCEPT ![t] = TRUE]
    /\ UNCHANGED <<made, discarded, entry, run, net, resp, record, applied, wipe, delPending>>

(* "Sair" (apps/web/src/offline/logout-guard.ts, LogoutWorkspace.purge em     *)
(* apps/web/src/offline/runtime/offline-runtime.ts) ou a sessão recusada      *)
(* (OfflineRuntime.dropCopyNow): closeStores fecha a conexão desta aba e      *)
(* apps/web/src/offline/logout-purge.ts purgeNamespace -> outbox-store.ts      *)
(* wipeOutboxStore conta os comandos numa transação; com algum, recusa        *)
(* (PendingCommandsError, discardPending: false).                             *)
WipeCount(t) ==
    /\ WipeEnabled
    /\ conn[t] /\ run[t] = "idle" /\ wipe[t] = "idle" /\ ~delPending
    /\ conn' = [conn EXCEPT ![t] = FALSE]
    /\ wipe' = [wipe EXCEPT ![t] = IF entry = "none" THEN "counted" ELSE "idle"]
    /\ UNCHANGED <<made, discarded, entry, run, net, resp, record, applied, delPending>>

(* wipeOutboxStore -> indexeddb-storage.ts deleteOutboxDatabase. Com outra   *)
(* conexão aberta o pedido dispara "blocked" e a promessa rejeita, mas o     *)
(* pedido não é cancelado: o banco é apagado quando a última conexão fechar. *)
WipeDelete(t) ==
    /\ wipe[t] = "counted"
    /\ wipe' = [wipe EXCEPT ![t] = "idle"]
    /\ delPending' = TRUE
    /\ UNCHANGED <<made, discarded, entry, conn, run, net, resp, record, applied>>

(* O navegador conclui o deleteDatabase quando nenhuma conexão está aberta. *)
DeleteCompletes ==
    /\ delPending /\ \A t \in Tabs : ~conn[t]
    /\ delPending' = FALSE
    /\ entry' = "none"
    /\ UNCHANGED <<made, discarded, conn, run, net, resp, record, applied, wipe>>

Next ==
    \/ \E t \in Tabs :
          \/ MakeSale(t) \/ Recover(t) \/ MarkSending(t) \/ Send(t)
          \/ AnswerLost(t) \/ ClientApply(t) \/ PersonRetries(t)
          \/ PersonDiscards(t) \/ TabCloses(t) \/ TabOpens(t)
          \/ WipeCount(t) \/ WipeDelete(t)
    \/ \E r \in Tabs \cup {Gone} : ServerHandle(r)
    \/ \E r \in Tabs \cup {Gone} : RequestFails(r)
    \/ DeleteCompletes

Spec == Init /\ [][Next]_vars

TypeOK ==
    /\ entry \in {"none", "pending", "sending", "rejected"}
    /\ record \in {"none", "accepted", "rejected"}
    /\ applied \in 0..2
    /\ net \subseteq Tabs \cup {Gone}

Bound == applied <= 2

NoDoubleSale == applied <= 1

NoLostSale == (made /\ ~discarded /\ entry = "none") => applied >= 1

(* Sanidade: violada quando o modelo alcança o caminho feliz (a venda entra *)
(* no servidor e sai da fila). Se passar, o modelo ficou vazio.            *)
HappyPathUnreachable == ~(made /\ entry = "none" /\ applied = 1)

=============================================================================
