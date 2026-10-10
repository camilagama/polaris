---
status: proposed
---

# Motivo e valoração da baixa de estoque

PR30 representa a baixa por `writeOffStock`, com quantidade positiva no command e delta negativo no ledger, impedindo saldo negativo. O motivo é um código estável (`damaged`, `expired`, `lost`, `stolen`, `internal_use`, `other`); uma nota de até 500 pontos de código Unicode acompanha qualquer código e é obrigatória para `other`, para permitir relatórios agrupados sem perder a explicação de casos não classificados.

A baixa exige `occurredOn` como data de calendário da organização. Ela captura o custo médio unitário conhecido no movimento, mas não recalcula o custo médio remanescente nem cria lançamento de despesa. Saldo positivo sem custo conhecido continua baixável e preserva `unit_cost = NULL`: registrar um zero inventaria um custo, e bloquear a correção de quantidade manteria estoque incorreto. O snapshot permite valoração futura sem assumir um efeito contábil que ainda não foi definido.

A constraint do motivo é adicionada como `NOT VALID`, pois baixas antigas não têm motivo e o ledger é append-only; a regra passa a valer para novos movimentos sem alterar histórico.
