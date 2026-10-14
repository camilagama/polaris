---
status: accepted
---

# Compatibilidade de recebimentos legados

A primitive interna introduzida em PR28 aceitava registrar `receipt` sem custo ou metadados de command; ela não era exposta por RPC. Como `stock_movements` é append-only e não há fonte segura para inferir custo histórico, PR29 não atualiza esses movimentos nem inventa valores. A migration 0020 adiciona a constraint de custo e command com `NOT VALID`: no PostgreSQL 18 isso não varre as linhas existentes, mas exige que todo novo `INSERT` ou `UPDATE` satisfaça a constraint. Linhas antigas só poderão ser validadas após um tratamento de histórico explicitamente definido ([PostgreSQL 18 — ALTER TABLE](https://www.postgresql.org/docs/18/sql-altertable.html)).

Um saldo legado positivo com custo médio nulo continua sem valoração conhecida, e `receiveStock` bloqueia novo recebimento até que uma operação futura defina esse custo. A migration não cria ajuste contábil nem reprecifica vendas anteriores.
