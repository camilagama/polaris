---
status: accepted
---

# Produto criado offline: um comando atômico com variante padrão e estoque de abertura

## Contexto

O PR55 do plano pede criar produto e variante offline com UUIDv7, tratamento de conflito de SKU e estoque inicial opcional, e a sincronização precisa ser atômica. O molde é o do cliente ([ADR 0034](0034-cliente-criado-offline.md)): o dispositivo nomeia o que cria, o comando é idempotente e o servidor revalida tudo. A diferença é que um produto envolve várias tabelas e, com estoque de abertura, dois domínios (catálogo e estoque) com capabilities diferentes.

## Decisão

- **Um comando, `product.create`.** Produto, variante padrão e, se o formulário trouxe, a entrada de estoque viajam juntos e são executados na mesma transação e no mesmo savepoint do quadro do `sync.push` (ADR 0033). Ou tudo existe depois, ou nada existe: um SKU em uso, um ID ocupado, uma categoria indisponível ou uma data de estoque no futuro recusam o comando inteiro e não deixam produto, variante, saldo, movimento nem evento de auditoria (provado no gate `offline-product`).
- **IDs do dispositivo.** O dispositivo gera o UUIDv7 do produto e o da variante padrão, para que vendas e movimentos enfileirados depois já os referenciem. `createProduct` aceita `id`, `defaultVariantId`, `sku` e `listPrice`; valida o formato, insere produto e variante em um savepoint e converte as violações de unicidade em erros de domínio: `ProductIdConflictError` (produto ou variante; a chave é global, então outra organização usando o mesmo UUID também conflita) e `ProductVariantSkuConflictError` (único por organização, sem diferenciar maiúsculas).
- **Conflito de SKU é uma recusa clara, não uma reescrita.** O servidor responde `sku_conflict` (e `product_id_conflict`, `category_unavailable`, `inventory_date_in_future`, `invalid_payload`). O produto recusado continua visível e marcado, e a fila espera. A saída é `discardPendingProduct`, uma ação explícita que remove o comando e as linhas locais; ela é recusada se outro comando enfileirado referencia o produto ou a variante (descartá-lo deixaria aquele comando apontando para o nada) e se o comando está em `sending` (o servidor pode já ter criado). A interface do conflito é do PR58.
- **Capability do estoque de abertura.** O comando exige `product:create`; quando há estoque, exige também `inventory:adjust`. O ponto de extensão `extraCapabilities(payload)` do manipulador faz o `sync.push` exigir as duas no lease (e o banco já revalida que o papel ainda as tem). A transação do `sync.push` roda com a capability `sync:push`; o manipulador chama `receiveStock` com uma identidade derivada que carrega `inventory:adjust`, o que só é seguro porque a capability foi exigida do lease. O gate prova que `receiveStock` sob `sync:push` puro é negado.
- **Estoque de abertura como recebimento.** O estoque vira um movimento `receipt` com o custo unitário e o `commandId` do comando, na data informada (a mesma regra de data de estoque do fluxo online: não pode estar no futuro do fuso da organização; relógio adiantado do dispositivo vira `inventory_date_in_future`). O saldo e a média de custo seguem as regras existentes.
- **Cliente.** `createOfflineProduct` valida com as mesmas regras do servidor (nome, descrição, SKU, preço, quantidade, custo, data), enfileira o comando e grava as linhas otimistas (produto, variante padrão e saldo); `restorePendingProducts` as recria após uma queda; `pendingProducts` expõe o estado para a interface. O `syncOutbox` do ADR 0034 serve sem mudança, e o change log (`product` e `inventory_balance`) troca as linhas otimistas pelas do servidor.

## Consequências

- Só a variante padrão é criada offline. Configurar opções e variantes (`configureProductVariants`) continua online; fica como limite registrado.
- O saldo local mostrado de um produto recém-criado é otimista; para vender (PR57) o estoque continua sendo autoridade do servidor.
- Um SKU recusado depois de o dispositivo ter vendido o produto offline é o caso difícil: o descarte é bloqueado enquanto houver comandos dependentes, e a resolução fica para o PR58.

## Alternativas rejeitadas

- **Dois comandos (produto e depois estoque):** permitiria um produto sem o estoque digitado no mesmo formulário e dois pontos de falha com um deles já efetivado.
- **Reescrever o SKU em conflito:** esconderia um erro real e quebraria etiquetas e códigos que a pessoa já usa.
- **Uma capability nova (`product:create_with_stock`):** duplicaria `product:create` e `inventory:adjust`; exigir as duas reaproveita o que o papel já concede.
