# Valores monetários

- A V1 opera em BRL.
- Valores financeiros são representados com decimal exato. A API transporta decimal como string; o banco usa PostgreSQL numeric.
- Cálculos financeiros autoritativos não usam IEEE-754 number.
- Escala, arredondamento e momento de arredondar precisam ser definidos por operação antes de implementar um cálculo; não inferir esses critérios a partir do formato de exibição.
