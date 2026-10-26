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
- **A qualidade diz o que ficou de fora, nunca "boa" ou "ruim".** O indicador lista as entradas que faltam: itens sem custo conhecido (o custo deles não entrou no CMV), vendas sem taxa de processamento conhecida, vendas com antecipação sem taxa, nenhuma despesa de qualquer tipo, sem venda ou ligada a venda, no período com vendas (o resultado parece não ter custos além da mercadoria) e ausência de dados. Traz as contagens que explicam cada falta (linhas de item vendido e as sem custo, vendas e as sem taxa, despesas operacionais e vinculadas). O nível é `complete` quando nada faltou, `partial` quando algo faltou e `no_data` quando não há venda nem despesa; um período só com despesas não está "sem despesas" e é `complete`.
- **A tela nunca promete mais do que o indicador permite.** O resultado aparece como "Resultado operacional estimado", nunca como lucro líquido nem como caixa liquidado; quando a qualidade é parcial, a tela marca o resultado e a margem (a mais inflada por custo desconhecido) como estimativa incompleta e explica o que faltou em frases simples, com os números. Cancelamentos não deixam entradas desconhecidas para trás.
- **Só com conexão e só o confirmado.** O painel lê o servidor. Trabalho pendente do aparelho (vendas guardadas, edições) nunca entra no resultado; a leitura offline do último retrato confirmado, com "atualizado até", é o PR71.

## Emenda (25/10/2026): a série diária leve do Início, agregada em SQL

Registro datado; a decisão acima continua valendo para o resumo do período. Pedida pelo mapa "Ritmo de vendas" do Início (revisão de UI v7, aprovado pelo usuário em 25/10) e desenhada pelo Filipe (parecer de 25/10, item 6). O volume que o terceiro item da decisão esperava chegou: o mapa pede vendas líquidas e número de vendas de até 182 dias, e o `periodSummary` passaria cada venda desse meio ano pelo motor no Worker.

- **Um procedimento só para a série: `report.dailySales`.** Mesmo contexto tenant, mesma organização resolvida pelo servidor e mesma permissão (`report:read`) do `periodSummary`. Entrada: `from` e `to` no calendário da organização, no máximo 182 datas (`to − from ≤ 181`); período maior, invertido ou impossível é recusado como o do resumo. Saída compacta: `{ from, net: string[], count: number[] }`, uma posição por data a partir de `from`, `"0.00"` e `0` na data sem venda, dinheiro em texto decimal exato. Cerca de 2,4 KB para 182 datas.
- **O banco agrega, numa única consulta (um só instante).** `GROUP BY occurred_on` (a data comercial, ADR 0021) com a regra do motor para `netSales` escrita em SQL: venda cancelada fora; valor dos itens menos os descontos menos o que as devoluções devolveram, na data da venda; o item devolvido devolve o preço cobrado vezes as unidades menos a sua parte do desconto, com o rateio por valor em centavos inteiros (maior resto, empate pela posição) e a parte das unidades devolvidas arredondada para cima na metade. Nenhuma venda passa pelo motor no Worker.
- **O motor continua sendo a definição.** A conta em SQL é uma segunda escrita da mesma regra, e o gate `daily-sales` (PostgreSQL 18) prova que ela é igual a `periodSummary.daily` (`netSales` e `salesCount`) data a data, com descontos fixos e percentuais rateados com empate, devoluções parciais, repetidas e totais, cancelamentos, vendas um segundo antes e depois da meia-noite e lojas em fusos diferentes. Mudou a regra de vendas líquidas do motor, muda esta consulta no mesmo PR e o gate confere.
- **Fica de fora:** custos, resultado e qualquer outro número do resumo (continuam só do motor), a cópia offline da série (vem com a tela do mapa) e o índice `(organization_id, occurred_on)` em `sales`. Ele entrou depois (migration 0104, t393, provisória): o gate `daily-sales` exige que o `dailySales` e o `readPeriodFacts` do resumo leiam `sales` por ele, com histórico antigo semeado e `ANALYZE`; sem ele as duas consultas liam por `sales_organization_confirmed_idx` todas as vendas da organização e filtravam as datas, e o custo crescia com o histórico da loja.

## Emenda (26/10/2026): os cartões do Resultado v7 e a leitura do período anterior

Registro datado; o procedimento e os cartões que ele devolve não mudam. A tela do Resultado (revisão de UI v7, § 8, aprovada pelo usuário em 25/10) passa a mostrar **quatro** cartões no molde do Início: Resultado estimado, Vendas (vendas líquidas, com o número de vendas embaixo), Ticket médio e Margem. "Itens vendidos" continua no contrato e sai da tela.

- **O chip compara com o período anterior por uma segunda leitura do mesmo `periodSummary`.** Mês inteiro contra o mês anterior; outro intervalo contra o de mesmo tamanho que termina na véspera. Só depois de a leitura da tela responder, sem `topProducts`, numa tentativa só e sem cópia no aparelho: se falhar, o cartão fica sem chip e não diz nada. Nenhum número da tela vem dessa leitura, só a comparação.
- **O resultado só tem curva e chip com todos os dias conhecidos** (AC-9 do corte do Resultado, emenda de 25/10). Com dia de custo desconhecido, o cartão mostra o número do servidor com "estimativa incompleta" e "N de M dias sem custo informado"; a soma dos dias conhecidos nunca aparece como total.

## Emenda (26/10/2026): a cobertura do custo das mercadorias no contrato (`quality.cogsCoverage`)

Registro datado; o motor e os números do resumo não mudam, e os cartões e a cadeia só mudam nos dois casos de canto abaixo. Desenho t419, aprovado por Filipe, Rodrigo e Petković em 26/10. Até aqui só a tela decidia que o resultado não valia como estimativa quando nenhum custo de mercadoria era conhecido; a regra passa ao domínio e ao contrato.

- **O indicador de qualidade ganha `cogsCoverage`, calculado só pelas linhas de item** (`cogsCoverage()` no domínio, a mesma função no servidor e no aparelho): `full` quando nenhuma linha de item tem custo desconhecido (também sem linha alguma: o CMV é zero de fato), `none` quando há linhas de item e nenhuma tem custo conhecido (o CMV é zero por falta de dado) e `partial` nos demais. Taxa de processamento ou de antecipação desconhecida não entra: o dia continua nulo por ela, mas o período não vira `none`. Por isso o nome é do custo das mercadorias, não do custo em geral.
- **Com `none`, `cards.operatingResult`, `cards.marginPercent` e a cadeia seguem número, mas não são estimativa:** são as vendas menos o que se conhece. Quem mostra o resultado mostra que ele não existe (a tela usa "—").
- **O campo é aditivo (expandir).** O Worker novo convive com o aparelho de versão anterior, que ignora o campo; o aparelho novo, diante de uma cópia guardada antes do campo ou de um Worker anterior, deriva o valor das duas contagens que toda cópia válida tem (`itemLines` e `itemLinesWithUnknownCost`). O aparelho deriva sempre e não lê o campo do servidor, e um valor ausente ou desconhecido não invalida a cópia.
- **Anular `operatingResult`, `marginPercent` ou `cogs` com `none` (forma B do desenho) fica fora.** Quebraria o aparelho de versão anterior, que recusa resultado nulo. Se um dia fizer sentido, é um "contrair" futuro, por decisão explícita, depois de não existir aparelho antigo.
- **Sai a cláusula "todos os dias até hoje com resultado nulo"**, que dependia do "hoje" da loja e marcava "sem custo" períodos com CMV conhecido. Em dois casos de canto (só taxa desconhecida em todos os dias, ou todo dia com algo desconhecido mas algum CMV conhecido) o resultado passa a aparecer como qualquer parcial. `none` pelas linhas implica que todo dia com venda tem resultado nulo; o teste de propriedade do domínio prova isso.
- As metas ficam como estão nesta etapa.

## Consequências

- O painel e o resultado de um período sempre concordam, porque vêm do mesmo motor e da mesma leitura.
- Um período grande (um ano) carrega todas as vendas dele na memória do servidor; é aceitável para a escala da V1 e o teto de 366 dias existe por isso.
- A qualidade parcial é o estado normal de quem ainda não cadastrou custos e perfis de pagamento: a tela mostra o caminho (o que falta) em vez de esconder o número.

## Alternativas rejeitadas

- **Um endpoint por cartão:** várias leituras em instantes diferentes poderiam mostrar cartões que não fecham entre si.
- **Calcular os cartões em SQL já agora:** reimplementaria o rateio e os arredondamentos numa segunda linguagem sem os testes de propriedade do motor.
- **Uma nota única (0 a 100) de qualidade:** esconde o que fazer; a lista do que falta é acionável.
- **Cache do resultado:** o resultado muda a cada venda, devolução e despesa; um cache serviria um número velho com cara de oficial.
