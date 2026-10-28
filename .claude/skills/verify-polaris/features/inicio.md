# Início

O Início (`/`) é a primeira tela depois de entrar: a data de hoje, o atalho "Nova venda" e blocos com os números da loja (vendas de hoje e do mês, resultado estimado, ticket médio, meta, o que precisa de atenção, vendas por dia). Numa loja sem produto, mostra "Primeiros passos" no lugar dos números.

## Sub-features

- `inicio-abrir` abre o Início com o `h1` "Início" e a data de hoje.
- `inicio-primeiros-passos` loja nova: a lista "Primeiros passos" com os atalhos para cadastrar e importar produto.
- `inicio-numeros` loja com vendas: as regiões "Vendas hoje", "Vendas em outubro" (o mês corrente), "Resultado estimado" e "Ticket médio".
- `inicio-atencao` a região "Precisa de atenção" (vazia: "Nada precisa de atenção agora.").
- `inicio-meta` a região "Meta" e o link "Definir meta".
- `inicio-grafico` "Vendas por dia" com as abas "7 dias" e "30 dias".
- `inicio-esconder` o botão "Esconder valores".
- `inicio-nova-venda` o link "Nova venda" leva a `/sales`.

## How to get to it (user POV)

- Entrar no app: a raiz `/` abre o Início.
- Desktop: link `Início` do menu "Principal" ou o link `Polaris` do topo.
- Celular: link `Início` da barra "Destinos".

## Driving it with verify.sh (Playwright)

Preconditions:

- Doctor OK. Loja `vazia` para os primeiros passos; `$V seed vendas` e `VERIFY_LOJA=vendas` para os números.

- **Abrir.** `await page.goto("/")`. Aparece `getByRole("heading", { level: 1, name: "Início" })` e um parágrafo com a data ("Quarta-feira, 28 de outubro · atualizado às 09:12"). Provado no `snap` e em `produtos-criar.verify.ts`.
- **Primeiros passos (loja vazia).** `getByRole("region", { name: "Primeiros passos" })` lista "Loja criada (feito)", "Cadastrar o 1º produto" com os links "Cadastrar à mão" (`/products?novo=1`) e "Importar planilha" (`/products?importar=1`), e "Fazer a 1ª venda". Visto no `snap` da loja `vazia`.
- **Números (loja vendas).** `getByRole("region", { name: "Vendas hoje" })` mostra um valor em reais e "2 vendas hoje" logo depois da semeadura; `region "Vendas em <mês>"` (o mês corrente) conta as vendas semeadas que caem no mês: as 8 a partir do dia 7; nos primeiros dias do mês, só as do mês. Visto no passeio da loja `vendas`.
- **Meta.** Na região "Meta", o link "Definir meta" leva a `/dashboard?meta=nova` (abre a aba Metas do Resultado).
- **Gráfico.** `getByRole("tablist", { name: "Período do gráfico" })` com `tab "7 dias"` (selecionada) e `tab "30 dias"`.
- **Nova venda.** `getByRole("link", { name: "Nova venda" }).click()` abre `getByRole("heading", { level: 1, name: "Nova venda" })`.
- **Prova.** `await evidence.shot("inicio", "Início da loja <loja>")` no desktop e no celular.

## Gotchas

- Os números dependem do relógio de verdade e do fuso da loja (`America/Sao_Paulo`): o nome da região do mês muda ("Vendas em outubro") e "Vendas hoje" só conta as 2 vendas de hoje enquanto o dia não vira. Não assuma valores fixos; compare com `$V sql` quando o valor importar.
- "Resultado estimado" diz "estimativa incompleta" na loja `vendas`: as vendas não têm perfil de pagamento (taxa desconhecida). Não é defeito.
- O e2e com a tela simulada (`apps/web/e2e/home.e2e.ts`) usa textos de uma data fixa ("Sexta-feira, 23 de outubro"): não copie esses textos para a pilha real.
- Com `launch --runtime`, a barra do topo mostra o estado do modo offline ("Preparando o modo offline…", depois "Offline indisponível neste aparelho" na loja Free).
