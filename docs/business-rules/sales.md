# Vendas

- Venda confirmada é snapshot econômico imutável: itens, variantes, quantidades, preços, custos, ajustes, fatos de pagamento e data econômica não são editados depois da confirmação.
- Corrigir venda confirmada com cancelamento ou devolução. Preservar a venda e os movimentos originais.
- Devolução parcial registra separadamente a quantidade devolvida e a quantidade que volta ao estoque vendável; esses valores podem ser diferentes.
- Venda pode não ter cliente. Atribuição de cliente é separada e pode ser reconciliada depois sem mudar a economia da venda.
- Quando necessário, preservar um rótulo do comprador capturado na venda; não copiar telefone e email do cliente para toda venda por padrão.
- Venda offline permanece um command pendente local até o servidor validar e confirmar. Rejeição preserva o trabalho local para correção.
- Registrar separadamente horário comercial da venda, evidência local de criação e confirmação do servidor.
- O Polaris calcula resultado econômico estimado; não afirma que o pagamento foi liquidado em banco. Sinalizar custos e taxas desconhecidos em vez de fingir precisão.
