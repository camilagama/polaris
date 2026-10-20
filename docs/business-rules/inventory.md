# Estoque

Este arquivo é a fonte de verdade para as invariantes de estoque. Os efeitos de venda, cancelamento e devolução no ledger estão detalhados em [vendas](sales.md) e em [sales-data-model.md](../architecture/sales-data-model.md); as datas, em [time-and-dates.md](time-and-dates.md).

## Modelo

- Produto, variante vendável, estoque e mídia são conceitos separados. Todo produto tem ao menos uma variante; combinações que não foram criadas não são vendáveis. Regras de produto e variante em [products.md](products.md).
- Na V1, cada organização tem um único saldo por variante, sem locais/depósitos. A ausência de uma linha de saldo representa quantidade zero; a linha é materializada no primeiro movimento.
- Quantidade de estoque é inteira e o servidor nunca confirma saldo negativo.
- Histórico de movimentos é evidência imutável. O saldo atual é uma projeção; saldo e movimento correspondente mudam juntos.
- Um movimento preserva o UUID estável da variante. Se a variante padrão oculta já tiver qualquer movimento, a configuração inicial de opções é bloqueada; o sistema não transfere seu histórico nem sua quantidade para uma combinação presumida.
- O ledger classifica movimentos como recebimento, baixa, ajuste de contagem, venda, cancelamento de venda ou devolução de venda. O tipo não altera a regra de quantidade: o delta é explícito, inteiro e assinado.
- Receber, baixar, contar, vender, cancelar e devolver são commands nomeados. Não existe command público genérico de estoque nem mutation direta do saldo; nenhuma mudança de quantidade é válida sem seu movimento correspondente.
- Decidido na revisão do checkpoint Gate 4 (13/10/2026) e verificado no código: o banco reconcilia saldo e ledger (por trigger deferido, de modo que a quantidade do saldo seja a soma dos deltas), e cada movimento recebe uma sequência por variante gravada sob o lock do saldo, que define a ordem de confirmação, em vez do horário de início da transação.
- O ledger impede remoção física de variante e organização enquanto existir histórico. A política de retenção e o caminho privilegiado de purge ficam adiados para a fase de privacidade, antes do go-live.
- Quando a validade da operação depende de vários fatos econômicos, eles são confirmados ou revertidos em conjunto.
- Em disputa de commands offline, a primeira operação confirmada no servidor vence. A operação rejeitada permanece local para correção; não há merge silencioso.

## Custo médio

- O custo unitário é BRL não negativo, em string decimal com até 18 dígitos inteiros e 6 casas fracionárias. O custo médio móvel usa a mesma faixa, aritmética decimal exata e arredondamento half-up a 6 casas. Custo zero é válido; saldo positivo com custo médio desconhecido não é tratado como custo zero. A faixa é política interna do produto ([ADR 0008](../adr/0008-inventory-cost-precision.md)).
- Recebimentos atualizam o custo médio móvel após cada recebimento. Uma venda confirmada preserva o custo unitário aplicável no momento.
- A média evolui na ordem em que os commands são confirmados no servidor. Um recebimento retroativo não reescreve snapshots de custo de vendas anteriores.
- A **venda retroativa** usa o custo médio e o estoque vigentes na confirmação, não os da data comercial. Decidido na revisão do checkpoint Gate 4 (13/10/2026) como limitação aceita: o CMV de uma venda retroativa usa o custo atual, e o saldo "na data D" reconstruído por `occurred_on` pode divergir do físico daquela data. Calcular o custo e o saldo por data exigiria um razão por data, fora da V1 ([ADR 0021](../adr/0021-datas-da-venda-e-janela-retroativa.md)).

## Recebimento

- Todo novo recebimento registra custo unitário e commandId/version/occurredOn. O banco rejeita novos receipts sem esses dados; o writer interno genérico não pode criar receipts. Histórico legado sem custo permanece imutável e com valoração desconhecida, sem custo presumido ([ADR 0009](../adr/0009-legacy-receipt-compatibility.md)).
- `receiveStock` é o command nomeado de recebimento. Cada recebimento exige commandId UUID versionado. Repetir a mesma versão e payload não lança novo movimento; reutilizar o commandId com payload diferente é conflito.
- `receiveStock` é bloqueado enquanto houver saldo positivo sem custo médio conhecido, até uma valoração explícita.
- A data de ocorrência é uma data de calendário da organização e documenta quando o recebimento ocorreu.

## Baixa

- `writeOffStock` é o command nomeado de baixa. A quantidade da entrada é positiva; o servidor grava o delta negativo e rejeita a baixa que deixaria o saldo abaixo de zero. Não é permitido criar baixa pelo writer genérico.
- Toda nova baixa exige `reasonCode` dentre `damaged`, `expired`, `lost`, `stolen`, `internal_use` ou `other`. A nota é opcional para os motivos classificados e obrigatória para `other`; o código deve corresponder exatamente à lista e a nota é aparada e limitada a 500 pontos de código Unicode antes de persistir. Ambos integram o payload idempotente.
- A baixa exige `occurredOn` como data de calendário da organização.
- Valoração ([ADR 0010](../adr/0010-inventory-write-off.md)): quando há custo médio conhecido, o movimento preserva esse valor como snapshot unitário, sem recalcular a média do saldo. Quando o custo médio é desconhecido, a baixa continua permitida e o snapshot permanece nulo; o command não cria lançamento de despesa.
- A constraint de motivo é `NOT VALID` para preservar movimentos `write_off` legados sem motivo, que são append-only; PostgreSQL aplica a regra aos novos movimentos.

## Contagem

- `inventoryCount` é o command de quantidade física absoluta. O cliente lê saldo e versão com `inventory.getBalance`; a contagem informa `expectedVersion`, e uma versão desatualizada conflita. O servidor calcula o delta sob lock e grava quantidade contada, versão esperada, movimento, saldo e audit na mesma transação.
- Repetir o mesmo command de contagem não duplica efeito; reutilizar commandId com quantidade contada, expectedVersion ou entrada explícita de valoração diferentes conflita. Uma contagem sem diferença persiste como evento `inventory_count` de delta zero e avança a versão; ela também passa a compor o histórico imutável da variante.
- Valoração ([ADR 0011](../adr/0011-inventory-count.md)): custo médio conhecido é preservado e capturado como snapshot. Se for desconhecido, continua nulo salvo `valuationUnitCost` explícito em contagem positiva; esse input é persistido separado de `unitCost` para integrar o payload idempotente. A contagem não inventa custo zero. Saldo positivo ainda sem custo mantém `receiveStock` bloqueado até uma valoração futura explícita.

## Reposição por cancelamento ou devolução

- Cancelamento e devolução de venda devolvem unidades ao saldo por movimentos compensatórios (`sale_cancellation` e `sale_return`), nunca editando os movimentos originais.
- As unidades voltam ao custo capturado no item da venda (o snapshot). A regra da média é:
  - snapshot conhecido e saldo zero: a média passa a ser o custo do snapshot;
  - snapshot conhecido e saldo positivo de média conhecida: a média é recalculada como em um recebimento (média ponderada exata, half-up em 6 casas);
  - snapshot conhecido e saldo positivo de média desconhecida: a média continua desconhecida;
  - snapshot desconhecido e saldo positivo: a média anterior é mantida;
  - snapshot desconhecido e **saldo zero**: a média passa a ser desconhecida (nula). Decidido na revisão do checkpoint Gate 4 (13/10/2026) e verificado no código; o comportamento anterior mantinha a média antiga, o que inventava um custo.
- A operação nunca é bloqueada por custo e nunca assume custo zero.
- Produto removido (tombstone) tem saldo zero e imutável. Decidido na revisão do checkpoint Gate 4 (13/10/2026) que cancelamento e devolução de venda com item desse produto são permitidos **sem movimento de estoque** para esses itens; a compensação continua registrada e auditada ([vendas](sales.md)).

## Remoção de produto

- O tombstone do produto só é permitido com saldo agregado zero entre suas variantes; a ausência de saldo materializado conta como zero ([ADR 0012](../adr/0012-product-tombstone-zero-balance.md)). Todos os movimentos, variantes e saldos permanecem.
- Depois do tombstone, novos writes de saldo/ledger são recusados, mas leituras históricas e replay de command já registrado continuam válidos.
- Recebimentos, baixas, contagens e tombstone serializam pela linha do produto. Triggers repetem no banco a proteção de saldo e impedem writes diretos após tombstone.
