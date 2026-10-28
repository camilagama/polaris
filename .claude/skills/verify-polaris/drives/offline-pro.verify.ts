import { expect, test } from "../drive/fixture";

/**
 * The offline write on the real stack, with the store `pro` (`verify.sh seed pro`) on a `launch --runtime`: a sale kept
 * on the device without a connection is sent when the connection is back, and only then is an official sale.
 *
 *   VERIFY_LOJA=pro verify.sh drive .claude/skills/verify-polaris/drives/offline-pro.verify.ts --grep venda-offline
 */

const SYNCED = "Tudo sincronizado";
const SAVED_SALE = /Venda guardada neste aparelho/;
const SHIRT = /Camiseta básica/;

test("venda-offline", async ({ context, evidence, page }) => {
  // a price of its own in each run, to find this sale in the database and in the Histórico
  const cents = 10 + (Date.now() % 89);
  const price = `57,${cents}`;
  // the screens write "R$ 57,78" with a space or without, per place
  const total = new RegExp(`R\\$\\s*57,${cents}`);

  // with a connection: the service worker takes control of the tab on the reload, and the device becomes ready
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await page.reload();
  await expect(
    page.getByRole("status").filter({ hasText: SYNCED })
  ).toBeVisible({ timeout: 60_000 });
  await evidence.shot(
    "offline-pronto",
    "aparelho pronto, com conexão: Tudo sincronizado"
  );

  // no connection: the menu still works (the pages come from the device)
  await context.setOffline(true);
  await expect(
    page.getByRole("status").filter({ hasText: "Sem conexão" })
  ).toBeVisible();
  await page.getByRole("link", { exact: true, name: "Vender" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Nova venda" })
  ).toBeVisible();
  const item = page.getByRole("group", { exact: true, name: "Item 1" });
  await item.getByLabel("Produto ou variante").fill("Camiseta");
  await item
    .getByRole("list", { name: "Variantes encontradas" })
    .getByRole("button", { name: SHIRT })
    .click();
  await item.getByLabel("Quantidade").fill("1");
  await item.getByLabel("Preço cobrado").fill(price);
  await page
    .getByRole("radiogroup", { name: "Método de pagamento" })
    .getByRole("radio", { name: "Dinheiro" })
    .check();
  await page
    .getByRole("combobox", { exact: true, name: "Perfil de pagamento" })
    .click();
  await page
    .getByRole("option", { exact: true, name: "Sem perfil de pagamento" })
    .click();
  await evidence.shot(
    "offline-preenchida",
    "Nova venda preenchida sem conexão"
  );
  await page
    .getByRole("button", { name: "Guardar venda neste aparelho" })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: SAVED_SALE })
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Vendas guardadas neste aparelho" })
  ).toContainText(total);
  await evidence.shot(
    "offline-guardada",
    "venda guardada no aparelho, ainda não oficial"
  );

  // the connection is back: the sale goes to the server and leaves the card
  await context.setOffline(false);
  await expect(
    page.getByRole("region", { name: "Vendas guardadas neste aparelho" })
  ).toHaveCount(0, { timeout: 60_000 });
  await expect(
    page.getByRole("status").filter({ hasText: SYNCED })
  ).toBeVisible({ timeout: 60_000 });
  await evidence.shot(
    "offline-enviada",
    "conexão de volta: a venda foi enviada"
  );

  // seen from another screen, read from the server: the sale is in the Histórico
  await page.goto("/sales/history");
  await expect(
    page.getByRole("list", { name: "Vendas" }).getByRole("link").first()
  ).toContainText(total, { timeout: 30_000 });
  await evidence.shot("offline-historico", "a venda enviada no Histórico");
});
