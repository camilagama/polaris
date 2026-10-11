# Vendas

- Venda confirmada é snapshot econômico imutável: itens, variantes, quantidades, preços, custos, ajustes, fatos de pagamento e data econômica não são editados depois da confirmação.
- O banco persiste somente vendas confirmadas. `pending`, `syncing`, `rejected` e `needs_attention` pertencem à outbox local; uma transação do servidor grava o cabeçalho confirmado e todos os itens juntos. A V1 não persiste rascunhos de venda.
- Cada item da venda preserva UUID da variante, UUID do produto, rótulo do produto, posição e quantidade inteira positiva. Preço de tabela e preço cobrado são informados no comando da venda; produto e variante não têm preço de catálogo nesta etapa.
- A negociação por item é a diferença entre `listed_unit_price` e `charged_unit_price`; não registrar também essa mesma diferença como ajuste para evitar contagem duplicada.
- O subtotal é a soma de `charged_unit_price × quantity`. PR40 permite desconto e acréscimo fixos ou percentuais no nível da venda; frete e sobretaxa de pagamento são valores fixos.
- Cada ajuste percentual usa o mesmo subtotal após a negociação por item, sem compor sobre outros ajustes. Calcular em decimal exato e arredondar half-up para centavos uma vez por ajuste. A soma dos descontos não pode exceder o subtotal.
- O total devido é subtotal menos descontos, mais acréscimos, frete e sobretaxa de pagamento. A sobretaxa aumenta o valor devido pelo comprador; custos de processamento e antecipação permanecem separados e serão tratados pelos perfis do PR42.
- A V1 registra no máximo um pagamento por venda, cujo valor é igual ao total devido; não há pagamento parcial nem saldo pendente. Em dinheiro, o registro guarda o valor aplicado à venda, não o dinheiro entregue nem o troco.
- O pagamento registra um dos métodos V1: Pix, dinheiro, cartão de crédito, cartão de débito, transferência bancária ou outro. A escolha do método não comprova liquidação bancária.
- Cartão de crédito exige quantidade positiva de parcelas, limitada pelo tipo `integer` do PostgreSQL; os demais métodos não têm parcelas. Custos de processamento/antecipação desconhecidos permanecem desconhecidos, não zero.
- O custo unitário é snapshot do custo médio aplicável, com até seis casas decimais. Quando o custo for desconhecido, preservá-lo como `null` e indicar margem indeterminada; nunca inferir custo zero.
- Corrigir venda confirmada com cancelamento ou devolução. Preservar a venda e os movimentos originais.
- Devolução parcial registra separadamente a quantidade devolvida e a quantidade que volta ao estoque vendável; esses valores podem ser diferentes.
- Venda pode não ter cliente. Atribuição de cliente é separada e pode ser reconciliada depois sem mudar a economia da venda.
- Quando necessário, preservar um rótulo do comprador capturado na venda; não copiar telefone e email do cliente para toda venda por padrão.
- Venda offline permanece um command pendente local até o servidor validar e confirmar. Rejeição preserva o trabalho local para correção.
- Registrar separadamente horário comercial da venda, evidência local de criação e confirmação do servidor.
- O Polaris calcula resultado econômico estimado; não afirma que o pagamento foi liquidado em banco. Sinalizar custos e taxas desconhecidos em vez de fingir precisão.
