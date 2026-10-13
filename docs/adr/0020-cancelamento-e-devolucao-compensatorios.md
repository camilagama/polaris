---
status: accepted
---

# Cancelamento total e devolução parcial como registros compensatórios

## Contexto

O [ADR 0005](0005-corrigir-vendas-confirmadas-com-registros-compensatorios.md) decidiu corrigir vendas confirmadas por registros compensatórios, sem editar a venda. Ao implementar cancelamento e devolução, o plano deixou em aberto vários pontos que o projeto precisou decidir: o que acontece quando cancelamento e devolução disputam a mesma venda, como valorar o estoque que volta, se a devolução carrega valor monetário e o que fazer quando o produto da venda foi removido (tombstone, [ADR 0012](0012-product-tombstone-zero-balance.md)). A revisão do checkpoint Gate 4 também apontou que a regra da média na reposição inventava custo em um caso. As regras ficam em [sales.md](../business-rules/sales.md) e [inventory.md](../business-rules/inventory.md); o modelo de dados, em [sales-data-model.md](../architecture/sales-data-model.md).

## Decisão

Registro das decisões do PR45 e do PR46, mais as correções decididas na revisão do checkpoint Gate 4 (13/10/2026):

- **Dois registros compensatórios.** O cancelamento total (`sale_cancellations`) e a devolução parcial (`sale_returns` com `sale_return_items`) são registros novos, com movimentos de ledger inversos (`sale_cancellation`, `sale_return`) na mesma transação, e nunca editam a venda nem seus movimentos originais. O cancelamento é irreversível e acontece uma vez; uma venda aceita várias devoluções até esgotar as unidades.
- **Exclusão mútua.** Uma venda cancelada não recebe devolução e uma venda com devolução não pode ser cancelada por inteiro. Os dois comandos serializam por venda com um lock consultivo de transação (`lockSaleForCompensation`), e o banco repete a regra no commit por constraint triggers deferidos (`check_sale_cancellation_complete`, `check_sale_return_complete`), de modo que a regra vale mesmo para escritores diretos.
- **Devolvido e reposto são quantidades distintas.** Em cada linha, `returned <= disponível para devolução` e `restocked <= returned`. Só as unidades repostas geram movimento. Troca continua sendo devolução mais nova venda.
- **Sem valor monetário nesta fase.** A devolução não registra valor, estorno nem status de reembolso, porque o Polaris não processa o dinheiro devolvido e o impacto nas vendas líquidas pertence ao motor de métricas. A regra de rateio, decidida agora para não divergir do que a loja reembolsou quando o motor de métricas existir: o valor de uma linha devolvida é o valor líquido do item (preço cobrado × quantidade, mais a parte proporcional ao subtotal dos descontos e acréscimos de nível de venda) multiplicado por devolvido ÷ vendido, com half-up em centavos uma vez por linha e o resíduo de centavos na última unidade devolvida do item; frete e sobretaxa de pagamento não são devolvidos. Quando o motor de métricas (PR67) precisar do valor, ele será gravado como snapshot na devolução (coluna própria, nula nas devoluções anteriores) em vez de recalculado.
- **Valoração da reposição.** Cada unidade volta ao custo capturado no próprio item da venda. A regra da média, com a correção decidida na revisão (D-2):
  - custo do snapshot conhecido e saldo zero: a média passa a ser o custo do item;
  - custo conhecido, saldo positivo de média conhecida: média ponderada exata, half-up em seis casas, como em um recebimento;
  - custo conhecido, saldo positivo de média desconhecida: continua desconhecida;
  - **custo do snapshot desconhecido e saldo zero: a média passa a ser desconhecida (nula)**, em vez de manter a média antiga, que seria um custo inventado;
  - custo do snapshot desconhecido e saldo positivo: a média anterior é mantida.
  A reposição nunca é bloqueada por custo e nunca assume custo zero.
- **Produto removido (D-1).** Cancelamento e devolução **passam a ser permitidos** para venda com item de produto removido (tombstone). Para esses itens não há movimento de estoque: o saldo do produto removido é zero e imutável, e a compensação é registrada e auditada como qualquer outra. Isso substitui o comportamento anterior (recusa com `sale_product_unavailable`), que impedia uma devolução legítima de uma venda antiga. Produto arquivado continua recebendo estoque normalmente. Os triggers de completude precisam aceitar a ausência de movimento para itens de produto removido.
- **Motivos estruturados.** As listas de motivos de cancelamento e de devolução são decisão do projeto, com nota obrigatória apenas para `other`.

Estado de implementação: a exclusão mútua, as listas de motivos, a reposição ao custo do snapshot, a correção da média (D-2) e a permissão para produto removido (D-1) estão implementadas e provadas nos gates PostgreSQL (erify-sale-cancellation-gate, erify-review-hardening-gate); a regra de rateio acima ainda não tem código, porque depende do motor de métricas.

## Consequências

- O histórico econômico continua explicável: o que foi vendido, cancelado e devolvido são fatos separados, cada um auditado.
- Cancelamento e devolução podem ocorrer sobre produto removido sem tocar o ledger desse produto, mas os relatórios precisam entender que um item compensado de produto removido não tem movimento de volta.
- Não existe "desfazer cancelamento". Um engano de cancelamento se corrige com uma nova venda.
- A ausência de valor na devolução adia o cálculo de vendas líquidas; o rateio é pré-requisito do motor de métricas.

## Alternativas consideradas

- **Para produto removido, bloquear o tombstone enquanto houver venda recente.** Evita compensar sem estoque, mas impede a limpeza de catálogo por um prazo arbitrário.
- **Manter o bloqueio e documentar a rota "devolver tudo sem repor".** Preserva o código, mas exclui o cancelamento e torna devoluções legítimas impossíveis ou obscuras.
- **Editar a venda ou o ledger para refletir a correção.** Contraria o ADR 0005 e a evidência imutável.
- **Manter a média antiga com saldo zero.** Mais simples, mas faz um custo conhecido reaparecer sem que nenhum recebimento o justifique.
- **Marcar a média como desconhecida também com saldo positivo.** Mais conservador, porém descarta uma média conhecida por causa de uma fração das unidades; a regra escolhida só perde a média quando não há outro custo.
