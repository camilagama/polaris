---
status: accepted
---

# Venda paga em partes

> Número provisório até o merge (o 0106 é o último na `main` e nenhum PR aberto reserva o 0107; pode mudar se outro ADR entrar antes). A migration citada (0139) também é provisória. Emenda o [ADR 0019](0019-venda-atomica-por-constraint-triggers-deferidos.md) (o gatilho de confirmação deixa de exigir exatamente um pagamento) e segue o [ADR 0096](0096-migrations-compativeis-com-a-versao-anterior-do-worker.md) (expand/contract).

## Contexto

A V1 registrava um pagamento por venda, igual ao total devido. No balcão, o comprador paga parte no Pix e parte no cartão, ou parte em dinheiro e parte no débito; o operador não tinha como registrar isso sem mentir o método ou partir a venda em duas (o que desfaz itens, devoluções e cancelamento). O banco reforçava a regra em dois lugares: o índice único `(organization_id, sale_id)` de `sale_payments` e o gatilho deferido `check_sale_confirmation_complete`, que exigia uma linha e o valor igual ao total.

Decisões do usuário de 22/11/2026: até 2 partes na tela, até 3 no banco; a venda offline também pode ser dividida já no MVP; cada parte tem o seu perfil de pagamento; não existe fiado (sem saldo pendente nem pagamento parcial); o troco é só uma conta da tela e não é gravado.

## Decisão

- **De uma a três partes que somam o total devido.** Uma venda confirmada tem de 1 a 3 linhas em `sale_payments`, na ordem em que o operador as informou (`position` de 0 a 2, sem buraco), e a soma dos valores é exatamente o total devido, em `numeric` exato. Com mais de uma parte, cada parte vale mais que zero; uma venda de total zero tem uma parte de valor zero. Não há pagamento parcial nem saldo pendente.
- **O cabeçalho declara quantas partes a venda tem** (`sales.payment_count`, de 1 a 3), como já declarava itens e ajustes. O gatilho deferido confere no commit: o número de linhas é o declarado, as posições vão de 0 a `payment_count − 1`, a soma é o total devido e, com mais de uma parte, nenhuma é zero ou negativa. Os `CHECK` recusam antes do gatilho: a 4ª parte (`position` 3) cai em `sale_payments_position_allowed` e `payment_count` 4 em `sales_payment_count_allowed` (também 23514, com o nome do `CHECK`). Só a contagem diferente da declarada, as posições com buraco, a soma diferente do total e a parte zero ou negativa com mais de uma parte usam o nome de restrição `sales_confirmation_payment_complete` (23514). O resto do gatilho (itens, ajustes, movimentos e data) não muda.
- **Unicidade por posição.** O índice único passa a `(organization_id, sale_id, position)`. Um segundo pagamento gravado sem posição repete a posição 0 e bate no índice (23505), como antes; acrescentar uma parte depois do commit continua recusado pelo gatilho, porque a contagem do cabeçalho não muda (o runtime segue sem `UPDATE` e `DELETE`).
- **Teto no banco e teto no contrato.** O banco aceita 3 (`CHECK` de `position` entre 0 e 2 e de `payment_count` entre 1 e 3); o contrato e a tela do MVP aceitam 2. Afrouxar para 3 depois é código, sem migration; passar de 3 pede migration nova.
- **Compatível com o Worker anterior (expand).** `position` tem default 0 e `payment_count` default 1, constantes: o Worker de hoje grava uma parte sem posição e um cabeçalho sem contagem, e isso continua válido; as linhas já gravadas ficam com os defaults, sem backfill e sem reescrever a tabela (PostgreSQL 18). A migration é a 0139, com `lock_timeout` de 10 s; os dois `CHECK` leem a tabela inteira e o índice novo é construído sem `CONCURRENTLY`, ambos com a escrita bloqueada durante a leitura, o que cabe no tamanho de `sale_payments` e `sales` antes do go-live.
- **O que vem depois, em fatias.** O comando `sale.confirm` continua na versão 1 e ganha `payments[]` opcional ao lado de `payment` (exatamente um dos dois), com o perfil dentro de cada parte: o contrato só cresce e o servidor sobe antes do app. As leituras passam a usar a parte de posição 0 como a principal (a regra provisória de hoje, maior valor e menor id no empate, sai nessa fatia), e a lista do Histórico ganha os métodos das partes na ordem da posição.

## Consequências

- O banco já aceita partes antes de o servidor gravá-las; a primeira escrita de mais de uma parte vem com o contrato. Até lá, toda venda tem `payment_count` 1 e uma parte de posição 0.
- Quem soma taxas ou escolhe "o método" da venda precisa ler todas as partes: os números do Início, do Resultado e das Metas contam cada venda uma vez e somam as taxas das partes; o Histórico e o Detalhe escolhem a mesma parte principal.
- Os gates de PostgreSQL deixaram de tirar o índice de um pagamento por venda para montar vendas de várias partes: escrevem partes reais, e o sorteio do `periodSummary` inclui vendas de 2 partes.
- A regra "uma venda tem exatamente um pagamento" saiu de [sales.md](../business-rules/sales.md), do [modelo de dados](../architecture/sales-data-model.md) e do plano.

## Alternativas consideradas

- **4 partes no banco.** Proposta da arquitetura; o usuário fixou 3, que cobre os casos do balcão com folga sobre as 2 da tela.
- **Tabela nova de partes e `sale_payments` como cabeçalho do pagamento.** Mexe em todas as leituras e no export de uma vez, sem ganho sobre linhas com posição.
- **Sem `payment_count`, só a soma.** O gatilho não saberia quantas partes a venda devia ter: uma parte a menos ou a mais que, por acaso, deixasse a soma certa passaria. O cabeçalho já declara itens e ajustes pelo mesmo motivo.
- **Comando `sale.confirm` versão 2.** Nenhum campo muda de significado; a regra de compatibilidade dos comandos offline pede crescer o contrato da versão 1.
