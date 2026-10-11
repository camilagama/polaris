# Valores monetários

- A V1 opera em BRL.
- Valores financeiros são representados com decimal exato. A API transporta decimal como string; o banco usa PostgreSQL numeric.
- Cálculos financeiros autoritativos não usam IEEE-754 number.
- Escala, arredondamento e momento de arredondar precisam ser definidos por operação antes de implementar um cálculo; não inferir esses critérios a partir do formato de exibição.
- Na V1, valores monetários comerciais em BRL (preços, totais e ajustes) são persistidos com duas casas decimais e até 18 dígitos inteiros. O custo unitário de estoque e seu snapshot em venda mantêm até seis casas. Percentuais aceitam até seis casas fracionárias.
- Cálculos usam decimal exato e arredondamento half-up quando um resultado monetário é persistido. O ponto de arredondamento por linha, ajuste ou total deve ser declarado pela operação; PR40 define a sequência e os pontos usados nos ajustes da venda.
- Percentuais são expressos em pontos percentuais: `2.5` representa `2,5%`. A direção do efeito vem da operação (por exemplo, desconto ou acréscimo), não de um percentual negativo.
- `DecimalAmount` mantém até 10 casas exatas para intermediários: duas casas de BRL, seis do percentual e duas do divisor `100`. Aplicar um percentual a `Money` não arredonda; a operação escolhe explicitamente quando converter o resultado para `Money` half-up.
- PR29 V1 recebe custo unitário BRL não negativo como string decimal com até 18 dígitos inteiros e 6 casas fracionárias, e mantém custo médio móvel com a mesma faixa. Cada recebimento recalcula a média em decimal exato e arredonda o resultado half-up para 6 casas. Essa faixa é uma política interna do produto, não uma precisão prescrita pelo CPC 16.
