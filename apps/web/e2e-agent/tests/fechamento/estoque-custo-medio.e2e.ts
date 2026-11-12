import { test } from "@e2e-dev/web";
import { expect } from "e2e";

/**
 * Achado da área 3 (Estoque): depois de receber 5 unidades a R$ 10,00 na Camiseta básica (18 a R$ 22,00), o custo
 * médio da lista aparece como "R$ 19,391304". A prévia da própria tela mostra 2 casas ("Custo médio previsto").
 * Esperado pelo explorador: o custo médio em reais com 2 casas.
 */
const RECEIVE = /^Receber/;
const RECEIVED_QUANTITY = /^Quantidade recebida/;
const UNIT_COST = /^Custo unitário/;
const CONFIRM_RECEIPT = /^Confirmar recebimento/;
const RECEIPT_DONE = /^Recebimento registrado/;
const TWO_DECIMALS = /^R\$\s?\d{1,3}(\.\d{3})*,\d{2}$/;

test("custo médio da Camiseta básica depois de um recebimento a R$ 10,00", {
  session: "bb-achados-2",
  tags: ["bugbash"],
}, async ({ app, screen }) => {
  await app.open("/inventory");
  const row = screen
    .getByRole("listitem")
    .filter({ hasText: "Camiseta básica" })
    .first();
  await row.getByRole("button", { name: RECEIVE }).tap();
  await screen.getByLabel(RECEIVED_QUANTITY).fill("5");
  await screen.getByLabel(UNIT_COST).fill("10,00");
  await screen.getByRole("button", { name: "Revisar" }).tap();
  await screen.getByRole("button", { name: CONFIRM_RECEIPT }).tap();
  await expect(screen.getByText(RECEIPT_DONE)).toBeVisible();

  const cost = row.getByRole("definition").filter({ hasText: "R$" }).first();
  await expect(cost).toHaveText(TWO_DECIMALS);
});
