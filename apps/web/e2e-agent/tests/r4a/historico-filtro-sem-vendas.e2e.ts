import { test } from "@e2e-dev/web";
import { expect } from "e2e";

/** Filtrar por Canceladas numa loja sem venda cancelada dá a frase de vazio e Limpar filtros devolve a lista. */
const SITUATION = /^Situação/;
const LIST = /^Vendas/;
const EMPTY = "Nenhuma venda encontrada com estes filtros.";
test("sem venda cancelada, o filtro Canceladas diz que não achou e Limpar filtros traz a lista", {
  session: "bb-r4a-achados-4",
  tags: ["r4a"],
}, async ({ app, screen }) => {
  await app.open("/sales/history");
  await expect(
    screen.getByRole("heading", { name: "Histórico de vendas" })
  ).toBeVisible();
  await screen
    .getByRole("search", { exact: true, name: "Filtrar vendas" })
    .getByRole("button", { exact: true, name: "Filtrar" })
    .tap();
  await screen.getByRole("menuitem", { name: SITUATION }).tap();
  await screen
    .getByRole("dialog", { name: "Situação" })
    .getByRole("button", { exact: true, name: "Canceladas" })
    .tap();
  await expect(screen.getByText(EMPTY)).toBeVisible();
  await screen.getByRole("button", { name: "Limpar filtros" }).tap();
  await expect(screen.getByRole("list", { name: LIST })).toBeVisible();
});
