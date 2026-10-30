/// <reference lib="dom" />
import type { Page, Route } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { axeFaults } from "./ui-guardrails";
import { stockStates } from "./ui-stock-states";
import { WORKER_MARK } from "./worker-mark";

/**
 * "Informar custo" on Estoque (corte informar-custo-do-item-com-saldo): the row of the shirt (units, no cost) offers
 * it where counting was and the jeans (cost known) do not; the blocked receipt opens it; without a connection it is
 * not there; a balance that moved meanwhile is refused with the panel's own words and read again; axe finds nothing.
 */
const INFORM_SHIRT = "Informar custo de Camiseta do teste · Azul";
const INFORM_ANY = /^Informar custo/;
const RECEIVE_SHIRT = /^Receber estoque de Camiseta/;
const COST_FIELD = "Custo de cada unidade (R$)";
const SHIRT_VARIANT = "0199c2d0-0000-7000-8000-0000000000b1";

const rows = (page: Page) =>
  page.getByRole("list", { name: "Saldos por variante" });

const rpc = (body: unknown, status = 200) => ({
  body: JSON.stringify({ json: body, meta: [] }),
  contentType: "application/json",
  headers: { ...WORKER_MARK },
  status,
});

test.describe("Estoque, Informar custo", () => {
  test("a linha com saldo e sem custo troca Contar por Informar custo, e só ela", async ({
    page,
  }) => {
    await stockStates.list(page);
    const shirt = rows(page)
      .getByRole("listitem")
      .filter({ hasText: "Camiseta do teste" });
    await expect(
      shirt.getByRole("button", { exact: true, name: INFORM_SHIRT })
    ).toHaveText("Informar custo");
    await expect(shirt.getByRole("button", { name: "Contar" })).toHaveCount(0);
    const jeans = rows(page)
      .getByRole("listitem")
      .filter({ hasText: "Calça jeans" });
    await expect(jeans.getByRole("button", { name: INFORM_ANY })).toHaveCount(
      0
    );
  });

  test("o painel abre com o foco no custo, a linha das unidades e, vazio, o erro", async ({
    page,
  }) => {
    // the visual state blurs the focus to measure the screen alone: the row's button is clicked here
    await stockStates.list(page);
    await page.getByRole("button", { exact: true, name: INFORM_SHIRT }).click();
    await expect(
      page.getByRole("heading", { name: "Informar custo" })
    ).toBeVisible();
    await expect(page.getByLabel(COST_FIELD)).toBeFocused();
    await expect(
      page.getByText("Para as 5 unidades que você tem agora.")
    ).toBeVisible();
    await expect(
      page.getByText(
        "Vale para as unidades de agora e para as próximas vendas. Depois não dá para editar."
      )
    ).toBeVisible();
    await expect(page.getByLabel("Quantidade contada")).toHaveCount(0);
    await page.getByRole("button", { exact: true, name: "Revisar" }).click();
    await expect(
      page.getByText("Informe o custo de cada unidade.")
    ).toBeVisible();
    await expect(page.getByLabel(COST_FIELD)).toBeFocused();
    expect(await axeFaults(page)).toEqual([]);
  });

  test("o resumo diz o custo, as unidades e que não dá para editar", async ({
    page,
  }) => {
    await stockStates.costConfirming(page);
    await expect(
      page.getByText(
        "R$ 12,50 por unidade, para 5 unidades. Depois de confirmar, o custo não pode ser editado."
      )
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Confirmar custo" })
    ).toBeVisible();
    expect(await axeFaults(page)).toEqual([]);
  });

  for (const typed of ["0", "0,00"]) {
    test(`custo ${typed} passa na revisão e o resumo diz R$ 0,00`, async ({
      page,
    }) => {
      await stockStates.cost(page);
      await page.getByLabel(COST_FIELD).fill(typed);
      await page.getByRole("button", { exact: true, name: "Revisar" }).click();
      await expect(
        page.getByText(
          "R$ 0,00 por unidade, para 5 unidades. Depois de confirmar, o custo não pode ser editado."
        )
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Confirmar custo" })
      ).toBeVisible();
    });
  }

  test("envia a contagem do saldo lido com o custo, e a linha mostra o custo", async ({
    page,
  }) => {
    const sent: unknown[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/rpc/inventory/inventoryCount")) {
        sent.push(JSON.parse(request.postData() ?? "{}").json);
      }
    });
    await stockStates.costDone(page);
    expect(sent).toEqual([
      expect.objectContaining({
        expectedVersion: 1,
        physicalQuantity: 5,
        valuationUnitCost: "12.50",
        variantId: SHIRT_VARIANT,
      }),
    ]);
    await page.getByRole("button", { exact: true, name: "Fechar" }).click();
    const shirt = rows(page)
      .getByRole("listitem")
      .filter({ hasText: "Camiseta do teste" });
    await expect(shirt).toContainText("R$ 12,50");
    await expect(shirt).not.toContainText("Custo desconhecido");
    await expect(shirt.getByRole("button", { name: INFORM_ANY })).toHaveCount(
      0
    );
  });

  test("o recebimento bloqueado diz o motivo sem jargão e abre o Informar custo", async ({
    page,
  }) => {
    await stockStates.receiveBlocked(page);
    await expect(
      page.getByText(
        "Antes de receber, informe o custo das unidades que você já tem."
      )
    ).toBeVisible();
    await page
      .getByRole("region", { name: "Receber estoque" })
      .getByRole("button", { exact: true, name: INFORM_SHIRT })
      .click();
    await expect(
      page.getByRole("heading", { name: "Informar custo" })
    ).toBeVisible();
    await expect(page.getByLabel(COST_FIELD)).toBeFocused();
  });

  test("se o saldo mudou, recusa com o texto do painel, relê e pede para revisar", async ({
    page,
  }) => {
    await page.route("**/rpc/inventory/inventoryCount", (route: Route) =>
      route.fulfill(
        rpc(
          {
            code: "CONFLICT",
            data: { reason: "inventory_version_conflict" },
            defined: true,
            message: "Conflict",
            status: 409,
          },
          409
        )
      )
    );
    await page.route("**/rpc/inventory/getBalance", (route: Route) =>
      route.fulfill(
        rpc({
          movingAverageCost: null,
          quantity: 4,
          variantId: SHIRT_VARIANT,
          version: 2,
        })
      )
    );
    await stockStates.costConfirming(page);
    await page.getByRole("button", { name: "Confirmar custo" }).click();
    await expect(
      page.getByText(
        "O saldo mudou depois que você abriu o painel. Atualizamos o saldo: revise e confirme o custo de novo."
      )
    ).toBeVisible();
    await expect(
      page.getByText("Para as 4 unidades que você tem agora.")
    ).toBeVisible();
    await expect(page.getByText("contagem", { exact: false })).toHaveCount(0);
  });

  test("sem conexão a ação não aparece (AC-7)", async ({ page }) => {
    await stockStates.offline(page);
    await expect(page.getByRole("button", { name: INFORM_ANY })).toHaveCount(0);
    await page.getByRole("button", { name: RECEIVE_SHIRT }).first().click();
    await expect(
      page.getByText("Antes de receber, informe o custo", { exact: false })
    ).toHaveCount(0);
  });
});
