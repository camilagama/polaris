# Estoque

- Produto, variante vendável, estoque e mídia são conceitos separados. Todo produto tem ao menos uma variante; combinações que não foram criadas não são vendáveis.
- Na V1, cada organização tem um único saldo por variante, sem locais/depósitos. A ausência de uma linha de saldo representa quantidade zero; a linha é materializada no primeiro movimento.
- Quantidade de estoque é inteira e o servidor nunca confirma saldo negativo.
- Histórico de movimentos é evidência imutável. O saldo atual é uma projeção; saldo e movimento correspondente mudam juntos.
- Um movimento preserva o UUID estável da variante. Se a variante padrão oculta já tiver qualquer movimento, a configuração inicial de opções é bloqueada; o sistema não transfere seu histórico nem sua quantidade para uma combinação presumida.
- O ledger classifica movimentos como recebimento, baixa, ajuste de contagem, venda, cancelamento de venda ou devolução de venda. O tipo não altera a regra de quantidade: o delta é explícito, inteiro e assinado.
- PR28 mantém o saldo médio como `numeric` exato, sem calcular ou arredondar custos. Não há comando público de estoque nesta etapa; a idempotência é aplicada pelo command nomeado que aceitar cada movimento.
- O ledger impede remoção física de variante e organização enquanto existir histórico. A política de retenção e o caminho privilegiado de purge seguem adiados para PR107, antes do go-live.
- Receber, baixar, contar, vender, cancelar e devolver são commands nomeados. Nenhuma mudança de quantidade é válida sem seu movimento correspondente.
- Recebimentos atualizam custo médio móvel. Uma venda confirmada preserva o custo unitário aplicável no momento.
- Quando a validade da operação depende de vários fatos econômicos, eles são confirmados ou revertidos em conjunto.
- Em disputa de commands offline, a primeira operação confirmada no servidor vence. A operação rejeitada permanece local para correção; não há merge silencioso.
- PR25 cria a variante padrão junto com cada produto; até PR26 disponibilizar opções, produtos novos usam essa única variante oculta na UI. Regras completas em [products.md](products.md).
