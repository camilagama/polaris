/// <reference lib="dom" />
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import {
  expectReflowFont,
  openReflowViewport,
  skipOutsideChromium,
} from "../e2e/reflow";
import { HELP_HREF, NAV_ITEMS } from "../src/app-shell/navigation-model";
import { DETAIL_SALE_ID, saleDetailAnswers } from "./sale-detail-fixture";
import { WORKER_MARK } from "./worker-mark";

/**
 * "Voltar" is the arrow before the title of a detail screen and nowhere else (item 12): the Detalhe da venda has it,
 * on the same line as the title and with the name of the list; it is the first control of the screen; it gives the
 * Histórico back as it was left (period, situation and scroll); and no screen of the menu has one.
 */
skipOutsideChromium();

test.beforeEach(({ browserName }, testInfo) => {
  test.skip(
    browserName !== "chromium" || testInfo.project.name !== "chromium-desktop",
    "each test sets its own viewport"
  );
});

const ORGANIZATION = {
  id: "0199c2d0-0000-7000-8000-00000000a001",
  name: "Loja do teste",
  role: "owner",
  timezone: "America/Sao_Paulo",
};
const RPC_PREFIX = /^.*\/rpc\//;
const BACK_NAME = "Voltar para o histórico";
const SALES_COUNT = 30;
const NOW = "2026-10-14T12:00:00.000Z";
const SALE_HEADING = "Detalhe da venda";
const THEMES = ["claro", "escuro"] as const;

const json = (body: unknown) => ({
  body: JSON.stringify(body),
  contentType: "application/json",
  headers: { ...WORKER_MARK },
});

const saleId = (n: number) =>
  `0199c2d0-0000-7000-8000-000000002${String(n).padStart(3, "0")}`;

const entry = (n: number, id: string) => ({
  cancelledAt: "2026-10-13T12:00:00.000Z",
  confirmedAt: "2026-10-14T12:00:01.000Z",
  customerId: null,
  customerName: null,
  hasReturns: false,
  id,
  itemCount: 2,
  occurredAt: "2026-10-14T12:00:00.000Z",
  occurredOn: "2026-10-14",
  paymentMethod: "pix",
  status: "cancelled",
  totalDue: `${10 + n}.00`,
});

const SALES = Array.from({ length: SALES_COUNT }, (_, index) =>
  entry(index, index === SALES_COUNT - 1 ? DETAIL_SALE_ID : saleId(index))
);

interface ListRequest {
  occurredFrom?: string;
  occurredTo?: string;
  status?: string;
}

/** The shell with a session; the list and the detail answered by the test; returns the list requests, in order. */
async function serve(page: Page, theme: (typeof THEMES)[number] = "claro") {
  const lists: ListRequest[] = [];
  await page.clock.setFixedTime(NOW);
  await page.addInitScript((stored) => {
    window.localStorage.setItem("polaris-tema", stored);
  }, theme);
  await page.route("**/api/auth-methods", (route) =>
    route.fulfill(
      json({ emailPassword: true, google: true, turnstileSiteKey: null })
    )
  );
  await page.route("**/api/auth/get-session", (route) =>
    route.fulfill(json({ session: { id: "s" }, user: { id: "u" } }))
  );
  const details = saleDetailAnswers({ withReturn: false });
  await page.route("**/rpc/**", (route) => {
    const procedure = new URL(route.request().url()).pathname.replace(
      RPC_PREFIX,
      ""
    );
    if (procedure === "organization/listMine") {
      return route.fulfill(
        json({ json: { organizations: [ORGANIZATION] }, meta: [] })
      );
    }
    if (procedure === "sale/list") {
      lists.push(route.request().postDataJSON()?.json ?? {});
      return route.fulfill(
        json({ json: { hasMore: false, sales: SALES }, meta: [] })
      );
    }
    const answer = details[procedure];
    return answer === undefined
      ? route.abort("internetdisconnected")
      : route.fulfill(json({ json: answer, meta: [] }));
  });
  return lists;
}

async function openDetail(page: Page) {
  await page.goto(`/sales/detail?saleId=${DETAIL_SALE_ID}`);
  await expect(
    page.getByRole("heading", { level: 1, name: SALE_HEADING })
  ).toBeVisible();
}

const boxOf = async (locator: ReturnType<Page["locator"]>) => {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  return box as NonNullable<typeof box>;
};

for (const width of [1280, 360]) {
  for (const theme of THEMES) {
    test(`AC-B2.1 · ${width} px, tema ${theme}: a seta está à esquerda do título, na mesma linha, e não há link Voltar abaixo`, async ({
      page,
    }) => {
      await page.setViewportSize({ height: 800, width });
      await serve(page, theme);
      await openDetail(page);
      const back = page.getByRole("link", { exact: true, name: BACK_NAME });
      const title = page.getByRole("heading", { level: 1, name: SALE_HEADING });
      await expect(back).toBeVisible();
      await expect(back).toHaveAttribute("href", "/sales/history");
      const arrow = await boxOf(back);
      const text = await boxOf(title);
      expect(arrow.x + arrow.width).toBeLessThanOrEqual(text.x + 1);
      const arrowMiddle = arrow.y + arrow.height / 2;
      expect(arrowMiddle).toBeGreaterThan(text.y);
      expect(arrowMiddle).toBeLessThan(text.y + text.height);
      await expect(page.getByText("Voltar ao histórico")).toHaveCount(0);
    });
  }
}

test("AC-B2.2 · o botão é o primeiro Tab da tela, tem o nome da lista e foco visível", async ({
  page,
}) => {
  await page.setViewportSize({ height: 800, width: 1280 });
  await serve(page);
  await openDetail(page);
  await page.evaluate(() => document.getElementById("conteudo")?.focus());
  await page.keyboard.press("Tab");
  const back = page.getByRole("link", { exact: true, name: BACK_NAME });
  await expect(back).toBeFocused();
  const outline = await back.evaluate((element) => {
    const style = getComputedStyle(element);
    return { style: style.outlineStyle, width: style.outlineWidth };
  });
  expect(outline.style).not.toBe("none");
  expect(Number.parseFloat(outline.width)).toBeGreaterThan(0);
  expect(await back.textContent()).toBe("");
});

test("AC-B2.2 · no toque o alvo do botão tem 44 px", async ({ browser }) => {
  const context = await browser.newContext({
    hasTouch: true,
    isMobile: true,
    viewport: { height: 740, width: 360 },
  });
  const page = await context.newPage();
  try {
    await serve(page);
    await openDetail(page);
    const back = page.getByRole("link", { exact: true, name: BACK_NAME });
    const area = await back.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const px = (value: string) => Number.parseFloat(value) || 0;
      const grown = (pseudo: "::after" | "::before") => {
        const style = getComputedStyle(element, pseudo);
        return style.content === '""' && style.position === "absolute"
          ? {
              height: rect.height - px(style.top) - px(style.bottom),
              width: rect.width - px(style.left) - px(style.right),
            }
          : { height: 0, width: 0 };
      };
      return {
        height: Math.max(
          rect.height,
          grown("::after").height,
          grown("::before").height
        ),
        width: Math.max(
          rect.width,
          grown("::after").width,
          grown("::before").width
        ),
      };
    });
    expect(area.width).toBeGreaterThanOrEqual(44);
    expect(area.height).toBeGreaterThanOrEqual(44);
  } finally {
    await context.close();
  }
});

test("AC-B2.3 · voltar do detalhe repõe o período, a situação e a rolagem do Histórico", async ({
  page,
}) => {
  await page.setViewportSize({ height: 800, width: 1280 });
  const lists = await serve(page);
  await page.goto("/sales/history");
  await expect(page.getByRole("list", { name: "Vendas" })).toBeVisible();
  await page.evaluate(() =>
    window.history.replaceState(
      {
        historyPeriod: { from: "2026-10-01", to: "2026-10-14" },
        historyStatus: "cancelled",
      },
      ""
    )
  );
  await page.reload();
  await expect(page.getByRole("list", { name: "Vendas" })).toBeVisible();
  await expect.poll(() => lists.at(-1)?.status).toBe("cancelled");
  expect(lists.at(-1)?.occurredFrom).toBe("2026-10-01");
  expect(lists.at(-1)?.occurredTo).toBe("2026-10-14");

  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  const left = await page.evaluate(() => window.scrollY);
  expect(left).toBeGreaterThan(200);
  await page.locator(`a[href$="saleId=${DETAIL_SALE_ID}"]`).click();
  await expect(
    page.getByRole("heading", { level: 1, name: SALE_HEADING })
  ).toBeVisible();

  const before = lists.length;
  await page.getByRole("link", { exact: true, name: BACK_NAME }).click();
  await expect(page.getByRole("list", { name: "Vendas" })).toBeVisible();
  await expect.poll(() => lists.length).toBeGreaterThan(before);
  expect(lists.at(-1)).toMatchObject({
    occurredFrom: "2026-10-01",
    occurredTo: "2026-10-14",
    status: "cancelled",
  });
  await expect
    .poll(() => page.evaluate(() => window.scrollY))
    .toBeGreaterThan(left - 120);
});

test("AC-B2.3 · sem usar o Voltar, o Histórico abre como o menu abre: sem período nem situação", async ({
  page,
}) => {
  await page.setViewportSize({ height: 800, width: 1280 });
  const lists = await serve(page);
  await page.goto("/sales/history");
  await page.evaluate(() =>
    window.history.replaceState({ historyStatus: "cancelled" }, "")
  );
  await page.reload();
  await expect.poll(() => lists.at(-1)?.status).toBe("cancelled");
  await page.locator(`a[href$="saleId=${DETAIL_SALE_ID}"]`).click();
  await expect(
    page.getByRole("heading", { level: 1, name: SALE_HEADING })
  ).toBeVisible();
  const before = lists.length;
  await page.goto("/sales/history");
  await expect.poll(() => lists.length).toBeGreaterThan(before);
  expect(lists.at(-1)?.status).toBeUndefined();
});

const BACK_LINK_NAME = /^Voltar/;
const MENU_ROUTES = [...NAV_ITEMS.map((item) => item.href), HELP_HREF];

for (const width of [1280, 360]) {
  test(`AC-B2.4 · ${width} px: nenhuma tela do menu tem "Voltar"`, async ({
    page,
  }) => {
    await page.setViewportSize({ height: 800, width });
    await serve(page);
    for (const route of new Set(MENU_ROUTES)) {
      // biome-ignore lint/performance/noAwaitInLoops: one route after the other, each with its own load
      await page.goto(route);
      await expect(
        page.getByRole("heading", { level: 1 }).first(),
        route
      ).toBeVisible();
      await expect(
        page.locator("main").getByRole("link", { name: BACK_LINK_NAME }),
        route
      ).toHaveCount(0);
    }
  });
}

test("Configurações no celular: a lista não tem Voltar; a tela de um grupo tem a seta antes do título", async ({
  page,
}) => {
  await page.setViewportSize({ height: 740, width: 360 });
  await serve(page);
  await page.goto("/configuracoes");
  await expect(
    page.getByRole("heading", { level: 1, name: "Configurações" })
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Voltar para Configurações" })
  ).toHaveCount(0);
  await page.goto("/configuracoes?aba=formas-de-receber");
  const back = page.getByRole("link", { name: "Voltar para Configurações" });
  const title = page.getByRole("heading", {
    level: 1,
    name: "Configurações",
  });
  await expect(back).toBeVisible();
  const arrow = await boxOf(back);
  const text = await boxOf(title);
  expect(arrow.x + arrow.width).toBeLessThanOrEqual(text.x + 1);
  expect(
    Math.abs(arrow.y + arrow.height / 2 - (text.y + text.height / 2))
  ).toBeLessThan(text.height);
});

test("AC-B2.6 · a 320 px com letra de 20 px a seta e o título cabem, e o título quebra sem empurrar a seta", async ({
  page,
}) => {
  await openReflowViewport(page, { fontPixels: 20, width: 320 });
  await serve(page);
  await openDetail(page);
  await expectReflowFont(page, 20);
  const back = page.getByRole("link", { exact: true, name: BACK_NAME });
  const title = page.getByRole("heading", { level: 1, name: SALE_HEADING });
  const arrow = await boxOf(back);
  const text = await boxOf(title);
  expect(arrow.x).toBeGreaterThanOrEqual(0);
  expect(arrow.x + arrow.width).toBeLessThanOrEqual(text.x + 1);
  expect(text.x + text.width).toBeLessThanOrEqual(320);
  const middle = arrow.y + arrow.height / 2;
  expect(middle).toBeGreaterThan(text.y - 1);
  expect(middle).toBeLessThan(text.y + text.height + 1);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
  ).toBe(true);
});
