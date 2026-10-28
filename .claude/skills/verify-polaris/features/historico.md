# Histórico e detalhe da venda

O Histórico (`/sales/history`) lista as vendas da loja com filtros por período, situação e cliente. Cada venda abre o detalhe (`/sales/detail?saleId=<id>`), onde se registra devolução, cancela a venda ou troca o cliente; a venda confirmada em si nunca muda.

## Sub-features

- `historico-lista` a lista `list "Vendas"`, cada venda um link com data, situação, cliente, método e total.
- `historico-vazio` loja sem venda: "Nenhuma venda ainda. Registre a primeira venda para vê-la aqui."
- `historico-filtros` o `search "Filtrar vendas"` com o botão "Filtrar"; sem resultado: "Nenhuma venda encontrada com estes filtros. Tire ou ajuste os filtros."
- `historico-detalhe` o detalhe com as regiões "Venda", "Itens", "Devolução", "Cancelar venda" e "Cliente da venda".
- `venda-devolver` devolução parcial, com o que volta ao estoque.
- `venda-cancelar` cancelamento inteiro (o estoque volta).
- `venda-cliente` associar, trocar ou remover o cliente da venda.

## How to get to it (user POV)

- Desktop: link `Histórico` do menu "Principal".
- Celular: link `Histórico` da barra "Destinos".
- Detalhe: um item da lista do Histórico. O endereço é `/sales/detail?saleId=<id>`; sem `saleId` válido a tela diz que falta a venda e leva de volta ao Histórico.

## Driving it with verify.sh (Playwright)

Preconditions:

- Doctor OK, `$V seed vendas`, `VERIFY_LOJA=vendas`.
- Provado: `drives/receitas.verify.ts --grep historico-detalhe` e `--grep venda-devolver`.

- **Lista.** `await page.goto("/sales/history")`. `getByRole("heading", { level: 1, name: "Histórico de vendas" })`; `getByRole("list", { name: "Vendas" })` tem os 8 links semeados, com "Confirmada" e "Retroativa" nas de dias anteriores.
- **Abrir o detalhe.** `getByRole("list", { name: "Vendas" }).getByRole("link").first().click()`. Aparece `getByRole("heading", { level: 1, name: "Detalhe da venda" })` e `getByRole("region", { name: "Itens" })`.
- **Devolução.** `getByRole("region", { name: "Devolução" }).getByRole("button", { name: "Registrar devolução" }).click()`; no `region "Registrar devolução"`: `getByLabel(/^Devolvido: /).first().fill("1")` e `getByLabel(/^Volta ao estoque: /).first().fill("1")`, depois "Revisar devolução" e "Confirmar devolução". Aparece o texto `/^Devolução registrada: /`, e a região "Devoluções" lista "Caneca esmaltada: devolvidas 1 · voltaram ao estoque 1".
- **Devolver a mais.** Quantidade acima do vendido: o painel mostra um `alert` com o limite, "Informe de 1 a <o que resta>, sem vírgula." ("Informe de 1 a 3, sem vírgula." no e2e-real, `apps/web/e2e-real/jornadas/devolucao.e2e.ts`); quando resta 1, o texto é outro ("Só resta 1…").
- **Cancelar.** `getByRole("region", { name: "Cancelar venda" }).getByRole("button", { name: "Cancelar venda" }).click()`, depois "Revisar cancelamento" e "Confirmar cancelamento" (motivo opcional no combobox "Motivo (opcional)"). Receita do e2e-real, não provada aqui.
- **Cliente da venda.** `heading "Cliente da venda"` (nível 2) com "Associar cliente" ou "Trocar cliente" e "Remover cliente" (`apps/web/e2e-pwa/sale-detail-operations.e2e.ts`).
- **Filtros.** "Filtrar" abre o menu "Filtrar por"; atalhos do período (`group "Atalhos do período"`, "7 dias"), a situação ("Confirmadas", "Canceladas"), "Limpar tudo"; no celular o filtro abre num Dialog com "Aplicar" (`apps/web/e2e/history-period.e2e.ts`).
- **Efeito colateral.** Depois da devolução com volta ao estoque, o saldo da variante sobe no [Estoque](estoque.md).
- **Prova.** `evidence.shot("devolucao-revisar", …)` e `evidence.shot("devolucao-registrada", …)`.

## Gotchas

- O primeiro link da lista da loja `vendas` recém-semeada é a venda de 6 dias atrás (2 Canecas): ela foi a última registrada. Cada execução de `venda-devolver` devolve 1; na terceira a venda não tem mais o que devolver. Semeie de novo (`cleanup` + `launch` + `seed vendas`) ou abra outra venda.
- Venda com devolução não se cancela por inteiro: o detalhe diz "Esta venda já tem devoluções, por isso não pode ser cancelada por inteiro."
- O detalhe só funciona com conexão (é uma tela só do servidor).
- `/sales/customer` não existe: abre a página 404 do shell (ver [outros endereços](outros-enderecos.md)).
