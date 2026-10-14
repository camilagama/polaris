---
status: accepted
---

# Comandos de estoque offline: o saldo na tela é o do servidor mais a fila

## Contexto

O PR56 do plano pede entrada, baixa e contagem de estoque offline, com rejeição clara em conflitos. Estoque é o caso em que o relógio e a ordem importam: dois aparelhos podem mexer no mesmo saldo e uma baixa não pode deixar o saldo negativo. A regra do plano é responder, antes de habilitar a escrita offline, qual é o comando, o conflito possível, a `baseVersion`, a autoridade do servidor e como a pessoa corrige a rejeição.

## Decisão

- **Três comandos, um movimento de razão cada:** `stock.receive`, `stock.write_off` e `stock.count`, todos com a capability `inventory:adjust`. Cada manipulador chama a mesma função de repositório da tela online (`receiveStock`, `writeOffStock`, `inventoryCount`), então valem as regras já provadas: sem estoque negativo, média móvel de custo, data não futura no fuso da organização, um movimento por ID de comando. O `commandId` do `sync.push` é o do movimento. O manipulador reemite a identidade com `inventory:adjust` (helper `withCapability`) só porque o lease já a exigiu e o banco revalidou o papel (ADR 0033, ADR 0035).
- **O servidor é a autoridade.** Uma baixa maior que o saldo do servidor é recusada com `insufficient_stock`; uma contagem feita contra um saldo que mudou é recusada com `inventory_version_conflict`. Nada força o resultado: não existe "sincronizar mesmo assim". A contagem leva, como `baseVersion` do comando, a versão do saldo contra a qual foi contada (a mesma que o fluxo online manda como `expectedVersion`); uma contagem sem `baseVersion` é `invalid_payload`. Outros códigos: `variant_not_found`, `product_deleted`, `inventory_date_in_future`, `inventory_quantity_limit`, `inventory_cost_unavailable`.
- **O cliente não edita o saldo local.** Enfileirar um movimento não escreve na coleção de estoque. O saldo exibido é a linha local (a do servidor) mais os movimentos ainda na fila (pendentes ou em envio), aplicados em ordem (`effectiveStock`): entrada soma, baixa subtrai, contagem substitui, e cada movimento, contagem inclusa, sobe a versão em um. Um movimento recusado ou descartado simplesmente deixa de contar; não há o que desfazer, e uma queda do app não deixa linha otimista errada. O gate prova que essa aritmética de versão é a do razão real. A linha da coleção só muda quando o `sync.push` aceita e o change log traz o saldo do servidor.
- **Validação antecipada, sem substituir o servidor.** O cliente aplica as mesmas regras de formato (quantidade, custo, data, motivo da baixa) e recusa uma baixa maior que o saldo exibido (`InsufficientLocalStockError`); o servidor confere de novo contra o saldo real. Uma baixa recusada fica visível, bloqueia a fila e sai por descarte explícito (`discardPendingStock`); um movimento em `sending` não é descartado (o servidor pode já tê-lo aplicado). Descartar um movimento em que uma contagem posterior se baseou torna essa contagem obsoleta: o servidor a recusa com `inventory_version_conflict` e a pessoa conta de novo.
- **Provas.** O gate `offline-stock` roda os comandos pelo quadro real do `sync.push`: entrada uma vez e repetida igual; fila entrada, baixa e contagem com a versão-base prevista; baixa acima do saldo e contagem com versão antiga recusadas sem rastro; variante inexistente; data futura; duas contagens concorrentes contra a mesma versão (uma vence, outra conflita); duas baixas concorrentes que não cabem juntas (o saldo nunca fica negativo); outra organização não alcança a variante.

## Consequências

- Duas pessoas contando o mesmo produto offline terão um conflito explícito na segunda sincronização, e a segunda conta de novo com o saldo atualizado, em vez de sobrescrever a primeira.
- Entrada e baixa comutam (somam e subtraem), então não precisam de `baseVersion`; só a contagem, que é um valor absoluto, precisa.
- Há uma janela curta entre o servidor aceitar um movimento e a coleção local receber o saldo novo em que a tela contaria o movimento duas vezes; o `syncOutbox` atualiza as coleções logo após aceitar, o que a fecha na prática.
- A interface de resolução de conflitos (PR58) consome os códigos acima.

## Alternativas rejeitadas

- **Aplicar o movimento na linha local ao enfileirar (otimista in-place):** exige desfazer em recusa e descarte, e uma contagem não tem inverso sem guardar o valor anterior.
- **Contagem sem `baseVersion` (último a sincronizar vence):** apagaria silenciosamente o trabalho de outro aparelho.
- **Reduzir a baixa ao saldo disponível:** esconderia a diferença que a pessoa precisa investigar.
