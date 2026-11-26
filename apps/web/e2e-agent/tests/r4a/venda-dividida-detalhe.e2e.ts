import { test } from "@e2e-dev/web";
import { expect } from "e2e";

/**
 * Uma venda em 2 partes (Pix e Dinheiro) confirmada em Vender abre no Histórico e no Detalhe com as
 * duas partes, e o cancelamento a marca como cancelada no Histórico.
 */
const SHIRT = /Camiseta/;
const SHIRT_PRICE = /49,90/;
const CANCELLED = /Cancelada/;
const CANCEL_NOTICE = /^Venda cancelada\. O estoque foi devolvido/;
const PIX_AMOUNT = /R\$\s20,00/;
const CASH_AMOUNT = /R\$\s29,90/;
test("a venda em 2 partes aparece no Histórico e no Detalhe, e o cancelamento a marca como Cancelada", {
  session: "bb-r4a-achados-3",
  tags: ["r4a"],
}, async ({ app, screen }) => {
  await app.open("/sales");
  await screen
    .getByRole("combobox", { name: "Produto ou variante" })
    .fill("Camiseta");
  await screen.getByRole("option", { name: SHIRT }).first().tap();
  await screen
    .getByRole("button", { exact: true, name: "Dividir pagamento" })
    .tap();
  const first = screen.getByRole("group", { exact: true, name: "Parte 1" });
  const second = screen.getByRole("group", { exact: true, name: "Parte 2" });
  await first.getByRole("combobox", { exact: true, name: "Método" }).tap();
  await screen.getByRole("option", { exact: true, name: "Pix" }).tap();
  await first.getByLabel("Valor").fill("20,00");
  await expect(second.getByLabel("Valor")).toHaveValue("29,90");
  await second.getByRole("combobox", { exact: true, name: "Método" }).tap();
  await screen.getByRole("option", { exact: true, name: "Dinheiro" }).tap();
  await second
    .getByRole("combobox", { exact: true, name: "Perfil de pagamento" })
    .tap();
  await screen
    .getByRole("option", { exact: true, name: "Sem perfil de pagamento" })
    .tap();
  await screen.getByRole("button", { name: "Confirmar venda" }).tap();
  await expect(
    screen.getByRole("link", { name: "Ver detalhes e histórico da venda" })
  ).toBeVisible();

  await screen.getByRole("link", { name: "Histórico" }).first().tap();
  await screen.getByRole("link", { name: SHIRT_PRICE }).first().tap();
  await expect(
    screen.getByRole("heading", { name: "Detalhe da venda" })
  ).toBeVisible();
  const parts = screen.getByRole("list", { name: "Pagamento em 2 partes" });
  await expect(parts).toBeVisible();
  await expect(parts.getByText(PIX_AMOUNT).first()).toBeVisible();
  await expect(parts.getByText(CASH_AMOUNT).first()).toBeVisible();

  await screen.getByRole("button", { exact: true, name: "Ações" }).tap();
  await screen
    .getByRole("menuitem", { exact: true, name: "Cancelar venda" })
    .tap();
  await screen.getByRole("button", { name: "Revisar cancelamento" }).tap();
  await screen.getByRole("button", { name: "Confirmar cancelamento" }).tap();
  await expect(screen.getByText(CANCEL_NOTICE).first()).toBeVisible();
  await screen.getByRole("link", { name: "Histórico" }).first().tap();
  await expect(
    screen.getByRole("link", { name: CANCELLED }).first()
  ).toBeVisible();
});
