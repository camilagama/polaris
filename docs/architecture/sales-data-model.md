# Modelo de dados e fluxos de venda

Este documento é a fonte de verdade para **como** a venda, o cancelamento, a devolução, a atribuição de cliente, as datas, os locks e os triggers são organizados em tabelas e transações. As regras de negócio (o que é válido) estão em [vendas](../business-rules/sales.md), [estoque](../business-rules/inventory.md), [dinheiro](../business-rules/money.md) e [tempo e datas](../business-rules/time-and-dates.md); as razões das escolhas, nos [ADR 0019](../adr/0019-venda-atomica-por-constraint-triggers-deferidos.md), [0020](../adr/0020-cancelamento-e-devolucao-compensatorios.md) e [0021](../adr/0021-datas-da-venda-e-janela-retroativa.md). A visão geral do sistema está em [overview.md](overview.md).

## Princípios

- **Snapshot imutável.** A venda confirmada e tudo que ela contém nunca são editados. Correções são registros novos (compensatórios) que apontam para a venda.
- **Uma transação por comando.** Cada comando de venda (confirmar, cancelar, devolver, atribuir cliente) é uma transação tenant que grava todos os efeitos juntos, com a auditoria, ou nenhum.
- **O banco repete as regras críticas.** O runtime recebe `INSERT` e `SELECT` nas tabelas de venda e nenhum `UPDATE`, `DELETE` ou `TRUNCATE`; triggers de restrição deferidos recusam no commit qualquer estado incompleto.
- **Servidor como autoridade.** Organização e usuário vêm da transação tenant autorizada. Produto, rótulo do produto e custo do item são lidos pelo servidor sob lock, nunca informados pelo cliente.

## Tabelas

| Tabela | Papel |
| --- | --- |
| `sales` | Cabeçalho da venda confirmada: identificador, `command_id` (único por organização), contagem de itens e de ajustes, moeda e as quatro datas. |
| `sale_items` | Um item por linha: variante, produto, rótulo do produto, posição, quantidade, preço de tabela, preço cobrado e custo unitário do snapshot (nulo quando desconhecido). |
| `sale_adjustments` | Descontos, acréscimos, frete e sobretaxa de pagamento, fixos ou percentuais, com posição. |
| `sale_payments` | Exatamente um pagamento por venda: método, parcelas e modalidade, e o snapshot do perfil de pagamento (perfil, versão, regra, componentes e valores das taxas, prazo esperado e intenção de antecipação). |
| `sale_customer_links` | Histórico versionado e somente de acréscimo da atribuição de cliente (`assign`, `reassign`, `unassign`); a atribuição atual é a versão mais alta. |
| `sale_cancellations` | Registro do cancelamento total: motivo estruturado opcional, usuário e instante do servidor. |
| `sale_returns` e `sale_return_items` | Registro de cada devolução e suas linhas, com quantidade devolvida e quantidade reposta separadas. |
| `stock_movements` | Ledger de estoque append-only; as vendas e suas compensações aparecem como movimentos de tipo `sale`, `sale_cancellation` e `sale_return`, identificados por comando e posição. |
| `inventory_balances` | Saldo e custo médio por variante e organização, atualizados junto com o movimento correspondente. |
| `tenant_audit_event` | Auditoria transacional, apenas de inserção (imutável por gatilho), com códigos limitados, classe do evento (`security` ou `operational`) e identificador opaco da entidade; sobrevive ao purge da organização e sai só por prazo (ADR 0081, emenda de 19/10/2026). |

Todas as tabelas de domínio têm `FORCE ROW LEVEL SECURITY` com policy por organização, e as chaves estrangeiras são compostas com a organização.

## Datas da venda

A venda guarda quatro datas com papéis distintos. As regras de janela e de tolerância estão em [tempo e datas](../business-rules/time-and-dates.md).

| Coluna | Significado | Quem define |
| --- | --- | --- |
| `occurred_at` | Momento comercial da venda. | Operador, no comando. |
| `occurred_on` | Data comercial no calendário da organização; é a data dos movimentos de estoque da venda. | Servidor, a partir de `occurred_at` e do fuso da organização lido dentro da transação tenant. |
| `recorded_at` | Evidência do dispositivo na criação; não decide nenhuma regra. | Dispositivo, opcional. |
| `confirmed_at` | Confirmação oficial. | Servidor, `clock_timestamp()`. |

`occurred_on` é uma coluna `date`; os demais são instantes, gravados e lidos em UTC ([ADR 0024](../adr/0024-colunas-de-instante-timestamptz.md)). O trigger de completude da venda exige que todo movimento `sale` tenha `occurred_on` igual ao da venda.

## Fluxos

### Confirmar a venda

1. O comando `sale.confirm` chega com `commandId`, itens (variante, quantidade, preço de tabela, preço cobrado), ajustes, pagamento, perfil de pagamento explícito e datas.
2. Dentro da transação tenant, o servidor procura o `commandId`; se já existe, devolve a venda com `replayed: true` sem novos efeitos e sem checar a janela retroativa.
3. Valida produto vendável, calcula `occurred_on` e aplica a janela e a tolerância de futuro.
4. Bloqueia, em ordem estável de produto e depois de saldo, as linhas necessárias, captura o custo médio de cada item (nulo quando desconhecido) e baixa o saldo sem permitir negativo.
5. Grava cabeçalho, itens, ajustes, pagamento, movimentos `sale`, saldos e a auditoria.
6. No commit, `check_sale_confirmation_complete` recusa a venda sem os itens e ajustes declarados, sem exatamente um pagamento igual ao total devido, sem o movimento correspondente a cada item, com movimento em data diferente da comercial, ou movimento `sale` sem venda.

### Cancelar a venda (total)

1. A transação bloqueia a venda para compensação (ver Locks) e confere que ela não foi cancelada nem tem devoluções.
2. Grava `sale_cancellations` e, por item, um movimento `sale_cancellation` com a quantidade de volta ao saldo, valorada pelo custo do snapshot do item. O custo médio segue a regra de reposição de [estoque](../business-rules/inventory.md).
3. Atualiza saldos e grava a auditoria. Para itens de produto removido não há movimento (decidido na revisão do checkpoint Gate 4, 13/10/2026; ver o ADR 0020), e a compensação continua registrada e auditada.
4. `check_sale_cancellation_complete` recusa no commit o cancelamento sem os movimentos inversos esperados, com o `command_id` da venda ou em venda com devoluções.

### Devolver parte da venda

1. A transação bloqueia a venda para compensação e valida, por linha, `devolvida <= disponível` e `reposta <= devolvida`, sem item repetido na mesma devolução.
2. Grava `sale_returns` e `sale_return_items` e, só para as unidades repostas, movimentos `sale_return` ao custo do snapshot do item, com a mesma regra de média do cancelamento.
3. `check_sale_return_complete` recusa no commit a devolução sem linhas, acima do vendido, sem os movimentos exatos das unidades repostas, em venda cancelada ou com o `command_id` da venda.
4. A devolução não carrega valor monetário nesta fase.

### Atribuir cliente

`sale.assignCustomer`, `reassignCustomer` e `unassignCustomer` acrescentam uma versão em `sale_customer_links`, com `expectedVersion`, na mesma transação da auditoria. Elas nunca tocam as tabelas econômicas. `guard_sale_customer_link_transition` impõe a sequência de versões, as transições válidas e o cliente ativo da mesma organização.

## Locks e ordem

- **Confirmação:** produtos em ordem estável de identificador, depois linhas de saldo, para que vendas concorrentes que listam produtos em ordens opostas não gerem deadlock.
- **Compensações:** cancelamento e devolução da mesma venda serializam por um lock consultivo de transação (`lockSaleForCompensation`), chaveado pelo identificador da venda, de modo que vendas diferentes não esperam uma pela outra. Os triggers do banco usam a mesma chave, então escritores diretos também serializam.
- **Ordem do ledger por variante:** a ordem de confirmação dos movimentos de uma variante deve ser dada por uma sequência por variante gravada sob o lock do saldo (decidido na revisão do checkpoint Gate 4), e não pelo horário de início da transação.
- A revisão do checkpoint Gate 4 não encontrou ciclo possível entre venda, cancelamento, devolução e recebimento, porque a ordem de aquisição é consistente (produto antes de saldo; lock consultivo por venda nas compensações).

## Idempotência

Todos os comandos de venda têm `commandId` único por organização. Repetir o mesmo conteúdo devolve o registro existente (`replayed: true`); conteúdo diferente com o mesmo `commandId` é conflito; o `commandId` de cancelamento ou devolução não pode ser o da venda, porque os movimentos são identificados por comando e posição.

## Limites conhecidos

- Não há outbox transacional no servidor nesta etapa; ele pertence à Fase 11 do plano.
- A leitura de vendas faz várias consultas em `READ COMMITTED` e pagina por deslocamento, de modo que a paginação pode repetir ou pular linhas sob concorrência.
- A venda retroativa usa o custo médio e o estoque vigentes na confirmação ([ADR 0021](../adr/0021-datas-da-venda-e-janela-retroativa.md)).
- Reconciliação entre ledger e saldo no nível do banco (trigger deferido) é decisão da revisão do checkpoint Gate 4, ainda sem verificação no código.
