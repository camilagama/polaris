---
status: accepted
---

# Precisão do custo médio de estoque

A V1 recebe custo unitário BRL não negativo como string decimal com até 18 dígitos inteiros e seis casas, e calcula o custo médio móvel após cada recebimento com aritmética decimal exata, arredondando half-up a seis casas. CPC 16(R1), parágrafo 27, permite calcular a média por período ou a cada lote recebido, mas não prescreve escala decimal para a implementação; PostgreSQL NUMERIC fornece decimal exato e seu desempate para NUMERIC é arredondar afastando de zero, equivalente a half-up para custos não negativos ([CPC 16(R1)](https://www.cpc.org.br/Arquivos/Documentos/243_CPC_16_R1_rev%2012.pdf), [PostgreSQL 18: numeric](https://www.postgresql.org/docs/18/datatype-numeric.html)). A escala e a faixa inteira são políticas internas do produto, não exigências contábeis.
