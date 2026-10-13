---
status: accepted
---

# Contagem física e valoração do estoque

`inventoryCount` recebe a quantidade física absoluta e a versão do saldo lida pelo cliente; o servidor confere a versão sob lock, grava o delta e a quantidade contada no ledger e atualiza saldo e auditoria na mesma transação. Mesmo sem diferença, a contagem é um evento com delta zero e avança a versão para invalidar leituras concorrentes antigas; replay compara quantidade, versão e entrada de valoração originais e devolve o saldo atual. O input de valoração fica persistido separadamente do snapshot `unitCost`, para que replay diferencie “sem valoração explícita” de um valor informado.

Uma contagem preserva o custo médio conhecido e o registra como snapshot. Se o custo é desconhecido, a contagem pode corrigir quantidade sem presumir custo zero; um `valuationUnitCost` opcional pode estabelecer a média somente quando ainda desconhecida e a quantidade física é positiva. Sem esse valor explícito, o custo permanece nulo, e `receiveStock` continua bloqueado enquanto houver saldo positivo sem custo; resolver essa valoração por comando próprio fica fora do PR31.
