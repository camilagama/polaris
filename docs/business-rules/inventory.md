# Estoque

- Produto, variante vendável, estoque e mídia são conceitos separados. Todo produto tem ao menos uma variante; combinações que não foram criadas não são vendáveis.
- Quantidade de estoque é inteira e o servidor nunca confirma saldo negativo.
- Histórico de movimentos é evidência imutável. O saldo atual é uma projeção; saldo e movimento correspondente mudam juntos.
- Receber, baixar, contar, vender, cancelar e devolver são commands nomeados. Nenhuma mudança de quantidade é válida sem seu movimento correspondente.
- Recebimentos atualizam custo médio móvel. Uma venda confirmada preserva o custo unitário aplicável no momento.
- Quando a validade da operação depende de vários fatos econômicos, eles são confirmados ou revertidos em conjunto.
- Em disputa de commands offline, a primeira operação confirmada no servidor vence. A operação rejeitada permanece local para correção; não há merge silencioso.
- PR25 cria a variante padrão junto com cada produto; até PR26 disponibilizar opções, produtos novos usam essa única variante oculta na UI. Regras completas em [products.md](products.md).
