# Vendas

- Venda confirmada é snapshot econômico imutável: itens, variantes, quantidades, preços, custos, ajustes, fatos de pagamento e data econômica não são editados depois da confirmação.
- O banco persiste somente vendas confirmadas. `pending`, `syncing`, `rejected` e `needs_attention` pertencem à outbox local; uma transação do servidor grava o cabeçalho confirmado e todos os itens juntos. A V1 não persiste rascunhos de venda.
- Cada item da venda preserva UUID da variante, UUID do produto, rótulo do produto, posição e quantidade inteira positiva. Preço de tabela e preço cobrado são informados no comando da venda; produto e variante não têm preço de catálogo nesta etapa.
- O custo unitário é snapshot do custo médio aplicável, com até seis casas decimais. Quando o custo for desconhecido, preservá-lo como `null` e indicar margem indeterminada; nunca inferir custo zero.
- Corrigir venda confirmada com cancelamento ou devolução. Preservar a venda e os movimentos originais.
- Devolução parcial registra separadamente a quantidade devolvida e a quantidade que volta ao estoque vendável; esses valores podem ser diferentes.
- Venda pode não ter cliente. Atribuição de cliente é separada e pode ser reconciliada depois sem mudar a economia da venda.
- Quando necessário, preservar um rótulo do comprador capturado na venda; não copiar telefone e email do cliente para toda venda por padrão.
- Venda offline permanece um command pendente local até o servidor validar e confirmar. Rejeição preserva o trabalho local para correção.
- Registrar separadamente horário comercial da venda, evidência local de criação e confirmação do servidor.
- O Polaris calcula resultado econômico estimado; não afirma que o pagamento foi liquidado em banco. Sinalizar custos e taxas desconhecidos em vez de fingir precisão.
