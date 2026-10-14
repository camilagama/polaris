# Valores monetários

- A V1 opera em BRL.
- Valores financeiros são representados com decimal exato. A API transporta decimal como string; o banco usa PostgreSQL numeric.
- Cálculos financeiros autoritativos não usam IEEE-754 number.
- Escala, arredondamento e momento de arredondar precisam ser definidos por operação antes de implementar um cálculo; não inferir esses critérios a partir do formato de exibição.
- PR29 V1 recebe custo unitário BRL não negativo como string decimal com até 18 dígitos inteiros e 6 casas fracionárias, e mantém custo médio móvel com a mesma faixa. Cada recebimento recalcula a média em decimal exato e arredonda o resultado half-up para 6 casas. Essa faixa é uma política interna do produto, não uma precisão prescrita pelo CPC 16.
