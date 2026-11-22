/// <reference lib="dom" />
import type { Locator, Page } from "@playwright/test";
import { expect } from "@playwright/test";
import {
  DETAIL_SALE_ID,
  saleDetailAnswers,
} from "../e2e-pwa/sale-detail-fixture";
import {
  assertNoPageScroll,
  assertNothingClipped,
  expectReflowFont,
  openReflowViewport,
  reflowTest,
  skipOutsideChromium,
} from "./reflow";
import { serveHealth, WORKER_MARK } from "./worker-mark";

/**
 * The customer line of the sale detail, with its summary, read at 320 px with the browser font at 20 px (`./reflow`), with the
 * summary of the customer at its widest: a total of millions, a count of three digits and a date with the year. The
 * three indicators stay whole and the page does not scroll sideways. The same width holds for a long customer name,
 * in the current customer and in the rows of the attribution history, also with two versions of the link.
 */
skipOutsideChromium();

const ORGANIZATION = {
  id: "0199c2d0-0000-7000-8000-00000000a001",
  name: "Loja do teste",
  role: "owner",
  timezone: "America/Sao_Paulo",
};
const NOW = new Date("2026-10-14T12:00:00-03:00");
const LAST_PURCHASE_ON = new Date(NOW.getTime() - 300 * 86_400_000)
  .toISOString()
  .slice(0, 10);
const LAST_PURCHASE_TEXT = LAST_PURCHASE_ON.split("-").reverse().join("/");
const TOTAL_TEXT = /^R\$\s1\.234\.567,89$/;
const PURCHASES = 128;

const answer = (body: string) => ({
  body,
  contentType: "application/json",
  headers: { ...WORKER_MARK },
});
const rpcBody = (json: unknown) => answer(JSON.stringify(json));
const rpc = (json: unknown) => rpcBody({ json, meta: [] });

async function openSaleDetail(
  page: Page,
  name?: string,
  overrides: Readonly<Record<string, unknown>> = {}
) {
  const answers = saleDetailAnswers({ withReturn: true });
  const customer = answers["customer/get"] as object;
  const withSummary = {
    ...answers,
    ...overrides,
    "customer/get": {
      ...customer,
      ...(name === undefined ? {} : { name }),
      summary: {
        lastPurchaseOn: LAST_PURCHASE_ON,
        purchaseCount: PURCHASES,
        totalSpent: "1234567.89",
      },
    },
  };
  await openReflowViewport(page);
  await page.route("**/api/auth/get-session", (route) =>
    route.fulfill(rpcBody({ session: { id: "s" }, user: { id: "u" } }))
  );
  await serveHealth(page);
  await page.route("**/rpc/**", (route) => {
    const procedure = new URL(route.request().url()).pathname.replace(
      "/rpc/",
      ""
    );
    if (procedure === "organization/listMine") {
      return route.fulfill(rpc({ organizations: [ORGANIZATION] }));
    }
    const found = (withSummary as Record<string, unknown>)[procedure];
    return found === undefined
      ? route.abort("internetdisconnected")
      : route.fulfill(rpc(found));
  });
  await page.clock.setFixedTime(NOW);
  await page.goto(`/sales/detail?saleId=${DETAIL_SALE_ID}`);
  await expect(page.locator("[data-sale-customer]")).toBeVisible();
  await expectReflowFont(page, 20);
  return page.locator("[data-customer-summary]");
}

const LONG_NAME =
  "Ana Albuquerquefigueiredonascimentodossantosoliveira de Lima Vasconcelossampaiocavalcantipereira";
const UNBROKEN_NAME =
  "MariaAparecidaDosSantosAlbuquerqueFigueiredoNascimentoVasconcelosSampaioCavalcanti";

const longestWordWidth = (current: Locator, name: string) =>
  current.evaluate((element, text) => {
    const word =
      text
        .split(" ")
        .sort((first, second) => second.length - first.length)
        .at(0) ?? "";
    const probe = document.createElement("span");
    probe.textContent = word;
    probe.style.cssText =
      "position:absolute;visibility:hidden;white-space:nowrap";
    element.append(probe);
    const { width } = probe.getBoundingClientRect();
    probe.remove();
    return width;
  }, name);

reflowTest(
  "a 320 px com letra de 20 px o resumo do cliente da venda lê inteiro, com total de milhões, várias compras e a data com ano",
  async ({ page }) => {
    const summary = await openSaleDetail(page, LONG_NAME);
    await expect(summary).toBeVisible();
    await assertNothingClipped(page.locator("[data-sale-customer]"));
    await expect(summary.locator("dd")).toHaveText([
      String(PURCHASES),
      TOTAL_TEXT,
      LAST_PURCHASE_TEXT,
    ]);
    await assertNothingClipped(summary);
    await assertNothingClipped(page.locator("main"));
    await assertNoPageScroll(page);
  }
);

for (const name of [LONG_NAME, UNBROKEN_NAME]) {
  reflowTest(
    `a 320 px com letra de 20 px o nome longo do cliente da venda fica dentro da linha do cliente, sem rolagem lateral (${name.includes(" ") ? "com espaços" : "sem espaços"})`,
    async ({ page }) => {
      await openSaleDetail(page, name);
      const card = page.locator("[data-sale-customer]");
      const current = card.locator("[data-sale-customer-name]");
      await expect(current).toBeVisible();
      await expect(current).toHaveText(name);
      const box = await card.boundingBox();
      const written = await current.boundingBox();
      const windowWidth = page.viewportSize()?.width ?? 0;
      expect(windowWidth, "a janela do teste tem 320 px").toBe(320);
      expect(
        await longestWordWidth(current, name),
        "a maior palavra sozinha é mais larga que a janela de 320 px: sem quebra dentro da palavra o nome vazaria"
      ).toBeGreaterThan(windowWidth);
      expect(
        (box?.x ?? 0) + (box?.width ?? 0),
        "a linha do cliente não passa da borda da janela"
      ).toBeLessThanOrEqual(windowWidth);
      expect(box, "a linha do cliente está na tela").not.toBeNull();
      expect(written, "o nome está na tela").not.toBeNull();
      expect(
        (written?.x ?? 0) + (written?.width ?? 0),
        "o nome não passa da borda direita da linha do cliente"
      ).toBeLessThanOrEqual((box?.x ?? 0) + (box?.width ?? 0) + 0.5);
      expect(
        written?.x ?? 0,
        "o nome não passa da borda esquerda"
      ).toBeGreaterThanOrEqual((box?.x ?? 0) - 0.5);
      await assertNothingClipped(card);
      await assertNoPageScroll(page);
    }
  );
}

for (const name of [LONG_NAME, UNBROKEN_NAME]) {
  reflowTest(
    `a 320 px com letra de 20 px o nome longo na lista de linhas do histórico fica dentro da janela (${name.includes(" ") ? "com espaços" : "sem espaços"})`,
    async ({ page }) => {
      await openSaleDetail(page, name);
      const card = page.getByRole("region", {
        name: "Histórico de atribuição do cliente",
      });
      const row = card.getByRole("listitem").filter({ hasText: name });
      await expect(row).toHaveCount(1);
      await expect(row).toBeVisible();
      const windowWidth = page.viewportSize()?.width ?? 0;
      expect(windowWidth, "a janela do teste tem 320 px").toBe(320);
      expect(
        await longestWordWidth(row, name),
        "a maior palavra sozinha é mais larga que a janela de 320 px: sem quebra dentro da palavra a linha vazaria"
      ).toBeGreaterThan(windowWidth);
      const written = await row.boundingBox();
      expect(written, "a linha está na tela").not.toBeNull();
      expect(
        (written?.x ?? 0) + (written?.width ?? 0),
        "a linha do histórico não passa da borda da janela"
      ).toBeLessThanOrEqual(windowWidth);
      const overflow = await row.evaluate(
        (element) => element.scrollWidth - element.clientWidth
      );
      expect(overflow, "o texto da linha não passa da própria caixa").toBe(0);
      await assertNoPageScroll(page);
    }
  );
}

reflowTest(
  "a 320 px com letra de 20 px o menu Ações cabe na tela e nenhum item é cortado",
  async ({ page }) => {
    await openSaleDetail(page);
    await page.getByRole("button", { exact: true, name: "Ações" }).click();
    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible();
    const window = page.viewportSize();
    const box = await menu.boundingBox();
    expect(box, "o menu está na tela").not.toBeNull();
    expect(
      box?.x ?? -1,
      "o menu não passa da borda esquerda"
    ).toBeGreaterThanOrEqual(0);
    expect(
      (box?.x ?? 0) + (box?.width ?? 0),
      "o menu não passa da borda direita"
    ).toBeLessThanOrEqual(window?.width ?? 0);
    expect(
      (box?.y ?? 0) + (box?.height ?? 0),
      "o menu não passa da borda de baixo"
    ).toBeLessThanOrEqual(window?.height ?? 0);
    const items = menu.getByRole("menuitem");
    await expect(items).toHaveText([
      "Trocar cliente",
      "Remover cliente",
      "Registrar devolução",
    ]);
    const overflow = await items.evaluateAll((nodes) =>
      nodes.map((node) => node.scrollWidth - node.clientWidth)
    );
    expect(overflow, "o texto de cada item cabe na própria caixa").toEqual([
      0, 0, 0,
    ]);
    await assertNothingClipped(menu);
    await assertNoPageScroll(page);
  }
);

const FORMER_CUSTOMER_ID = "0199c2d0-0000-7000-8000-000000000799";
const CURRENT_CUSTOMER_ID = "0199c2d0-0000-7000-8000-000000000710";

const twoVersionsOfLink = (formerName: string) => {
  const at = (minutes: number) =>
    new Date(NOW.getTime() + minutes * 60_000).toISOString();
  return {
    "customer/list": {
      customers: [
        {
          anonymizedAt: null,
          archivedAt: null,
          createdAt: at(-60),
          email: null,
          id: FORMER_CUSTOMER_ID,
          name: formerName,
          notes: null,
          organizationId: ORGANIZATION.id,
          phone: null,
          status: "active",
          updatedAt: at(-60),
          version: 1,
        },
      ],
    },
    "sale/getCustomerLink": {
      current: { customerId: CURRENT_CUSTOMER_ID, version: 2 },
      history: [
        {
          action: "assign",
          createdAt: at(5),
          customerId: FORMER_CUSTOMER_ID,
          version: 1,
        },
        {
          action: "reassign",
          createdAt: at(10),
          customerId: CURRENT_CUSTOMER_ID,
          version: 2,
        },
      ],
      saleId: DETAIL_SALE_ID,
    },
  };
};

for (const name of [LONG_NAME, UNBROKEN_NAME]) {
  reflowTest(
    `a 320 px com letra de 20 px a linha da versão 1 do histórico, com cliente de nome longo, fica dentro do painel ao lado da versão 2 (${name.includes(" ") ? "com espaços" : "sem espaços"})`,
    async ({ page }) => {
      await openSaleDetail(page, undefined, twoVersionsOfLink(name));
      const card = page.getByRole("region", {
        name: "Histórico de atribuição do cliente",
      });
      const list = card.getByRole("list");
      const items = list.getByRole("listitem");
      await expect(items).toHaveCount(2);
      const newest = items.first();
      const oldest = items.last();
      await expect(newest).toContainText("v2 · Cliente trocado");
      await expect(oldest).toContainText(`v1 · Cliente associado: ${name}`);
      const windowWidth = page.viewportSize()?.width ?? 0;
      expect(windowWidth, "a janela do teste tem 320 px").toBe(320);
      expect(
        await longestWordWidth(oldest, name),
        "a maior palavra sozinha é mais larga que a janela de 320 px: sem quebra dentro da palavra a linha vazaria"
      ).toBeGreaterThan(windowWidth);
      const panel = await card.boundingBox();
      const written = await oldest.boundingBox();
      expect(panel, "o painel está na tela").not.toBeNull();
      expect(written, "a linha da versão 1 está na tela").not.toBeNull();
      expect(
        (written?.x ?? 0) + (written?.width ?? 0),
        "a linha da versão 1 não passa da borda da janela"
      ).toBeLessThanOrEqual(windowWidth);
      expect(
        (panel?.x ?? 0) + (panel?.width ?? 0),
        "o painel não passa da borda da janela"
      ).toBeLessThanOrEqual(windowWidth);
      const overflows = await Promise.all(
        [oldest, list, card].map((element) =>
          element.evaluate((node) => node.scrollWidth - node.clientWidth)
        )
      );
      expect(
        overflows,
        "a linha, a lista e o painel não passam da própria caixa"
      ).toEqual([0, 0, 0]);
      await assertNothingClipped(card);
      await assertNoPageScroll(page);
    }
  );
}
