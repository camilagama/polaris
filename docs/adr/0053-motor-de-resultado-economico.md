---
status: accepted
---

# Motor de resultado econômico: margem da venda e resultado do período

## Contexto

O plano pede, no PR66, que as despesas vinculadas a uma venda entrem na margem dela sem duplicar as taxas de processamento e de antecipação, e, no PR67, um motor de cálculos puros no domínio (vendas brutas, vendas líquidas, CMV, lucro bruto, margem de contribuição, resultado operacional estimado) com testes de propriedade. A documentação de vendas deixou em aberto, de propósito, a regra de rateio dos descontos e do frete por unidade devolvida, que precisa existir antes de calcular vendas líquidas. O resultado é uma estimativa gerencial: nunca lucro líquido nem caixa liquidado, e nunca com falsa precisão.

## Decisão

- **Cálculo puro, sobre fatos.** `packages/domain/src/economics/sale-economics.ts` recebe fatos (itens, ajustes, taxas do snapshot, linhas de devolução, despesas vinculadas, cancelamento) e devolve texto decimal exato; não lê relógio, banco nem framework e não usa ponto flutuante. A leitura dos fatos é outra camada (`economics-repository.ts`).
- **A cadeia.** Vendas brutas (preço cobrado × quantidade) menos descontos menos devoluções são as vendas líquidas; menos o CMV é o lucro bruto; mais acréscimos comerciais (acréscimo, frete e sobretaxa de pagamento) e menos custos variáveis (taxa de processamento, taxa de antecipação e despesas vinculadas à venda) é a margem de contribuição; menos as despesas operacionais do período (as sem venda, por competência) é o resultado operacional estimado.
- **Venda cancelada não conta.** Todos os valores dela são zero e ela não entra na contagem; as taxas e despesas dela também ficam de fora.
- **Devolução devolve o preço menos a parte do desconto.** O desconto da venda é dividido entre os itens na proporção do valor deles, em centavos inteiros que somam exatamente o desconto (maior resto; empate pela posição). A devolução devolve o preço cobrado das unidades devolvidas menos a parte do desconto do item proporcional às unidades devolvidas (arredondada para cima na metade, uma vez por item sobre o total devolvido, não linha a linha). Assim devolver tudo devolve exatamente "vendas brutas menos descontos", e dividir uma devolução em várias linhas não muda o resultado. **Acréscimo, frete e sobretaxa de pagamento não são devolvidos**: não são do item (o Polaris não processa o estorno do dinheiro; é uma estimativa).
- **O CMV desfaz só o que voltou ao estoque.** O custo é o custo do snapshot do item vezes a quantidade, menos as unidades repostas ao estoque (reposição ao custo do próprio item); uma unidade devolvida e não reposta (avariada) continua sendo custo. É calculado em decimais exatos a partir do custo de até seis casas e arredondado para o centavo uma vez por venda.
- **Desconhecido nunca vira zero.** Custo de item, taxa de processamento ou taxa de antecipação desconhecidos ficam fora do valor e são contados em `unknown`; o resultado diz que está incompleto em vez de fingir exatidão (o indicador de qualidade, PR69, parte daí). Uma taxa vem somente do snapshot do pagamento e uma despesa somente da tabela de despesas: o mesmo fato econômico tem uma única fonte, então a taxa de cartão já capturada na venda nunca é somada de novo como despesa.
- **A despesa vinculada compõe a margem da venda, no período da venda.** Uma despesa com `sale_id` entra na margem de contribuição da venda a que aponta, qualquer que seja a data de competência dela, para que a margem da venda esteja completa; só as despesas sem venda entram como despesas operacionais, pela competência. Uma despesa anulada não conta; a vinculada a venda cancelada sai com a venda.
- **O período é de calendário da organização, no máximo 366 dias.** As vendas do período são as de data comercial (`occurred_on`) nele; a leitura carrega as vendas na memória e por isso o período é limitado. Consultas otimizadas para os cartões do painel são o PR68.
- **Capability `report:read`.** Ler o resultado de um período (que expõe custo e margem) tem capability própria, conferida no repositório; só `owner` existe na V1. A leitura roda de preferência em `REPEATABLE READ` para um retrato consistente.
- **Provas.** Testes de unidade e de propriedade (a cadeia vale para qualquer venda válida; a devolução nunca passa do vendido líquido e a devolução total é exata; dividir as vendas em dois grupos soma o todo, em qualquer ordem; venda cancelada não muda nada; custo desconhecido sai do CMV em vez de valer zero) e o gate `economics` em PostgreSQL 18, com vendas reais (desconto, frete, taxa por perfil, custo desconhecido, devolução com reposição, cancelamento) e despesas vinculadas, anuladas e fora do período, conferido contra números feitos à mão e contra agregados SQL independentes.

## Consequências

- O resultado de um período é reproduzível: os mesmos fatos dão o mesmo resultado em qualquer ordem, e a soma de períodos disjuntos é a soma dos resultados.
- A venda retroativa usa o custo vigente na confirmação (limitação já aceita no ADR 0021), então o CMV dela herda essa limitação.
- O resultado do período pode mudar quando uma despesa vinculada é lançada depois: ela entra no período da venda, não no da competência dela. A tela do painel deve dizer "atualizado até" (PR71).
- Devolução não tem valor monetário no banco: o valor devolvido é derivado (preço cobrado menos a parte do desconto). Se um dia houver estorno registrado, ele passa a ser um fato novo da venda.

## Alternativas rejeitadas

- **Ratear também o frete e o acréscimo na devolução:** o frete cobrado não depende de quantas unidades ficaram; devolvê-lo inventaria um estorno que o Polaris não registra.
- **Arredondar a parte do desconto linha a linha:** devolver tudo poderia deixar 1 centavo de venda líquida, e dividir uma devolução em duas mudaria o resultado.
- **Tratar custo desconhecido como zero:** inflaria o lucro; a regra do projeto é nunca inferir custo zero.
- **Incluir a despesa vinculada pelo mês da competência:** a margem de uma venda mudaria conforme o mês em que a despesa foi lançada, e a margem da venda deixaria de ser a dela.
- **Calcular tudo em SQL:** concentra a regra num lugar sem property tests e sem decimais exatos; o SQL do PR68 será conferido contra este motor.
