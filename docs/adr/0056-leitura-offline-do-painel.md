---
status: accepted
---

# Leitura offline do painel

## Contexto

O plano (PR71) pede que o painel de resultado persista o último retrato confirmado, mostre "Atualizado até..." e nunca trate o trabalho pendente do aparelho como resultado oficial. O resultado de um período é calculado pelo servidor sobre registros confirmados (ADR 0053 e 0054); o aparelho sem rede só pode mostrar o que já viu.

## Decisão

- **O aparelho guarda o último resumo confirmado de cada mês, e só isso.** Depois de cada leitura bem-sucedida do servidor, com o runtime offline ligado, o navegador guarda o resumo do mês (cartões, cadeia e qualidade, como o servidor os devolveu) com o horário do servidor em que foram lidos (`generatedAt`, "atualizado até"). São no máximo seis meses por organização (os mais antigos saem primeiro), validados pela forma esperada na leitura (o que não confere é descartado) e apagados junto com a sessão, como a cópia das organizações e dos perfis de pagamento ([ADR 0047](0047-abrir-o-app-sem-rede.md), [0049](0049-perfil-de-pagamento-na-venda-sem-conexao.md)): ao sair, ao receber "não autenticado" e nunca gravados depois de a saída começar.
- **A cópia só substitui o servidor quando o servidor não pôde responder.** Falha de rede ou indisponibilidade do servidor mostra a cópia do mês pedido, se existir; uma recusa do servidor (sessão encerrada, sem permissão, pedido inválido) nunca cai na cópia, porque o servidor disse algo e a cópia não pode contradizê-lo. Nunca se mostra a cópia de outro mês nem de outra organização. Sem cópia, vale o estado de erro de sempre.
- **O número offline é o confirmado, dito como tal.** A tela avisa "Sem conexão. Mostrando o último resultado confirmado, de dd/mm/aaaa às HH:mm" e que vendas e despesas feitas depois, ou ainda não enviadas deste aparelho, não estão nestes números. Com o runtime ligado e operações guardadas no aparelho, diz quantas ainda não entram no resultado. **Trabalho pendente nunca é somado nem misturado ao resultado**: ele só existe como aviso. Com conexão, a tela mostra "Atualizado até" com o horário do servidor da última leitura.
- **A cópia mantém o que o servidor disse sobre qualidade.** Aviso de qualidade, etiqueta de estimativa e frases saem do próprio resumo guardado; offline não se calcula nada novo.
- **Metas continuam só com conexão.** O servidor liquida metas ao lê-las e a leitura offline de um estado que o servidor ainda pode mudar seria enganosa; o painel de metas mostra seu erro normal sem rede.
- **O contrato só cresce:** o resumo ganhou `generatedAt`, informado pelo relógio do servidor (o do aparelho não decide nada sobre o "atualizado até"). O servidor sobe antes do app (ADR 0042).
- **Atrás da chave de build** `VITE_OFFLINE_RUNTIME_ENABLED` (desligada por padrão): sem ela nada é guardado nem lido e a tela é a de antes.

## Consequências

- Quem abre o painel sem rede vê o último resultado conhecido do mês, com a idade dele à vista; um mês nunca aberto com rede continua sem número.
- O que está na cópia pode envelhecer (uma devolução feita em outro aparelho depois); o horário mostrado é a defesa, não uma garantia de frescor.
- Dados de resultado (vendas, margem, despesas) ficam no navegador, como a lista de clientes e de produtos já ficam nas coleções locais; saem com a sessão.

## Alternativas rejeitadas

- **Calcular o resultado no aparelho com os dados locais:** o aparelho não tem o custo médio (ADR 0031) nem todas as vendas, e misturaria trabalho pendente ao oficial.
- **Guardar também as metas:** o estado delas pode ser liquidado pelo servidor na próxima leitura.
- **Cair na cópia em qualquer erro:** esconderia uma recusa do servidor atrás de um número velho.
- **Usar o relógio do aparelho para "atualizado até":** um relógio errado faria um número velho parecer novo.
