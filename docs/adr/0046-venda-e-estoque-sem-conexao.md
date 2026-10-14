---
status: accepted
---

# Venda e estoque sem conexão: o servidor quando alcançável, o aparelho quando não

## Contexto

O ADR 0045 converteu clientes e produtos, que podem sempre ler do aparelho porque a cópia local é sincronizada. Venda e estoque são diferentes: movem dinheiro e saldo, e a confirmação pelo servidor traz coisas que o aparelho não tem (perfil de pagamento com taxas e prazo, data retroativa dentro da janela, custo médio). A tela da venda é a razão de ser da Fase 5; sem rede ela precisa funcionar, mas sem piorar quem tem rede.

## Decisão

- **Política única para as duas telas:** com o servidor alcançável (o runtime está online) tudo continua como antes, falando com o servidor, que confirma a venda e o movimento na hora e responde com saldo e custo. Só **sem conexão** (e com o runtime pronto e a cópia completa) a tela passa a trabalhar do aparelho. Isso não é o mesmo que clientes e produtos, que leem do aparelho sempre; aqui o motivo é que a confirmação imediata e o custo valem mais do que a simetria.
- **Venda sem conexão** (`sales/queue-offline-sale.ts`, `confirm-outcome.ts`): é o mesmo formulário, com a busca de variantes e os saldos vindos das coleções locais com a fila aplicada (`offline/local-stock-entries.ts`, que também serve ao estoque). O pedido validado é o mesmo que iria ao servidor: vira UM comando `sale.confirm` com o ID e o instante da tentativa, então repetir a mesma venda guarda uma só. Sem rede não existem perfis de pagamento (a venda vai sem perfil: taxas e prazo ficam desconhecidos, nunca zero) nem data digitada (a venda é de agora); a tela diz isso. O preço de tabela digitado vale (o comando passou a aceitar `listedUnitPrice`). Depois de guardar, a tela diz "Venda guardada neste aparelho", que **ainda não é uma venda confirmada**, mostra o total e avisa quando o estoque do aparelho parece não cobrir; uma lista mostra as vendas guardadas e seu estado, com link para Pendências quando o servidor recusa. O estoque que o aparelho mostra já desconta o que está na fila.
- **Uma venda de resultado desconhecido nunca vai para o aparelho.** Se o envio ao servidor falhou sem resposta (a tela fica travada na mesma tentativa), perder a rede não muda o modo da tela: ela só reenvia a mesma venda, sem alterar nada, ao servidor. Mover para o aparelho com outro conteúdo poderia registrar a venda duas vezes. A saída é a mesma de antes (reenviar com segurança ou descartar em duas etapas).
- **Estoque sem conexão** (`inventory/queue-offline-stock.ts`): a lista vem do aparelho (busca, filtros e arquivados como no servidor, sem páginas) e receber, contar e baixar entram na fila com o ID da chamada. A resposta é o saldo do aparelho (o do servidor mais a fila), e a mensagem diz que só vale quando o servidor confirmar. O **custo médio continua fora do aparelho** (ADR 0031): a coluna diz "Com conexão", a tela não bloqueia nem pede custo por causa dele e não oferece valoração. Uma baixa maior que o saldo do aparelho é recusada pelo próprio formulário, como online; a contagem leva a versão do saldo que o aparelho mostra como `baseVersion`.
- **Risco aceito, com a razão:** um recebimento feito sem rede sobre um saldo com estoque e custo desconhecido (herança de recebimentos antigos sem custo) é recusado pelo servidor ao sincronizar (`inventory_cost_unavailable`) e fica em Pendências; a correção é descartar e fazer, com conexão, uma contagem com valoração. Levar o custo ao aparelho para evitar isso desfaria a decisão do ADR 0031 (o custo é dado sensível e a cópia local vai a aparelhos pessoais); o caso é raro e visível, o custo seria permanente.
- **Fora desta etapa, de propósito:** histórico, detalhe, cancelamento, devolução e vínculo de cliente da venda continuam online; perfis de pagamento e data retroativa offline; edição offline em qualquer tela. Um possível "guardar neste aparelho" quando a rede existe mas o servidor não responde (o navegador diz online, o envio falha) fica para depois: exige provar que o mesmo ID de comando é seguro pelos dois caminhos, o direto e o da fila.
- **Provas:** testes de unidade (junção e filtros locais com a fila aplicada, o comando de venda a partir do pedido validado e a repetição sem duplicar, o formulário offline e a volta, o alvo sem custo e o texto do resultado) e cenários de navegador sobre `/offline-screens-lab` com a tela real: vender sem rede e ver o estoque do aparelho descer, servidor confirma ao voltar; venda que o estoque do aparelho não cobre é guardada com aviso e a recusa do servidor fica à vista; com rede o botão é o de confirmar no servidor; receber sem rede, saldo do aparelho e execução no servidor ao voltar; baixa maior que o saldo recusada pelo formulário.

## Consequências

- Com a chave ligada, quem vende sem rede passa a ter vendas pendentes que não são oficiais até o servidor aceitar; Pendências é o lugar de corrigir o que for recusado. A venda guardada sem perfil de pagamento tem taxas e prazo desconhecidos no relatório, igual à venda online "sem perfil".
- O checklist em aparelho físico ganha o ciclo completo: vender e receber sem rede, ver o estoque do aparelho, religar e conferir o servidor.

## Alternativas rejeitadas

- **Levar o custo médio ao aparelho:** contradiz o ADR 0031 e amplia a cópia local de dado sensível por um caso raro.
- **Sempre vender pela fila, mesmo com rede:** o cliente sairia do balcão antes de o servidor confirmar o que ele pode confirmar na hora (estoque, perfil, data); só vale quando não há alternativa.
- **Trocar o formulário de venda por uma versão própria para o offline:** duplicaria validação e totais de uma tela de 1.400 linhas; reaproveitar o formulário (com busca e saldos locais) mantém uma única regra de cálculo.
