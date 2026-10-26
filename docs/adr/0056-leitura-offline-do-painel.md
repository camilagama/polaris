---
status: accepted
---

# Leitura offline do painel

## Contexto

O plano (PR71) pede que o painel de resultado persista o último retrato confirmado, mostre "Atualizado até..." e nunca trate o trabalho pendente do aparelho como resultado oficial. O resultado de um período é calculado pelo servidor sobre registros confirmados (ADR 0053 e 0054); o aparelho sem rede só pode mostrar o que já viu.

## Decisão

- **O aparelho guarda o último resumo confirmado de cada mês, e só isso.** Depois de cada leitura bem-sucedida do servidor, com o runtime offline ligado, o navegador guarda o resumo do mês (cartões, cadeia e qualidade, como o servidor os devolveu) com o horário do servidor em que foram lidos (`generatedAt`, "atualizado até"). São no máximo seis meses por organização (os mais antigos saem primeiro), validados pela forma esperada na leitura (o que não confere é descartado) e apagados junto com a sessão, como a cópia das organizações e dos perfis de pagamento ([ADR 0047](0047-abrir-o-app-sem-rede.md), [0049](0049-perfil-de-pagamento-na-venda-sem-conexao.md)): ao sair ("Sair"), ao receber "não autenticado" da leitura das organizações ou do próprio resumo, e nunca gravados depois de a saída começar. Uma resposta que não é um resumo (página de portal cativo, de proxy) é tratada como servidor que não respondeu. Limites aceitos, os mesmos dos perfis de pagamento: uma sessão que expira sem "Sair" deixa a cópia no navegador até o próximo "não autenticado"; a cópia não leva o usuário na chave (o navegador é de uma pessoa só, e só a lê quem estiver na mesma organização); o "Atualizado até" é o horário do servidor tomado antes da leitura, de modo que nada confirmado depois dele é dado como coberto.
- **A cópia só substitui o servidor quando o servidor não pôde responder.** Falha de rede ou indisponibilidade do servidor mostra a cópia do mês pedido, se existir; uma recusa do servidor (sessão encerrada, sem permissão, pedido inválido) nunca cai na cópia, porque o servidor disse algo e a cópia não pode contradizê-lo. Nunca se mostra a cópia de outro mês nem de outra organização. Sem cópia, vale o estado de erro de sempre.
- **O número offline é o confirmado, dito como tal.** A tela avisa "Não foi possível falar com o servidor. Mostrando o último resultado confirmado, de dd/mm/aaaa às HH:mm" (a redação vale tanto para falta de conexão quanto para um servidor fora do ar) e que vendas e despesas feitas depois, ou ainda não enviadas deste aparelho, não estão nestes números. Com o runtime ligado e operações guardadas no aparelho, diz quantas ainda não entram no resultado. **Trabalho pendente nunca é somado nem misturado ao resultado**: ele só existe como aviso. Com conexão, a tela mostra "Atualizado até" com o horário do servidor da última leitura.
- **A cópia mantém o que o servidor disse sobre qualidade.** Aviso de qualidade, etiqueta de estimativa e frases saem do próprio resumo guardado; offline não se calcula nada novo.
- **Metas continuam só com conexão.** O servidor liquida metas ao lê-las e a leitura offline de um estado que o servidor ainda pode mudar seria enganosa; o painel de metas mostra seu erro normal sem rede.
- **O contrato só cresce:** o resumo ganhou `generatedAt`, informado pelo relógio do servidor (o do aparelho não decide nada sobre o "atualizado até"). O servidor sobe antes do app (ADR 0042).
- **Atrás da chave de build** `VITE_OFFLINE_RUNTIME_ENABLED` (desligada por padrão): sem ela nada é guardado nem lido e a tela é a de antes.

## Emenda (23/10/2026): série diária e mais vendidos no resumo (D2)

Registro datado; a decisão acima continua valendo. Pedida pelo desenho do Início (t269, D2 do t267) e aprovada na rodada desenho-t269.

- **O resumo do período passa a trazer a série diária** (`daily`): um item por data comercial do período, em ordem, com as vendas líquidas e o número de vendas daquela data, calculado pelo mesmo motor (ADR 0053) sobre os mesmos fatos e na mesma transação. Data sem venda vale zero, nunca falta. A série soma o período: Σ das vendas líquidas é igual às vendas líquidas do resumo e Σ das vendas é igual ao número de vendas. A devolução reduz a data da venda devolvida e a venda cancelada vale zero na data dela, como no resumo.
- **Os mais vendidos entram só quando pedidos** (`topProducts`, de 1 a 10 na entrada): por unidades líquidas de devolução, depois por vendas líquidas e por fim pelo ID do produto; quem foi devolvido inteiro fica de fora. Vêm com o nome atual do produto e dizem se ele foi excluído. Um ranking num RPC próprio leria os fatos do período de novo; por isso ele vive no resumo, e quem não pede não paga.
- **A cópia guardada é o resumo como o servidor o devolveu**, agora com a série e, se pedido, o ranking. A leitura da cópia valida `daily` e `topProducts` **quando existem**: uma cópia gravada antes da série continua válida (a tela só não desenha a série daquele mês) e uma série malformada (fora de ordem, com dia faltando ou sobrando) descarta a cópia inteira.
- O contrato só cresce: o servidor sempre manda `daily`; o app novo aceita a cópia antiga sem ela.

## Emenda (24/10/2026): a cópia do Início e a meta mostrada (ii)

Registro datado; a decisão acima continua valendo, menos o item "Metas continuam só com conexão" no Início, que esta emenda troca. Pedida pelo desenho do Início (t269 v2, § 7) e aceita com a condição do Filipe.

- **O Início guarda a sua cópia** sob `polaris.offline.home.<org>`: o resumo dos dias antes do mês (B), a meta que o cartão mostrou (como o servidor a devolveu) e a marca de que a loja já vendeu. O mês (A) fica na chave do resumo que já existe; o Resultado passa a pedir os mesmos três mais vendidos, para as duas telas gravarem o mesmo formato. Tudo validado pela forma na leitura (o que não confere vale "sem números"), com as mesmas condições da cópia do resumo: só com o runtime offline ligado, só para quem lê o resultado, nunca gravada depois de a saída começar nem depois de a sessão ser recusada nesta página, e apagada junto com ela (`clearPeriodSummaryCaches` apaga também o prefixo do Início, em "Sair", no "não autenticado" e na limpeza da saída).
- **Só é lida com o acesso sem internet do usuário em vigor** (o runtime pronto com o lease dele) e só quando falta a conexão: uma leitura que fica sem resposta e cuja sonda também não acha o Worker é falta de conexão; um servidor que respondeu, mesmo com erro, nunca cai na cópia.
- **A meta mostrada no Início é guardada como foi lida**, com o mesmo "Último resultado confirmado". Ela só aparece "em andamento" enquanto hoje, no fuso da loja, está dentro do período guardado; passado o fim, a tela diz "Esta meta terminou. O resultado sai com conexão.", sem percentual, porque a liquidação é do servidor. A meta pausada pelo plano aparece como foi lida. A tela de metas do Resultado continua só com conexão.
- **Idade:** passadas 24 h do horário do servidor da leitura, a tela diz que os números podem estar desatualizados, sem escondê-los; o "Hoje" da cópia só vale no mesmo dia da loja da leitura. Um relógio do aparelho anterior à leitura conta como errado: a cópia não é de hoje e leva o aviso de idade.

## Emenda (24/10/2026): custo e resultado por dia no resumo (Resultado v2)

Registro datado; a decisão acima e a emenda D2 continuam valendo. Pedida pelo corte resultado-v2 (Q-4, AC-8 a AC-10) e respondida na rodada de 24/10 (Filipe e Petković).

- **Cada item de `daily` ganha `costs` e `operatingResult`**, em BRL exato, ou `null`, e `operatingExpenses`, em BRL exato, nunca `null`. O custo do dia é a soma das partes: custo das mercadorias, taxa de processamento, taxa de antecipação, despesas ligadas às vendas da data e despesas sem venda cuja `competence_on` é o dia (uma data, sem rateio). Acréscimo, frete e acréscimo de pagamento não reduzem o custo (ficam no resultado), então ele nunca é negativo. `operatingResult` é o resultado estimado do dia, calculado no servidor. `operatingExpenses` é a parte do custo sem venda (as despesas sem venda cuja `competence_on` é o dia): `"0.00"` no dia sem despesa e preenchida também quando `costs` é `null`, porque não depende de nenhuma venda; no dia sem venda é igual a `costs`.
- **`null` nos dois campos quando alguma venda da data tem custo, taxa de processamento ou taxa de antecipação desconhecidos.** Sem `costsComplete`: um número parcial ao lado de uma flag deixaria quem a esquece somar um parcial como total, o zero fabricado que o ADR 0053 proíbe.
- **O servidor devolve todas as datas de `from` a `to`**, também as depois de hoje: a despesa com competência futura fica no dia dela. Quem corta no "hoje" é o cliente.
- **A soma fecha com a cadeia:** quando nenhum dia é `null`, Σ `costs` é igual a custo das mercadorias, taxas, despesas ligadas e despesas sem venda do mesmo resumo, e Σ `operatingResult` é igual a `estimatedOperatingResult`; Σ `operatingExpenses` é igual às despesas sem venda do mesmo resumo, também com dia `null`. O dia é igual ao resumo de `from = to = dia`.
- **O contrato recusa período acima de 366 dias** (o repositório já recusava).
- **A cópia guardada** aceita `costs` e `operatingResult` ausentes (cópia antiga: a tela não desenha custos), `null` ou dinheiro, e `operatingExpenses` ausente ou dinheiro (nunca `null`), e descarta a cópia com qualquer outro valor. O contrato só cresce; o cliente antigo ignora os campos.

## Emenda (26/10/2026): a cópia do mapa do Início (t394)

Registro datado; a emenda (ii) continua valendo. Pedida pelo desenho do `report.dailySales` (Filipe, 25/10, item 6) com a condição do Rodrigo na revisão do PR 335 (656-1).

- **O mapa "Ritmo de vendas" guarda a sua série** sob `polaris.offline.dailySales.<org>`: o que o `report.dailySales` devolveu (a primeira data e os dois arrays, uns 3 KB), sem nada calculado no aparelho. Os dias do mês vêm da cópia do mês (A), como na tela com conexão; o mapa só é desenhado com todos os dias das 26 semanas conhecidos, nunca com zero no lugar do desconhecido.
- **As mesmas regras de vida da cópia do Início:** no disco, só com o runtime offline ligado (a memória da página, abaixo, é a exceção) e para quem lê o resultado; gravada só depois da resposta, com a guarda perguntada nesse momento, então uma leitura em voo não grava depois de `isSigningOut` nem depois de a sessão acabar; apagada em "Sair", no "não autenticado" e na limpeza da saída (`clearPeriodSummaryCaches`) e na recusa da loja (`clearOrganizationResultCopies`).
- **Sem a cópia**, sem conexão, o bloco diz "O mapa abre com internet."; com ela, o mapa vale com a mesma linha "Último resultado confirmado" do resto do Início.
- **A cópia é também o cache diário do mapa** (Filipe, CPU-1e, 26/10, item 3): ela guarda o dia da loja em que foi lida (`readOn`), e o Início só chama o `report.dailySales` quando a cópia não é de hoje (ou é de outro período, como na virada do mês) ou no gesto "Tentar novamente" do bloco. Abrir de novo, voltar à aba e a rede voltar no mesmo dia usam a cópia: uma chamada por aparelho por dia. O custo é que uma devolução feita hoje de venda de mês anterior só aparece no mapa no dia seguinte; o resumo do mapa diz "Meses anteriores atualizados até ontem.". Cópia sem `readOn` (da primeira versão) ainda serve sem rede, mas com rede é lida de novo.
- **Com o runtime offline desligado** (a produção hoje), nada vai ao disco: a série e o dia da leitura ficam só na memória da página (`dailySalesMemory`), apagados nas mesmas purgas e perdidos ao sair da página. Voltar ao Início depois de uma venda, voltar à aba e a rede voltar não leem de novo; recarregar a página ou abrir outra aba lê uma vez. Duas leituras que começam juntas (duas abas abertas ao mesmo tempo) podem chamar as duas: o cache é de conferir e depois ler, sem trava.
- **O cache só é servido depois de uma leitura nova dos números do mês** (`report.periodSummary`) na mesma carga, que pede a mesma capability (`report:read`) do `dailySales`: quem perdeu o acesso recebe a recusa nos números, e a recusa apaga a série (disco e memória) antes de qualquer mapa. Se o `dailySales` passar a pedir outra capability, o cache precisa perguntar por ela.

## Consequências

- Quem abre o painel sem rede vê o último resultado conhecido do mês, com a idade dele à vista; um mês nunca aberto com rede continua sem número.
- O que está na cópia pode envelhecer (uma devolução feita em outro aparelho depois); o horário mostrado é a defesa, não uma garantia de frescor.
- Dados de resultado (vendas, margem, despesas) ficam no navegador, como a lista de clientes e de produtos já ficam nas coleções locais; saem com a sessão.

## Alternativas rejeitadas

- **Calcular o resultado no aparelho com os dados locais:** o aparelho não tem o custo médio (ADR 0031) nem todas as vendas, e misturaria trabalho pendente ao oficial.
- **Guardar também as metas:** o estado delas pode ser liquidado pelo servidor na próxima leitura.
- **Cair na cópia em qualquer erro:** esconderia uma recusa do servidor atrás de um número velho.
- **Usar o relógio do aparelho para "atualizado até":** um relógio errado faria um número velho parecer novo.
