---
status: accepted
---

# Painel de resultado e indicador de qualidade

## Contexto

Com o motor do ADR 0053, falta mostrar o resultado de um período ao dono (PR68, consultas e cartões do painel) e dizer o quanto ele é confiável (PR69, indicador de qualidade). O produto afirma, em todos os lugares, que o resultado é uma estimativa e que dado desconhecido não vira zero. O plano pede ainda que o painel não use cache SQL do Hyperdrive.

## Decisão

- **Um só procedimento, `report.periodSummary`.** Recebe o período (data inicial e final inclusivas, no calendário da organização, até 366 dias) e devolve de uma vez os cartões, a cadeia do resultado e a qualidade. Exige `report:read`, lê numa única transação `REPEATABLE READ` (várias consultas, um só instante) e usa a mesma conexão tenant de todo o servidor: nada dele passa por cache SQL do Hyperdrive, que continua desabilitado para dados de tenant.
- **Os cartões vêm do motor, não de uma segunda conta em SQL.** O painel mostra Vendas líquidas, Resultado estimado, Margem, Vendas, Ticket médio e Itens vendidos. A margem é a margem de contribuição sobre as vendas líquidas, em percentual com duas casas (arredondado para cima na metade; vazia quando as vendas líquidas não são positivas); o ticket médio é as vendas líquidas por venda confirmada e não cancelada, arredondado para o centavo (vazio sem vendas); os itens são as unidades vendidas menos as devolvidas. Os valores monetários trafegam como texto decimal exato.
- **A "consulta otimizada" é a leitura limitada e em blocos.** As vendas do período são lidas com poucas consultas por tabela (em blocos de 5.000 identificadores) e o cálculo é do motor; o período tem teto de 366 dias e o painel abre no mês corrente. Uma agregação em SQL que reproduza o rateio do desconto e os arredondamentos do motor é possível e só se justifica quando o volume pedir; ela teria de ser conferida contra o motor, que continua sendo a definição.
- **A qualidade diz o que ficou de fora, nunca "boa" ou "ruim".** O indicador lista as entradas que faltam: itens sem custo conhecido (o custo deles não entrou no CMV), vendas sem taxa de processamento conhecida, vendas com antecipação sem taxa, nenhuma despesa registrada no período com vendas (o resultado parece não ter custos além da mercadoria) e ausência de dados. Traz as contagens que explicam cada falta (linhas de item e as sem custo, vendas e as sem taxa, despesas operacionais e vinculadas). O nível é `complete` quando nada faltou, `partial` quando algo faltou e `no_data` quando não há venda nem despesa; um período só com despesas não está "sem despesas" e é `complete`.
- **A tela nunca promete mais do que o indicador permite.** O resultado aparece como "Resultado operacional estimado", nunca como lucro líquido nem como caixa liquidado; quando a qualidade é parcial, a tela marca a estimativa como incompleta e explica o que faltou em frases simples, com os números. Cancelamentos não deixam entradas desconhecidas para trás.
- **Só com conexão e só o confirmado.** O painel lê o servidor. Trabalho pendente do aparelho (vendas guardadas, edições) nunca entra no resultado; a leitura offline do último retrato confirmado, com "atualizado até", é o PR71.

## Consequências

- O painel e o resultado de um período sempre concordam, porque vêm do mesmo motor e da mesma leitura.
- Um período grande (um ano) carrega todas as vendas dele na memória do servidor; é aceitável para a escala da V1 e o teto de 366 dias existe por isso.
- A qualidade parcial é o estado normal de quem ainda não cadastrou custos e perfis de pagamento: a tela mostra o caminho (o que falta) em vez de esconder o número.

## Alternativas rejeitadas

- **Um endpoint por cartão:** várias leituras em instantes diferentes poderiam mostrar cartões que não fecham entre si.
- **Calcular os cartões em SQL já agora:** reimplementaria o rateio e os arredondamentos numa segunda linguagem sem os testes de propriedade do motor.
- **Uma nota única (0 a 100) de qualidade:** esconde o que fazer; a lista do que falta é acionável.
- **Cache do resultado:** o resultado muda a cada venda, devolução e despesa; um cache serviria um número velho com cara de oficial.
