import type { Locator } from "@playwright/test";
import { expect, openJourney, test } from "../fixtures";
import { fillSale } from "../pages/venda";
import { seedProduct } from "../seed";

const MUG = /Caneca esmaltada/;
const ENTRY_LINK = /^Dar entrada no estoque/;
const CONFIRMED = /Venda confirmada|já estava confirmada/;
const REFUSAL = "A venda não foi registrada";
const UNKNOWN_VARIANT = "0199c2d0-0000-7000-8000-00000000dead";
const ZONE = "America/Sao_Paulo";

/**
 * `taps` counts what a person taps on the screen from the refusal to the finished sale: each control, and each field
 * that does not already have the focus.
 */
test("venda sem estoque: a recusa leva à entrada, a venda em andamento volta e conclui, uma venda só", async ({
  browser,
  sql,
}, testInfo) => {
  const journey = await openJourney(browser, testInfo, "venda-sem-estoque", {
    organization: { timezone: ZONE },
  });
  const { page } = journey;
  const organizationId = journey.organizationId as string;
  const product = await seedProduct(
    journey.user.rpc,
    organizationId,
    "Caneca esmaltada",
    "35.00"
  );
  const confirms: { commandId: string; occurredAt: string }[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/rpc/sale/confirm")) {
      const { json } = JSON.parse(request.postData() ?? "{}") as {
        json: { commandId: string; occurredAt: string };
      };
      confirms.push({
        commandId: json.commandId,
        occurredAt: json.occurredAt,
      });
    }
  });
  const count = async (table: "sales" | "stock_movements") =>
    Number(
      (
        await sql.query<{ n: string }>(
          table === "sales"
            ? "SELECT count(*)::text AS n FROM sales WHERE organization_id = $1"
            : "SELECT count(*)::text AS n FROM stock_movements WHERE variant_id = $1",
          [table === "sales" ? organizationId : product.variantId]
        )
      ).rows[0]?.n
    );

  await page.goto("/sales");
  await fillSale(
    page,
    [{ charged: "35,00", option: MUG, quantity: 2, search: "Caneca" }],
    []
  );
  const item = page.getByRole("group", { exact: true, name: "Item 1" });
  await expect(item).toContainText(
    "Sem estoque: saldo 0. Para vender, dê entrada no estoque."
  );
  const itemLink = item.getByRole("link", { name: ENTRY_LINK });
  await expect(itemLink).toHaveText(
    "Dar entrada no estoque de Caneca esmaltada"
  );
  await expect(itemLink).toHaveAttribute(
    "href",
    `/inventory?entrada=${product.variantId}&de=venda`
  );
  expect(await itemLink.getAttribute("target")).toBeNull();

  await page.getByRole("button", { name: "Confirmar venda" }).click();
  const refusal = page.getByRole("alert").filter({ hasText: REFUSAL });
  await expect(refusal).toContainText(
    "A venda não foi registrada: falta estoque de Caneca esmaltada (pediu 2, saldo 0)."
  );
  await expect(page.locator(":focus").getByRole("alert")).toHaveCount(1);
  expect(await count("sales")).toBe(0);
  expect(await count("stock_movements")).toBe(0);
  expect(confirms).toHaveLength(1);

  let taps = 0;
  const tap = async (target: Locator) => {
    taps += 1;
    await target.click();
  };
  // a field that already has the focus (the panel opens on the quantity) is typed into with no tap
  const fill = async (target: Locator, value: string) => {
    const focused = await target.evaluate(
      (element) => element === document.activeElement
    );
    taps += focused ? 0 : 1;
    await target.fill(value);
  };

  const refusalLink = refusal.getByRole("link", { name: ENTRY_LINK });
  await expect(refusalLink).toHaveAttribute(
    "href",
    `/inventory?entrada=${product.variantId}&de=venda`
  );
  await tap(refusalLink);
  await expect(
    page.getByRole("heading", { exact: true, level: 1, name: "Estoque" })
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Receber estoque" })
  ).toBeVisible();
  await expect(
    page.getByText("Caneca esmaltada · Variante padrão")
  ).toBeVisible();
  expect(new URL(page.url()).search).toBe("");
  await fill(page.getByLabel("Quantidade recebida"), "5");
  await fill(page.getByLabel("Custo unitário (R$)"), "12,50");
  await tap(page.getByRole("button", { exact: true, name: "Revisar" }));
  await tap(page.getByRole("button", { name: "Confirmar recebimento" }));
  await expect.poll(() => count("stock_movements")).toBe(1);

  await tap(
    page
      .getByRole("navigation", { exact: true, name: "Principal" })
      .getByRole("link", { exact: true, name: "Vender" })
  );
  const back = page.getByRole("group", { exact: true, name: "Item 1" });
  await expect(back).toContainText("Caneca esmaltada");
  await expect(back.getByLabel("Quantidade")).toHaveValue("2");
  await expect(back.getByLabel("Preço cobrado")).toHaveValue("35,00");
  await expect(back).toContainText("Saldo atual: 5 unidades.");
  await tap(page.getByRole("button", { name: "Confirmar venda" }));
  await expect(page.getByRole("region", { name: CONFIRMED })).toBeVisible();

  console.log(`toques desde a recusa até a venda concluída: ${taps}`);
  testInfo.annotations.push({ description: String(taps), type: "toques" });

  // one sale, and the one after the entry is a new attempt: its command and its instant are not the refused one's
  expect(await count("sales")).toBe(1);
  expect(confirms).toHaveLength(2);
  const [refused, accepted] = confirms;
  expect(accepted?.commandId).not.toBe(refused?.commandId);
  expect(Date.parse(accepted?.occurredAt ?? "")).toBeGreaterThan(
    Date.parse(refused?.occurredAt ?? "")
  );
  const [balance] = (
    await sql.query<{ quantity: number }>(
      "SELECT quantity FROM inventory_balances WHERE variant_id = $1",
      [product.variantId]
    )
  ).rows;
  expect(balance?.quantity).toBe(3);
  expect(await count("stock_movements")).toBe(2);
});

test("estoque pelo link: variante que não existe mostra um aviso curto, sem erro, e o parâmetro sai do endereço", async ({
  browser,
}, testInfo) => {
  const journey = await openJourney(browser, testInfo, "estoque-pelo-link", {
    organization: { timezone: ZONE },
  });
  const { page } = journey;
  await page.goto(`/inventory?entrada=${UNKNOWN_VARIANT}&de=venda`);
  await expect(
    page.getByRole("heading", { exact: true, level: 1, name: "Estoque" })
  ).toBeVisible();
  await expect(
    page.getByText(
      "Não achamos essa variante no estoque. Procure o produto na lista e use Receber."
    )
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Receber estoque" })
  ).toHaveCount(0);
  expect(new URL(page.url()).search).toBe("");
});
