# Estoque

O Estoque (`/inventory`) mostra o saldo e o custo médio de cada variante e é onde se recebe, conta e baixa estoque. Venda e devolução movem o saldo sozinhas; cada mudança é um movimento.

## Sub-features

- `estoque-lista` a `list "Saldos por variante"`, com "Saldo" e "Custo médio" por variante (a data do último movimento está no painel de cada movimento: "Saldo atual: 5 · custo médio R$ 62,40 · último movimento 14/10 09:00").
- `estoque-precisa-de-acao` a faixa "Precisa de ação" sob o título, só com variante sem saldo ou sem custo: "1 variante sem saldo · 1 sem custo", cada número um link que aplica `?filtro=sem-saldo` ou `?filtro=sem-custo` sem sair da tela; sem conexão ou sem item, não aparece. O `HelpTip` "Sobre Estoque" no título diz o que muda o saldo.
- `estoque-vazio` loja sem produto: "Nenhuma variante cadastrada. Cadastre um produto para controlar o estoque dele."
- `estoque-filtros` `search "Filtrar estoque"`: `searchbox "Buscar no estoque"`, as abas "Todas", "Com saldo" e "Sem saldo", "Sem custo" e "Incluir arquivados".
- `estoque-receber` recebimento com quantidade e custo unitário.
- `estoque-contar` contagem (o saldo passa a ser o contado).
- `estoque-informar-custo` com saldo maior que 0, custo desconhecido e conexão, "Informar custo" fica no lugar de "Contar" na linha e no recebimento bloqueado ("Antes de receber, informe o custo das unidades que você já tem."); o painel "Informar custo" tem só "Custo de cada unidade (R$)" e grava "Custo informado: R$ X por unidade." sem mudar o saldo. Sem saldo e sem custo, "Receber" vira "Dar entrada".
- `estoque-baixar` baixa com motivo; acima do saldo é recusada.
- `estoque-movimentos` os movimentos de uma variante.
- `estoque-entrada-da-venda` o link "Dar entrada no estoque" da venda (`/inventory?entrada=<id da variante>&de=venda`) abre o painel "Receber estoque" dessa variante, em cartão próprio acima da lista, e tira o parâmetro do endereço; variante que não existe mostra "Não achamos essa variante no estoque. Procure o produto na lista e use Receber.".

## How to get to it (user POV)

- Desktop: link `Estoque` do menu "Principal" (grupo "Catálogo").
- Celular: link `Estoque` da barra "Destinos".
- Endereço `/inventory`; `/inventory?filtro=sem-saldo` abre a lista só com as variantes sem saldo.
- Pelo link "Dar entrada no estoque" de Vender: no item com saldo 0 ou na recusa da venda por falta de estoque ([Vender](vender.md)). A volta é por "Vender" no menu: a venda em andamento continua lá.

## Driving it with verify.sh (Playwright)

Preconditions:

- Doctor OK, `$V seed vendas`, `VERIFY_LOJA=vendas` (3 variantes com saldo e custo 12,00).
- Provado: `drives/receitas.verify.ts --grep estoque-receber`, `--grep estoque-contar` e `--grep estoque-baixar`. Cada um lê o saldo da linha antes e espera o saldo novo, então rodam em qualquer ordem e de novo sem semear: receber soma 5 na Vela aromática, contar põe a Camiseta básica em saldo + 3, baixar tira 2 dela (motivo "Avariado"). O limite é o saldo da Caneca esmaltada, que as vendas dos drives consomem: ela sai da semeadura com 15 (20 recebidas menos as 5 das vendas semeadas), `venda-confirmar` tira 2 e `venda-devolver` tira 2 e devolve 1, ou seja, 3 por rodada de receitas num projeto. Quatro "rodadas × projetos" passam (uma passada com 2 projetos gasta 2, ou seja, 6 Canecas; duas foram executadas); na 5ª sobra 1 Caneca depois do `venda-confirmar` e a venda de 2 do `venda-devolver` não fecha (conta sobre os saldos, não executada); aí semeie de novo (`cleanup` + `launch` + `seed vendas`) ou receba estoque dela.

- **Abrir.** `await page.goto("/inventory")`. `getByRole("heading", { level: 1, name: "Estoque" })`, `status` "3 variantes" e a lista `getByRole("list", { name: "Saldos por variante" })`.
- **Ler um saldo.** `list.getByRole("listitem").filter({ hasText: "Vela aromática" }).getByRole("definition").first()` é o saldo (o primeiro `definition` depois do `term` "Saldo").
- **Receber.** `getByRole("button", { name: "Receber estoque de Vela aromática, Variante padrão" }).click()`; `getByLabel("Quantidade recebida").fill("5")`; `getByLabel("Custo unitário (R$)").fill("10,00")`; `getByRole("button", { exact: true, name: "Revisar" })`; `getByRole("button", { name: "Confirmar recebimento" })`. O saldo da linha sobe 5.
- **Contar.** `getByRole("button", { name: "Contar estoque de Camiseta básica, Variante padrão" }).click()`; `getByLabel("Quantidade contada").fill("<saldo + 3>")`; `getByRole("button", { exact: true, name: "Revisar" })`; `getByRole("button", { name: "Confirmar contagem" })`. O saldo da linha passa a ser o contado. Variante sem saldo e sem custo pede também "Custo unitário para valoração (R$)"; com saldo e sem custo, a linha oferece "Informar custo" no lugar de "Contar" (abaixo).
- **Informar custo.** Precisa de variante com saldo e sem custo (a loja `vendas` não tem: semeie pela RPC uma contagem sem `valuationUnitCost`, como em `apps/web/e2e-real/jornadas/estoque.e2e.ts`). `getByRole("button", { exact: true, name: "Informar custo de <produto> · Variante padrão" }).click()`; `getByLabel("Custo de cada unidade (R$)").fill("12,50")`; "Revisar"; `getByRole("button", { name: "Confirmar custo" })`; o status diz "Custo informado: R$ 12,50 por unidade." e a linha mostra "R$ 12,50" (sem drive próprio).
- **Baixar.** `getByRole("button", { name: "Baixar estoque de Camiseta básica, Variante padrão" }).click()`; `getByLabel("Quantidade a baixar").fill("2")`; `getByRole("combobox", { exact: true, name: "Motivo da baixa" }).click()` e `getByRole("option", { exact: true, name: "Avariado" })`; "Revisar"; `getByRole("button", { name: "Confirmar baixa" })`. O saldo da linha cai 2 (drive `estoque-baixar`). Acima do saldo: "A baixa não pode ser maior que o saldo exibido (<saldo>)" (`apps/web/e2e-real/jornadas/estoque.e2e.ts`; esse caminho de recusa não tem drive).
- **Efeito colateral.** O saldo e os movimentos de uma variante, só leitura (filtre pela loja: `pro` tem os mesmos nomes de produto): `$V sql "SELECT b.quantity, (SELECT string_agg(m.movement_type || ':' || m.quantity_delta, ', ' ORDER BY m.created_at) FROM stock_movements m WHERE m.variant_id = v.id) AS movimentos FROM inventory_balances b JOIN product_variants v ON v.id = b.variant_id JOIN products p ON p.id = v.product_id JOIN organizations o ON o.id = p.organization_id WHERE p.name = 'Camiseta básica' AND o.name LIKE 'qa-verify-vendas%'"`. Depois de `estoque-contar` o último movimento é `inventory_count:3` e, depois de `estoque-baixar`, `write_off:-2`; o `quantity` é o saldo que a tela mostrou.
- **Entrada pelo link da venda.** Na recusa, `getByRole("link", { name: /Dar entrada no estoque/ }).click()` leva a `/inventory` (o `entrada` some do endereço) com o painel `getByRole("heading", { name: /Receber estoque/ })` aberto para a variante em falta; `getByLabel("Quantidade recebida")`, `getByLabel("Custo unitário (R$)")`, "Revisar" e "Confirmar recebimento", como em Receber. Receita completa em `apps/web/e2e-real/jornadas/venda-sem-estoque.e2e.ts`.
- **Prova.** `evidence.shot("estoque-revisar", …)` e `evidence.shot("estoque-recebido", "saldo de X para X+5")`; `estoque-contar-revisar`, `estoque-contado`, `estoque-baixar-revisar` e `estoque-baixado` nas outras duas.

## Gotchas

- Os nomes dos botões de linha levam produto e variante; o produto sem variante própria tem a "Variante padrão".
- Logo depois de confirmar, os botões da lista ficam `[disabled]` enquanto a tela relê: espere o saldo novo (`toHaveText`) antes do próximo clique.
- O custo médio aparece com até 6 casas ("R$ 11,411765") depois de recebimentos com custos diferentes: é o que a tela mostra hoje.
- O saldo semeado é o de antes das vendas: a Camiseta começa com 30 recebidas e as vendas semeadas já tiraram algumas.
