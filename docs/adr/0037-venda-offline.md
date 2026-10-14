---
status: accepted
---

# Venda offline: um comando, estoque do servidor e cinco estados

## Contexto

O PR57 do plano é a venda offline, o motivo de toda a Fase 5. Uma venda é a operação mais cara de errar: mexe em estoque, dinheiro e custo, e acontece no balcão, com o cliente na frente, quer a rede exista ou não. O comando de venda online (`confirmSale`) já foi desenhado para isso: idempotente por `commandId`, com o instante comercial da venda separado do instante de gravação, `recordedAt` como evidência do relógio do dispositivo e a janela retroativa contada no calendário da organização. As regras de resposta antes de habilitar offline (plano, seção 18) ficam assim: comando `sale.confirm`; idempotente por `commandId`; conflito possível: estoque insuficiente, produto indisponível, data fora da janela; `baseVersion`: nenhuma (a venda não depende da versão de uma entidade, o estoque é decidido no servidor); autoridade: o servidor; correção: reenviar como novo comando depois de corrigir a causa, ou descartar.

## Decisão

- **Um comando, `sale.confirm`**, capability `sale:create`. O payload (esquema `offlineSalePayloadSchema` em `@polaris/contracts`) traz linhas, ajustes, pagamento, `occurredAt` e `recordedAt`; o `commandId` vem do quadro do `sync.push` (ADR 0033). Não há perfil de pagamento: perfis não são coleção local, então a venda offline usa a forma de pagamento simples (limite registrado). O manipulador valida o payload com o esquema e com a mesma normalização do repositório (valores, descontos, pagamento), sem a checagem de relógio, e chama `confirmSale` sob a identidade `sale:create` (helper `withCapability`, ADR 0036).
- **Estoque é do servidor.** A venda toma o estoque de cada linha sob os locks do razão e é recusada inteira com `insufficient_stock` se qualquer linha não couber: nenhuma venda, pagamento ou movimento, e o estoque das linhas anteriores nunca é retirado. O dispositivo nunca decide que uma venda cabe. Ele só avisa (`warnings`) quando a cópia local do estoque parece baixa, e enfileira a venda do mesmo jeito: uma venda que aconteceu de fato não pode ser barrada por um saldo local desatualizado.
- **Códigos de recusa estáveis:** `insufficient_stock`, `sale_product_unavailable`, `variant_not_found`, `sale_occurred_too_old`, `sale_occurred_in_future`, `sale_command_conflict`, `invalid_payload`. Um erro de snapshot inesperado também vira `invalid_payload` em vez de derrubar a requisição em loop.
- **Estados locais da venda** (`OfflineSaleState`): `pending` (na fila), `syncing` (sendo enviada), `confirmed` (aceita; informada pelo `syncOutbox` em `acceptedCommands`, e depois presente nas vendas recentes que o pull traz), `rejected` (recusada por motivo de negócio: estoque, produto, data) e `needs_attention` (recusada por motivo de conta: acesso revogado, lease, dispositivo, direito; nada na venda está errado e a pessoa precisa resolver a conta antes, o que o PR58 trata).
- **Correção sem "forçar".** Uma venda `rejected` continua visível e bloqueia a fila. Como a recusa fica gravada para o `commandId` (reenviar o mesmo comando só repete a recusa), a saída é `resubmitRejectedSale`: o mesmo conteúdo, com o horário comercial e o `recordedAt` originais, como um comando novo com o lease atual, depois de a causa ser corrigida (o estoque que faltava foi recebido, o produto foi restaurado). O comando antigo só sai depois de o novo estar na fila, então uma queda no meio deixa uma recusa a descartar, nunca uma venda perdida; o gate prova que a mesma venda reenviada como comando novo é confirmada uma única vez. `discardPendingSale` é a ação explícita de "esta venda não aconteceu"; uma venda em `sending` não é descartada.
- **O estoque exibido desconta a fila.** O `effectiveStock` (ADR 0036) passa a subtrair as linhas das vendas pendentes ou em envio, uma por linha e sem ir abaixo de zero na tela; cada linha move a versão do saldo em um, repetições de uma variante incluídas, o que o gate confirma contra o razão real. Uma venda recusada ou descartada deixa de contar.
- **Provas.** O gate `offline-sale` roda a venda pelo quadro real do `sync.push`: confirmada uma vez com a evidência do dispositivo e repetida sem novo efeito; versão por linha; recusa total sem rastro quando a segunda linha não cabe; recusa gravada e reenvio como comando novo; janela de datas; duas vendas disputando as últimas unidades (uma vence, o estoque nunca fica negativo); isolamento entre organizações.

## Consequências

- Uma venda feita offline com estoque desatualizado pode ser recusada depois, quando o cliente já saiu com o produto. É o custo de o servidor ser a autoridade; a interface mostra o aviso no momento da venda e a fila de atenção (PR58) leva a pessoa a corrigir a causa e reenviar.
- Vendas criadas offline sobre um produto também criado offline funcionam porque a fila é enviada em ordem (o `product.create` vem antes).
- Uma venda mais antiga que a janela retroativa da organização (30 dias para o dono) é recusada por `sale_occurred_too_old`; um aparelho offline por mais tempo que isso precisa de decisão explícita da pessoa (descartar ou registrar de outra forma).

## Alternativas rejeitadas

- **Recusar localmente a venda sem estoque:** o saldo local pode estar defasado e a venda já aconteceu.
- **Aceitar a venda e deixar o estoque negativo para reconciliar depois:** quebra a invariante de saldo nunca negativo e o custo médio.
- **Um botão genérico de "forçar sincronização":** esconderia a causa e é proibido pelo plano.
- **Reaproveitar o `commandId` ao reenviar:** o servidor repetiria a recusa gravada.
