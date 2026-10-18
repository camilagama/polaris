---
status: accepted
---

# Free acima do limite: variantes operacionais

## Contexto

O plano (PR82) pede, para quem sai do Pro com mais variantes do que o Free permite, uma seleção de quais **50 variantes continuam operacionais**, o bloqueio de expansão e de rotação indevida, e que nenhuma linha de produto carregue um `plan_locked`. A regra de negócio já dizia que o downgrade preserva dados e histórico e só restringe operações novas (ADR 0058: adições acima do limite são recusadas); faltava decidir **o que o excedente pode fazer**, **quem escolhe o que fica**, **por quanto tempo** e **como impedir a troca de uma variante por outra** para contornar o limite.

## Decisão

- **Operacional é uma escolha guardada à parte, nunca uma propriedade da variante.** A tabela `operational_variant_selections` (organização, produto, variante, episódio) guarda as variantes que ficam operacionais. A variante e o produto não mudam; nada é "travado" nas linhas do catálogo.
- **O que "não operacional" bloqueia:** nova atividade comercial. Uma venda que inclua a variante (a venda toda é recusada, sem escrever nada) e uma entrada de estoque (`receipt`) nela. Continuam permitidos, porque preservam a integridade do histórico: cancelar uma venda antiga e devolver (a reposição da unidade), contagem e baixa de estoque, editar o produto, e reenviar um comando já confirmado (o replay é respondido antes da checagem). A variante segue visível, exportável e com histórico.
- **Quando se aplica:** só no plano Free, só quando a organização tem mais variantes (de produtos não excluídos) do que o limite em vigor, concessões incluídas, **e** o registro está num episódio de saída do Pro (`free_over_limit`, `trial_setup` ou um acesso Pro vencido que a varredura ainda não gravou). Pro, um registro Free comum e uma organização que voltou ao limite (excluindo o que não usa) têm todas as variantes operacionais, e a escolha anterior simplesmente deixa de importar. Para Pro e Free comum a checagem é uma consulta só. A janela entre o fim do acesso Pro e a varredura que atualiza o registro já conta.
- **Limite que encolhe.** A escolha em vigor nunca passa do limite em vigor: se uma concessão que o elevava expira, valem as primeiras escolhidas (as linhas gravam a ordem) e as demais são ignoradas e apagadas na próxima mudança, então a organização nunca fica presa sem poder reenviar a escolha.
- **Três fases** (`packages/domain/src/billing/operational-selection.ts`, puro): `unrestricted`; `adapting`, os 7 dias seguintes ao fim do acesso Pro (`ADAPTATION_DAYS`), em que **tudo continua operacional** e a escolha pode ser substituída à vontade; e `frozen`, depois da janela, em que só a escolha é operacional.
- **Anti-rotação.** Depois da janela a escolha **só cresce**, até o limite: um pedido que deixe de fora uma variante já escolhida é recusado (`selection_frozen`), então "liberar A, vender, travar A, liberar B" não funciona. Uma variante cujo produto foi excluído sai da escolha em silêncio e libera a vaga, o único jeito de entrar outra (exclusão não se desfaz). Para trocar livremente é preciso voltar ao limite real ou assinar o Pro.
- **Quem não escolheu:** ao fim da janela o servidor grava uma escolha padrão, uma vez, sob lock: as variantes vendidas mais recentemente **até o fim da janela**, depois as mais antigas (desempate por ID). Contar só as vendas anteriores ao fim da janela torna o resultado independente de quando ele é calculado e do que se vendeu depois.
- **O início da janela é o fim do acesso Pro.** A coluna `organization_billing.over_limit_since` guarda esse momento: quem escreve o registro (o papel de billing, não o tenant) grava o fim do acesso que venceu (ou agora, se o acesso foi retirado antes do fim), **mantém** o valor enquanto a organização continua acima do limite ou abre um checkout de trial (abrir e abandonar o trial não reinicia a janela) e **limpa** quando o Pro volta. Um acesso vencido que a varredura ainda não gravou é datado pelo mesmo fim de acesso, então a janela é a mesma antes e depois da varredura. **Sem início gravado, a varredura data o registro pelo fim da concessão** (ADR 0067): quando uma concessão temporária de limite (que terminou nos últimos 90 dias, para o limite que está excedido e sem outra em vigor para ele) acaba e a conta Free está acima do limite sem `over_limit_since`, o excesso passa a contar a partir do fim da concessão e a conta entra nas regras do Free acima do limite, com a janela de adequação contada dali. Como o fim pode estar no passado, a janela de sete dias pode já ter terminado quando a varredura grava a data: a conta nasce na fase `frozen` e o padrão da escolha conta as vendas até o fim dessa janela. Até a varredura gravar a data, e para um registro sem início que nenhuma concessão elegível date, não há janela a provar: a fase é `frozen` (nunca a de janela aberta) e abrir um checkout de trial nesse registro não lhe dá janela nova (o valor ausente é mantido como ausente). Quem abandona o checkout volta a `free_over_limit` (o limite é recalculado em todo estado, não só nos de Pro) com o mesmo início e a mesma escolha.
- **Episódios.** Cada linha da escolha leva o início do episódio a que pertence; linhas de um episódio anterior (a organização teve Pro de novo e saiu outra vez) são ignoradas e substituídas.
- **Aplicação onde se escreve.** `assertVariantsOperational` roda dentro da transação da venda (`confirmSale`, depois de a venda ser conhecida como nova e do lock do catálogo) e da entrada de estoque, então RPC, comando offline e qualquer caminho futuro passam pela mesma checagem. Para Pro é uma consulta só. No comando offline a recusa é a mesma "mudança de plano" (`entitlement_changed`): não é guardada, o mesmo comando pode ser reenviado e o trabalho do aparelho nunca se perde.
- **API.** `plan.operationalSelection` (onde a organização está, a janela e o que escolheu) e `plan.selectOperationalVariants` (a escolha completa), ambas com a capacidade de gerenciar produtos. Recusas chegam como conflito com o motivo (`nothing_to_select`, `selection_too_large`, `selection_frozen`, `variant_unavailable`) e a venda ou entrada recusada como `entitlement_variant_locked`. O contrato só cresce.

## Consequências

- Um Free acima do limite continua vendendo as variantes que escolheu (ou as que mais vendia, por padrão) e não perde nada; o excedente fica visível, com histórico e correções.
- Quem quiser vender uma variante excluída da escolha tem três caminhos: voltar ao limite (excluir o que não usa), assinar o Pro, ou, dentro dos 7 dias, trocar a escolha.
- Cada venda e cada entrada de estoque de uma organização fora do Pro lê o plano, conta variantes e, congelada, lê a escolha: poucas consultas indexadas por organização, só para quem não é Pro.
- A **tela** de escolha e o convite ao Pro entram com a experiência de plano (PR80); este PR entrega a regra, o servidor e o contrato.
- Efeitos do downgrade sobre catálogo público, lease offline, imagens e metas são o PR83.

## Limites aceitos

- Um registro Free comum acima do limite (uma concessão que expirou sem que nada o levasse a `free_over_limit`) não é restringido até que algo o coloque num episódio; o ciclo de vida das concessões ([ADR 0067](0067-concessoes-temporarias-de-entitlement.md)) faz essa passagem, datada pelo fim da concessão. Hoje ele não pode acrescentar nada (ADR 0058), apenas segue vendendo o que já tem.
- A escolha padrão é gravada na primeira vez que alguma operação precisa dela; se essa operação for recusada, a transação desfaz a gravação e a próxima tenta de novo (o resultado é o mesmo, porque conta só vendas até o fim da janela, e a leitura pela API grava de forma definitiva). A leitura `plan.operationalSelection` pode, portanto, escrever; um roteamento somente leitura precisaria tratá-la como escrita.
- A regra "depois da janela a escolha só cresce" vive no comando, não em gatilho do banco: o papel do tenant tem INSERT e DELETE na tabela, e só os caminhos do repositório a alteram.
- Um acesso `active` vencido que a varredura leva à carência (`grace`) restaura o Pro e um novo episódio começa no fim da carência: a escolha anterior é substituída. O padrão conta vendas confirmadas, inclusive as canceladas depois.

## Alternativas rejeitadas

- **`plan_locked` na variante ou no produto:** o plano proíbe e deixaria o catálogo com estado comercial intrínseco; a escolha vive à parte e some quando deixa de valer.
- **Escolha sempre livre:** a rotação (liberar, vender, travar, liberar outra) daria acesso a todo o catálogo com o plano Free.
- **Escolha padrão calculada a cada leitura:** variaria com as vendas e com a hora; gravá-la uma vez sob lock, ranqueada até o fim da janela, é estável e auditável.
- **Contar a janela a partir do momento em que a varredura roda:** a janela dependeria do cron; ela é datada pelo fim do acesso.
- **Bloquear também baixa, contagem e cancelamento:** impediria corrigir o histórico e o estoque de quem já está restrito.
