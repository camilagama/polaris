# Vender (Nova venda)

A tela Vender (`/sales`) é o formulário "Nova venda": itens buscados no catálogo com quantidade e preço, ajustes (desconto), o pagamento e a confirmação. Confirmada, a venda vira um registro que não se edita (corrige-se por devolução ou cancelamento, no [Histórico](historico.md)).

## Sub-features

- `venda-abrir` abre a tela com o `h1` "Nova venda" e o `form "Nova venda"`.
- `venda-buscar` busca um produto em "Produto ou variante" e escolhe a variante na lista "Variantes encontradas".
- `venda-itens` quantidade, preço cobrado e preço de tabela de cada item; "Adicionar item".
- `venda-ajuste` "Adicionar ajuste": desconto em percentual ou valor.
- `venda-pagamento` o método ("Pix", "Dinheiro", "Crédito", "Débito", "Transferência", "Outro") e o perfil de pagamento.
- `venda-confirmar` "Confirmar venda" mostra a região "Venda confirmada"; o estoque baixa.
- `venda-sem-produto` loja sem produto: "Cadastre um produto para vender." e o botão "Cadastrar produto".

## How to get to it (user POV)

- Desktop: link `Vender` do menu "Principal".
- Celular: link `Vender`, no meio da barra "Destinos".
- Início: link "Nova venda".
- Endereço `/sales`.

## Driving it with verify.sh (Playwright)

Preconditions:

- Doctor OK, `$V seed vendas`, `VERIFY_LOJA=vendas` (a busca precisa de produto com saldo).
- Provado: `drives/receitas.verify.ts --grep venda-confirmar` (360 claro e 1280 escuro).

- **Abrir.** `await page.goto("/sales")`. `getByRole("heading", { level: 1, name: "Nova venda" })`; o primeiro item é `getByRole("group", { exact: true, name: "Item 1" })`.
- **Buscar.** `item.getByLabel("Produto ou variante").fill("Caneca")`. Aparece `item.getByRole("list", { name: "Variantes encontradas" })` com botões "Caneca esmaltada Saldo 20 · custo médio R$ 12,00"; clique com `getByRole("button", { name: /Caneca esmaltada/ })`.
- **Quantidade e preço.** `item.getByLabel("Quantidade").fill("2")` (há também "Menos uma unidade" e "Mais uma unidade"); `item.getByLabel("Preço cobrado").fill("35,00")`. "Preço de tabela" vem do produto quando ele tem um.
- **Desconto.** `getByRole("button", { name: "Adicionar ajuste" })`, depois no `group "Ajuste 1"`: combobox "Tipo de ajuste" → opção "Desconto", combobox "Como informar" → "Percentual (%)", e `getByLabel("Percentual (%)")` (receita de `apps/web/e2e-real/pages/venda.ts`, `fillSale`).
- **Pagamento.** `getByRole("radiogroup", { name: "Método de pagamento" }).getByRole("radio", { name: "Dinheiro" }).check()`; `getByRole("combobox", { exact: true, name: "Perfil de pagamento" }).click()` e `getByRole("option", { exact: true, name: "Sem perfil de pagamento" }).click()`.
- **Confirmar.** `getByRole("button", { name: "Confirmar venda" }).click()`. Aparece `getByRole("region", { name: /Venda confirmada|já estava confirmada/ })` com "Subtotal" e "Total devido".
- **Efeito colateral.** O Estoque mostra o saldo da Caneca 2 a menos, e o Histórico, uma venda a mais; ou `$V sql "SELECT count(*) FROM sales s JOIN organizations o ON o.id = s.organization_id WHERE o.name LIKE 'qa-verify-vendas%'"`.
- **Prova.** `evidence.shot("venda-preenchida", …)` antes de confirmar e `evidence.shot("venda-confirmada", …)` depois.

## Gotchas

- Sem perfil de pagamento ativo, o formulário avisa "Nenhum perfil de pagamento ativo…" e a venda sai com taxa e prazo desconhecidos: escolha "Sem perfil de pagamento", senão "Confirmar venda" recusa.
- O duplo toque em "Confirmar venda" gera uma venda só (o e2e-real prova com `dblclick`); a região pode dizer "já estava confirmada".
- O placeholder de "Preço cobrado" ("49,90") não é valor: preencha.
- A venda guardada no aparelho sem conexão ("Guardar venda neste aparelho", "Vendas guardadas neste aparelho") não acontece na pilha real com loja Free: prove no modo offline (`/offline-screens-lab?screen=sale`, `apps/web/e2e/offline-screens.e2e.ts` e `apps/web/e2e/sale-screen.e2e.ts`, com a caixa "Rede disponível").
- Cada venda confirmada muda o Início, o Histórico, o Estoque e o Resultado da loja `vendas`: uma receita depois desta não parte mais do estado semeado.
