---
status: accepted
---

# Outbox durável de comandos em IndexedDB e a prova em Android antes de ligar a escrita offline

## Contexto

O PR52 do plano cria o outbox local: cada comando offline guarda `commandId`, tipo, organização, dispositivo, versão-base, lease e payload, e sobrevive a reinício. O [ADR 0015](0015-offline-persistence-tanstack-db-opfs-indexeddb.md) já decidiu que o outbox usa um **adaptador próprio sobre IndexedDB**, separado das coleções, e condicionou o início do PR52 a uma prova em Android Chrome real. O responsável adiou os testes físicos e pediu para seguir.

## Decisão

- **A condição do ADR 0015 muda de lugar, não de força.** O outbox é construído e provado agora em Chromium (desktop e Pixel 5 emulado), mas **nenhuma escrita offline pode ser ligada em produção sem a prova em Android Chrome real** (OPFS, IndexedDB, persistência após matar o processo) e sem o resultado de `navigator.storage.persist()` visível. Enquanto isso, o outbox não é montado no aplicativo: nenhuma tela o usa. Se a prova reprovar, o fallback do ADR 0015 (Dexie) troca só o adaptador de armazenamento; o protocolo e as regras permanecem.
- **Regras acima de um armazenamento mínimo.** `Outbox` fala com `OutboxStorage` (uma transação atômica por operação) e roda igual sobre IndexedDB e sobre uma implementação em memória usada nos testes. Cada operação é uma transação.
- **Ordem e idempotência.** Os comandos recebem uma posição local monotônica, gravada na mesma transação do comando e nunca reutilizada. O mesmo comando de novo (mesmo ID e conteúdo, independente da ordem das chaves) devolve o armazenado; o mesmo ID com conteúdo diferente é conflito. O ID do comando é a chave de idempotência do servidor.
- **Fila que não pula nem reordena.** Só o primeiro comando da fila é oferecido, e só enquanto espera. Um comando enviado cuja resposta se perdeu fica `sending`; ao reiniciar, `recoverInterrupted()` o devolve a `pending` e ele é reenviado com o mesmo ID (o servidor repete a resposta). Um comando que o servidor recusa fica `rejected` com um código, **bloqueia os que estão atrás** e só sai por uma ação explícita: tentar de novo ou descartar.
- **Nada some em silêncio.** Remover um comando é confirmação do servidor ou descarte explícito. Apagar o outbox (logout, sair da organização) **recusa** com `PendingCommandsError` se houver comandos pendentes, a menos que a pessoa aceite descartá-los explicitamente.
  - **Emenda (limpeza por transação):** "apagar o outbox" é esvaziá-lo, não apagar o banco. A contagem e a limpeza de todos os object stores são uma só transação readwrite (`clearOutboxDatabase`): com comando na fila e sem o aceite do descarte, a transação aborta sem gravar nada e sobe `PendingCommandsError`. O banco nunca é apagado com `indexedDB.deleteDatabase`: com outra aba do mesmo navegador aberta, o pedido de apagar fica pendente (bloqueado, não cancelado) e, quando essa aba fecha, leva junto o que ela enfileirou depois, sem aviso (achado F1 do modelo `SyncOffline.tla`, skill `verify-formal-sync-offline`). O banco vazio fica no aparelho, só com o nome derivado do hash do namespace; "há fila neste navegador" (`anyOutboxOnDisk`) é haver algum outbox com pelo menos um comando, contado sem criar banco. Sair com outra aba aberta conclui normalmente; o que essa aba enfileirar depois fica na fila e sai no próximo login do mesmo usuário na mesma loja.
- **O lease limita comandos novos, não os da fila.** Enfileirar exige um lease com o mesmo usuário, organização e dispositivo e ainda dentro da validade (leitura sem verificação, no cliente; o servidor verifica a assinatura e revalida tudo no sync). Depois do vencimento, comandos novos são bloqueados e os já enfileirados são preservados.
- **Limites.** Payload JSON de até 256 KiB, no máximo 10.000 comandos, tipo `dominio.acao`, versão-base inteira não negativa.
- **Armazenamento persistente visível.** `requestPersistentStorage()` devolve `granted`, `denied` ou `unsupported`; a interface deve tratar `denied` como risco, não como detalhe.
- **Isolamento.** Um banco IndexedDB por usuário e organização, com o nome derivado do mesmo hash do namespace das coleções ([ADR 0031](0031-colecoes-locais-e-bootstrap.md)).

## Consequências

- O `sync.push` (PR53) e os comandos offline (PR54 a PR57) já têm onde enfileirar, reenviar com segurança e mostrar recusas.
- O estado `rejected` bloqueante é a base da interface de conflitos (PR58); o aceite explícito do descarte é a base do logout com pendências (PR59).
- Esta etapa não prova IndexedDB em Android físico; o checklist de go-live passa a exigir essa prova antes de ligar a escrita offline.

## Alternativas rejeitadas

- **Outbox sobre as mutations persistidas do TanStack DB:** acopla o formato do que é enviado ao servidor ao provider das coleções, contra o ADR 0015.
- **Descartar comandos recusados automaticamente:** perderia trabalho (uma venda) sem que a pessoa soubesse.
- **Pular o comando recusado e seguir a fila:** reordenaria comandos que podem depender uns dos outros.
