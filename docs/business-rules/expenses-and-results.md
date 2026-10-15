# Despesas e resultado do negócio

- Despesas usam competência: a despesa pertence ao período de referência, mesmo quando o pagamento ocorre em outro período.
- Uma despesa tem uma categoria na V1. Recorrência gera ocorrências; editar uma regra futura não reescreve ocorrências históricas.
- Os grupos de despesa são fixos (Comercial, Operacional/Administrativa, Financeira, Impostos, Outras); as categorias dentro deles são da organização, com nome único na organização inteira (sem diferenciar grupo nem caixa) e nunca são apagadas, só arquivadas. O grupo de uma categoria não muda. Uma categoria arquivada não aceita despesa nova, mas as que já estão nela continuam editáveis. Uma organização nova começa com categorias padrão ([ADR 0051](../adr/0051-despesas-categorias-e-lancamentos.md)).
- O valor da despesa é BRL, decimal exato, maior que zero e com no máximo duas casas ([dinheiro](money.md)). A descrição é obrigatória (até 200 caracteres) e o favorecido, opcional (até 120).
- A data de competência é uma data de calendário da organização: não pode ser anterior a 2000-01-01 nem mais de 366 dias depois de hoje (no calendário da organização). Pode ser futura ou antiga, diferente da venda. A janela é conferida quando a data é informada ou alterada.
- Despesa não é apagada: a lançada por engano é anulada (fica gravada e auditada, sai das listas e dos totais por padrão) e pode ser reativada; a anulada é somente leitura. Editar exige a versão que a pessoa viu; uma edição sobre versão antiga é recusada.
- Todas as operações de despesas e de categorias de despesa exigem a capability `expense:create`.
- Compra de estoque aumenta inventário; o custo do produto entra no resultado como CMV quando vendido. Não contar o mesmo fato como compra de estoque e despesa operacional.
- Taxas de processamento e antecipação já capturadas na venda não podem ser digitadas de novo como despesa.
- Uma despesa pode apontar para uma venda e então compor a margem de contribuição daquela venda. Despesa sem vínculo afeta somente o resultado do período.
- Vendas brutas menos descontos e devoluções formam vendas líquidas. Vendas líquidas menos CMV formam lucro bruto. Lucro bruto mais acréscimos comerciais e menos custos variáveis formam margem de contribuição; margem de contribuição menos despesas operacionais forma resultado operacional estimado.
- Exibir resultado como estimativa, não como lucro líquido ou caixa liquidado. Indicar quando custos, taxas ou despesas estiverem incompletos.
- Metas V1 medem vendas líquidas, resultado operacional estimado ou número de vendas. Mudança de alvo durante o período é auditada; meta concluída não reabre automaticamente.
