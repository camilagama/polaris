# Início

O Início (`/`) é a primeira tela depois de entrar: a data de hoje, o atalho "Nova venda" e blocos com os números da loja (vendas de hoje e do mês, resultado estimado, ticket médio, meta, o que precisa de ação, vendas por dia). Numa loja sem produto, mostra "Primeiros passos" no lugar dos números.

## Sub-features

- `inicio-abrir` abre o Início com o `h1` "Início" e a data de hoje.
- `inicio-primeiros-passos` loja nova: a lista "Primeiros passos" com os atalhos para cadastrar e importar produto.
- `inicio-numeros` loja com vendas: as regiões "Vendas hoje", "Vendas em outubro" (o mês corrente, com o período dito uma vez na linha "Outubro · 1 a 23/10"), "Resultado estimado" e "Ticket médio", cada uma com o seu (i).
- `inicio-atencao` a região "Precisa de ação", logo abaixo de "Nova venda" (sem item, ela não aparece).
- `inicio-meta` a região "Meta" e o link "Definir meta". Com a meta de um mês que já acabou ainda dentro dos 7 dias de exibição (o Início de 2 de novembro com a de outubro liquidada), o título é "Meta de novembro", com "Sem meta ainda", o link e a linha "Outubro: R$ X de R$ Y (não atingida)"; a loja `vendas` não tem esse estado (não há meta de mês anterior).
- `inicio-grafico` "Vendas por dia" com as abas "7 dias" e "30 dias".
- `inicio-ritmo` a região "Ritmo de vendas": o mapa de quadrados de 12 px (um por dia, tantas semanas quanto cabem, de 13 a 26), a frase fixa sob ele, a legenda "Menos" a "Mais" e o tooltip do dia ("Vendido" e "Vendas"), que abre com o mouse, o toque ou o foco do `slider` "Dia do mapa de vendas"; não há gráfico de média por dia da semana. Seletor do tooltip: `[data-heatmap-tooltip]`; dos quadrados: `[data-heatmap] rect.visx-heatmap-rect:not([pointer-events="none"])`. Com a loja `vendas` a frase é a de poucas semanas de venda.
- `inicio-esconder` o botão "Esconder valores".
- `inicio-atualizar` o botão "Atualizar" (só o ícone no celular) relê todos os blocos, as duas janelas dos números incluídas; só com internet.
- `inicio-nova-venda` o link "Nova venda" leva a `/sales`.
- Linha da loja encerrada: com loja ativa e uma encerrada já vista neste navegador, "Você também tem uma loja encerrada: {nome}." com o link "Ver" sob o cabeçalho; `/?reaberta=1` mostra uma vez "Loja reaberta. Você já pode usar o Polaris." (`role=status`) e tira a marca do endereço.

## How to get to it (user POV)

- Entrar no app: a raiz `/` abre o Início.
- Desktop: link `Início` do menu "Principal" ou o link `Polaris` do topo.
- Celular: link `Início` da barra "Destinos".

## Driving it with verify.sh (Playwright)

Preconditions:

- Doctor OK. Loja `vazia` para os primeiros passos; `$V seed vendas` e `VERIFY_LOJA=vendas` para os números.

- **Abrir.** `await page.goto("/")`. Aparece `getByRole("heading", { level: 1, name: "Início" })` e um parágrafo com a data ("Quarta-feira, 28 de outubro · atualizado às 09:12"). Provado no `snap` e em `produtos-criar.verify.ts`.
- **Primeiros passos (loja vazia).** `getByRole("region", { name: "Primeiros passos" })` lista "Loja criada (feito)", "Cadastrar o 1º produto" com os links "Cadastrar à mão" (`/products?novo=1`) e "Importar planilha" (`/products?importar=1`), e "Fazer a 1ª venda". Visto no `snap` da loja `vazia`.
- **Números (loja vendas).** `getByRole("region", { name: "Vendas hoje" })` mostra um valor em reais e "2 vendas" logo depois da semeadura; `region "Vendas em <mês>"` (o mês corrente) conta as vendas semeadas que caem no mês: as 8 a partir do dia 7; nos primeiros dias do mês, só as do mês. Visto no passeio da loja `vendas`.
- **Meta.** Na região "Meta", o link "Definir meta" leva a `/dashboard?meta=nova` (abre a aba Metas do Resultado).
- **Gráfico.** `getByRole("tablist", { name: "Período do gráfico" })` com `tab "7 dias"` (selecionada) e `tab "30 dias"`.
- **Nova venda.** `getByRole("link", { name: "Nova venda" }).click()` abre `getByRole("heading", { level: 1, name: "Nova venda" })`.
- **Prova.** `await evidence.shot("inicio", "Início da loja <loja>")` no desktop e no celular.

## Gotchas

- Loja com poucos dias de venda: "Vendas hoje" diz "vs. média das terças: sem dados para comparar" (sem as 4 terças anteriores na série); com hoje sem venda e base, não há chip, só "Nenhuma venda ainda"; com só devolução de venda anterior (líquido negativo, nenhuma venda nova), o cartão mostra o negativo e "Só devoluções até agora"; um dia passado lido no cartão com a mesma situação diz "Só devoluções", e com líquido zero segue "Nenhuma venda". Cancelar as vendas de hoje pelo Histórico não zerou "Vendas hoje" no Início (R$ 129,90 e "2 vendas" continuaram; a causa não foi investigada): não conte com o cancelamento para fabricar o dia sem venda.
- Os números dependem do relógio de verdade e do fuso da loja (`America/Sao_Paulo`): o nome da região do mês muda ("Vendas em outubro") e "Vendas hoje" só conta as 2 vendas de hoje enquanto o dia não vira. Não assuma valores fixos; compare com `$V sql` quando o valor importar.
- "Resultado estimado" diz "estimativa incompleta" na loja `vendas`: as vendas não têm perfil de pagamento (taxa desconhecida). Não é defeito.
- O e2e com a tela simulada (`apps/web/e2e/home.e2e.ts`) usa textos de uma data fixa ("Sexta-feira, 23 de outubro"): não copie esses textos para a pilha real.
- Com `launch --runtime`, a barra do topo mostra o estado do modo offline ("Preparando o modo offline…", depois, na loja Free, "O modo offline faz parte do plano Pro": o servidor recusa o modo offline por plano; "Offline indisponível neste aparelho" é das outras causas, como a loja Pro sem `OFFLINE_LEASE_SECRET`).
