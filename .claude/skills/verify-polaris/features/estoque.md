# Estoque

O Estoque (`/inventory`) mostra o saldo e o custo médio de cada variante e é onde se recebe, conta e baixa estoque. Venda e devolução movem o saldo sozinhas; cada mudança é um movimento.

## Sub-features

- `estoque-lista` a `list "Saldos por variante"`, com "Saldo", "Custo médio" e "Atualizado" por variante.
- `estoque-vazio` loja sem produto: "Nenhuma variante cadastrada. Cadastre um produto para controlar o estoque dele."
- `estoque-filtros` `search "Filtrar estoque"`: `searchbox "Buscar no estoque"`, as abas "Todas", "Com saldo" e "Sem saldo", "Sem custo" e "Incluir produtos arquivados".
- `estoque-receber` recebimento com quantidade e custo unitário.
- `estoque-contar` contagem (o saldo passa a ser o contado).
- `estoque-baixar` baixa com motivo; acima do saldo é recusada.
- `estoque-movimentos` os movimentos de uma variante.

## How to get to it (user POV)

- Desktop: link `Estoque` do menu "Principal" (grupo "Catálogo").
- Celular: link `Estoque` da barra "Destinos".
- Endereço `/inventory`.

## Driving it with verify.sh (Playwright)

Preconditions:

- Doctor OK, `$V seed vendas`, `VERIFY_LOJA=vendas` (3 variantes com saldo e custo 12,00).
- Provado: `drives/receitas.verify.ts --grep estoque-receber`.

- **Abrir.** `await page.goto("/inventory")`. `getByRole("heading", { level: 1, name: "Estoque" })`, `status` "3 variantes" e a lista `getByRole("list", { name: "Saldos por variante" })`.
- **Ler um saldo.** `list.getByRole("listitem").filter({ hasText: "Vela aromática" }).getByRole("definition").first()` é o saldo (o primeiro `definition` depois do `term` "Saldo").
- **Receber.** `getByRole("button", { name: "Receber estoque de Vela aromática, Variante padrão" }).click()`; `getByLabel("Quantidade recebida").fill("5")`; `getByLabel("Custo unitário (R$)").fill("10,00")`; `getByRole("button", { exact: true, name: "Revisar" })`; `getByRole("button", { name: "Confirmar recebimento" })`. O saldo da linha sobe 5.
- **Contar.** Botão "Contar estoque de <produto>, <variante>", campo "Quantidade contada", "Revisar", "Confirmar contagem" (`apps/web/e2e/stock-screen.e2e.ts`).
- **Baixar.** Botão "Baixar estoque de <produto>, <variante>", campos "Quantidade a baixar" e combobox "Motivo da baixa" (opção "Avariado"), "Revisar", "Confirmar baixa". Acima do saldo: "A baixa não pode ser maior que o saldo exibido (<saldo>)" (`apps/web/e2e-real/jornadas/estoque.e2e.ts`).
- **Efeito colateral.** `$V sql "SELECT b.quantity FROM inventory_balances b JOIN product_variants v ON v.id = b.variant_id JOIN products p ON p.id = v.product_id WHERE p.name = 'Vela aromática'"`.
- **Prova.** `evidence.shot("estoque-revisar", …)` e `evidence.shot("estoque-recebido", "saldo de X para X+5")`.

## Gotchas

- Os nomes dos botões de linha levam produto e variante; o produto sem variante própria tem a "Variante padrão".
- Logo depois de confirmar, os botões da lista ficam `[disabled]` enquanto a tela relê: espere o saldo novo (`toHaveText`) antes do próximo clique.
- O custo médio aparece com até 6 casas ("R$ 11,411765") depois de recebimentos com custos diferentes: é o que a tela mostra hoje.
- O saldo semeado é o de antes das vendas: a Camiseta começa com 30 recebidas e as vendas semeadas já tiraram algumas.
