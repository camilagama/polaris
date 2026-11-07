# Valores monetários

- A V1 opera em BRL.
- Valores financeiros são representados com decimal exato. A API transporta decimal como string; o banco usa PostgreSQL numeric.
- Cálculos financeiros autoritativos não usam IEEE-754 number.
- Escala, arredondamento e momento de arredondar precisam ser definidos por operação antes de implementar um cálculo; não inferir esses critérios a partir do formato de exibição.
- Na V1, valores monetários comerciais em BRL (preços, totais e ajustes) são persistidos com duas casas decimais e até 18 dígitos inteiros. O custo unitário de estoque e seu snapshot em venda mantêm até seis casas. Percentuais aceitam até seis casas fracionárias.
- Cálculos usam decimal exato e arredondamento half-up quando um resultado monetário é persistido. O ponto de arredondamento por linha, ajuste ou total deve ser declarado pela operação; os pontos usados nos ajustes e nas taxas da venda estão abaixo e em [vendas](sales.md).
- Percentuais são expressos em pontos percentuais: `2.5` representa `2,5%`. A direção do efeito vem da operação (por exemplo, desconto ou acréscimo), não de um percentual negativo.
- Um percentual de taxa ou de ajuste vai de 0 a 100 pontos percentuais, inclusive: 100 vale, acima de 100 é recusado (a constante `MAX_RATE_PERCENTAGE_POINTS` do domínio). O teto existe para que um valor digitado errado (250 em vez de 2,50) não distorça uma venda.
- `DecimalAmount` mantém até 10 casas exatas para intermediários: duas casas de BRL, seis do percentual e duas do divisor `100`. Aplicar um percentual a `Money` não arredonda; a operação escolhe explicitamente quando converter o resultado para `Money` half-up.
- Cada ajuste percentual de venda usa o subtotal negociado como a mesma base e arredonda half-up uma vez para centavos por ajuste; percentuais não se compõem.
- Cada taxa percentual efetiva de processamento ou antecipação usa o total devido da venda. Somar percentual e componente fixo em decimal exato e arredondar half-up uma vez por custo para persistir seu snapshot; as duas taxas permanecem separadas.
- O custo unitário BRL não negativo e o custo médio móvel de estoque usam até 18 dígitos inteiros e 6 casas fracionárias, com média recalculada em decimal exato e arredondada half-up para 6 casas a cada recebimento. Essa faixa é uma política interna do produto, não uma precisão prescrita pelo CPC 16 ([estoque](inventory.md), [ADR 0008](../adr/0008-inventory-cost-precision.md)).
