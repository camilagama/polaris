/// <reference lib="dom" />
import type { Locator, Page, Route } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { FORM_VIEWPORTS } from "./date-pickers";
import { serveLabWorker, WORKER_MARK } from "./worker-mark";

const NOW = "2026-10-14T12:00:00.000Z";
const NET = "R$ 123,40";
const SUM_OF_ROWS = "R$ 150,00";
const SCREEN_LABEL = "Total na tela";
const PERIOD_LABEL = "Vendas líquidas do período";
const MASKED = "R$ ••••";

const PERIOD_ITEM = /^Período/;
const id = (n: number) =>
  `0199c2d0-0000-7000-8000-000000004${String(n).padStart(3, "0")}`;
const entry = (n: number, overrides: Record<string, unknown> = {}) => ({
  cancelledAt: null,
  confirmedAt: "2026-10-12T12:00:01.000Z",
  customerId: null,
  customerName: null,
  hasReturns: false,
  id: id(n),
  itemCount: 2,
  occurredAt: "2026-10-12T12:00:00.000Z",
  occurredOn: "2026-10-12",
  paymentMethod: "pix",
  status: "confirmed",
  totalDue: "100.00",
  ...overrides,
});
const SALES = [
  entry(1),
  entry(2, { totalDue: "50.00" }),
  entry(3, { status: "cancelled", totalDue: "999.00" }),
];

const rpc = (body: unknown) => ({
  body: JSON.stringify({ json: body, meta: [] }),
  contentType: "application/json",
  headers: { ...WORKER_MARK },
});

interface Summary {
  asked: unknown[];
  fail: boolean;
  gate?: Promise<void> | undefined;
}

async function openHistory(page: Page, summary: Summary) {
  await page.clock.setFixedTime(new Date(NOW));
  await page.route("**/rpc/sale/list", (route: Route) =>
    route.fulfill(rpc({ hasMore: false, sales: SALES }))
  );
  await page.route("**/rpc/report/periodSummary", async (route: Route) => {
    summary.asked.push(
      (route.request().postDataJSON() as { json: unknown }).json
    );
    await summary.gate;
    if (summary.fail) {
      await route.fulfill({
        body: JSON.stringify({
          json: {
            code: "FORBIDDEN",
            defined: false,
            message: "no",
            status: 403,
          },
          meta: [],
        }),
        contentType: "application/json",
        headers: { ...WORKER_MARK },
        status: 403,
      });
      return;
    }
    await route.fulfill(rpc({ cards: { netSales: "123.40", salesCount: 3 } }));
  });
  await serveLabWorker(page);
  await page.goto("/offline-screens-lab?screen=history");
  await page.getByLabel("Usuário").fill(`user-${crypto.randomUUID()}`);
  await page.getByRole("button", { exact: true, name: "Iniciar" }).click();
  await expect(
    page.getByRole("heading", { exact: true, name: "Histórico de vendas" })
  ).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("[data-list-total]")).toContainText(SUM_OF_ROWS);
}

async function chooseTypedPeriod(page: Page, from: string, to: string) {
  const bar = page.getByRole("search", { exact: true, name: "Filtrar vendas" });
  await bar.getByRole("button", { exact: true, name: "Filtrar" }).click();
  await page
    .getByRole("menu", { name: "Filtrar por" })
    .getByRole("menuitem", { name: PERIOD_ITEM })
    .click();
  const popup = page.getByRole("dialog", { name: "Período" });
  await popup.getByRole("button", { name: "Digitar as datas" }).click();
  await popup.getByRole("textbox", { name: "Início" }).pressSequentially(from);
  await popup.getByRole("textbox", { name: "Fim" }).pressSequentially(to);
  await popup.getByRole("button", { exact: true, name: "Aplicar" }).click();
  await expect(popup).toBeHidden();
}

async function chooseSevenDays(page: Page) {
  const bar = page.getByRole("search", { exact: true, name: "Filtrar vendas" });
  await bar.getByRole("button", { exact: true, name: "Filtrar" }).click();
  await page
    .getByRole("menu", { name: "Filtrar por" })
    .getByRole("menuitem", { name: PERIOD_ITEM })
    .click();
  const popup = page.getByRole("dialog", { name: "Período" });
  await popup
    .getByRole("group", { name: "Atalhos do período" })
    .getByRole("button", { exact: true, name: "7 dias" })
    .click();
  await expect(popup).toBeHidden();
}

const footerOf = (page: Page) => page.locator("[data-list-total]");
const heightOf = async (locator: Locator) =>
  (await locator.boundingBox())?.height ?? 0;

for (const viewport of FORM_VIEWPORTS) {
  test.describe(`a ${viewport.name} px`, () => {
    test.use({ viewport });

    test("com o período sozinho o rodapé é o líquido do servidor, da mesma altura lendo e lido, e sem período volta ao total na tela sem chamada", async ({
      page,
    }) => {
      let release: (() => void) | undefined;
      const summary: Summary = {
        asked: [],
        fail: false,
        gate: new Promise<void>((resolve) => {
          release = resolve;
        }),
      };
      await openHistory(page, summary);
      expect(summary.asked, "sem período, nenhuma leitura").toEqual([]);
      await expect(footerOf(page)).toContainText(SCREEN_LABEL);

      await chooseSevenDays(page);
      const footer = footerOf(page);
      await expect(footer).toContainText(PERIOD_LABEL);
      await expect(footer.locator("[data-list-total-skeleton]")).toBeVisible();
      await expect(footer).not.toContainText(SCREEN_LABEL);
      await expect(footer).not.toContainText(SUM_OF_ROWS);
      const reading = await heightOf(footer);

      release?.();
      await expect(footer).toContainText(NET);
      await expect(footer).toContainText("3 vendas");
      await expect(footer).not.toContainText("há mais");
      await expect(footer).not.toContainText("cancelada");
      await expect(footer).not.toContainText(SCREEN_LABEL);
      await expect(footer.locator("[data-list-total-skeleton]")).toHaveCount(0);
      expect(
        Math.abs(reading - (await heightOf(footer))),
        "lendo e lido têm a mesma altura"
      ).toBeLessThanOrEqual(1);
      expect(summary.asked).toEqual([
        {
          from: "2026-10-08",
          organizationId: expect.any(String),
          to: "2026-10-14",
        },
      ]);

      await page
        .getByRole("button", { exact: true, name: "Tirar o filtro Período" })
        .click();
      await expect(footer).toContainText(SCREEN_LABEL);
      await expect(footer).toContainText(SUM_OF_ROWS);
      await expect(footer).not.toContainText(PERIOD_LABEL);
      expect(summary.asked).toHaveLength(1);
    });

    test("o (i) abre com as duas frases e Esconder valores mascara o valor novo", async ({
      page,
    }) => {
      await openHistory(page, { asked: [], fail: false });
      await chooseSevenDays(page);
      const footer = footerOf(page);
      await expect(footer).toContainText(NET);

      await footer
        .getByRole("button", { name: "Sobre Vendas líquidas do período" })
        .click();
      const popup = page.getByRole("dialog", {
        name: "Vendas líquidas do período",
      });
      await expect(popup).toContainText(
        "Vendas confirmadas do período, menos descontos e devoluções, até as feitas depois; igual ao Resultado."
      );
      await expect(popup).toContainText(
        "Não é a soma da lista: sem acréscimo, frete e canceladas."
      );
      await page.keyboard.press("Escape");

      await page.evaluate(() => {
        window.localStorage.setItem("polaris-valores", "escondidos");
        window.dispatchEvent(
          new StorageEvent("storage", { key: "polaris-valores" })
        );
      });
      await expect(footer).toContainText(MASKED);
      await expect(footer).not.toContainText(NET);
      await expect(footer).toContainText(PERIOD_LABEL);
    });

    test("com mais de um ano o rodapé fica em 'Total na tela' com a frase do ano e sem chamada ao resumo", async ({
      page,
    }) => {
      const summary: Summary = { asked: [], fail: false };
      await openHistory(page, summary);
      await chooseTypedPeriod(page, "13102025", "14102026");
      const footer = footerOf(page);
      await expect(footer).toContainText(SCREEN_LABEL);
      await expect(footer).toContainText(SUM_OF_ROWS);
      await expect(footer.locator("[data-list-total-note]")).toContainText(
        "O total líquido do período vale para até 1 ano."
      );
      await expect(footer).not.toContainText(PERIOD_LABEL);
      await expect(
        footer.getByRole("button", { name: "Sobre Vendas líquidas do período" })
      ).toHaveCount(0);
      expect(summary.asked).toEqual([]);
    });

    test("quando a leitura falha o rodapé volta ao total na tela com a frase calma e sem vermelho", async ({
      page,
    }) => {
      await openHistory(page, { asked: [], fail: true });
      await chooseSevenDays(page);
      const footer = footerOf(page);
      const note = footer.locator("[data-list-total-note]");
      await expect(note).toContainText(
        "Não foi possível ler o total do período agora."
      );
      await expect(footer).toContainText(SCREEN_LABEL);
      await expect(footer).toContainText(SUM_OF_ROWS);
      await expect(footer).not.toContainText(PERIOD_LABEL);
      await expect(note.getByRole("status")).toContainText("Não foi possível");
      await expect(note).toContainText("1 cancelada fica fora da soma.");
      expect(
        await note
          .getByRole("status")
          .evaluate((element) => getComputedStyle(element).color),
        "cinza, não vermelho"
      ).toBe(
        await footer
          .locator("p")
          .first()
          .evaluate((element) => getComputedStyle(element).color)
      );
    });

    test("sem conexão com período o rodapé é o total na tela com a frase de aviso, e sem chamada ao resumo", async ({
      page,
    }) => {
      const summary: Summary = { asked: [], fail: false };
      await openHistory(page, summary);
      await page.context().setOffline(true);
      await expect(page.getByText("Sem conexão.").first()).toBeVisible({
        timeout: 20_000,
      });
      await chooseSevenDays(page);
      const footer = footerOf(page);
      await expect(footer).toContainText(SCREEN_LABEL);
      await expect(footer).toContainText(
        "Sem conexão: total das vendas guardadas neste aparelho."
      );
      await expect(footer).not.toContainText(PERIOD_LABEL);
      expect(summary.asked).toEqual([]);
    });

    test("a conexão cai depois da leitura: o líquido do servidor sai do rodapé, que volta ao total na tela com a frase de aviso, sem nova chamada", async ({
      page,
    }) => {
      const summary: Summary = { asked: [], fail: false };
      await openHistory(page, summary);
      await chooseSevenDays(page);
      const footer = footerOf(page);
      await expect(footer).toContainText(PERIOD_LABEL);
      await expect(footer).toContainText(NET);
      expect(summary.asked).toHaveLength(1);

      await page.context().setOffline(true);
      await expect(page.getByText("Sem conexão.").first()).toBeVisible({
        timeout: 20_000,
      });
      await expect(footer).toContainText(SCREEN_LABEL);
      await expect(footer).toContainText(
        "Sem conexão: total das vendas guardadas neste aparelho."
      );
      await expect(footer).not.toContainText(PERIOD_LABEL);
      await expect(footer).not.toContainText(NET);
      expect(summary.asked, "a leitura online não se repete").toHaveLength(1);
    });
  });
}

test.describe("a 320 px com letra de 20 px", () => {
  test.use({ viewport: { height: 740, width: 320 } });
  test.skip(
    ({ browserName }) => browserName !== "chromium",
    "`Page.setFontSizes` é um comando do Chrome"
  );

  test("o (i) e o valor não se sobrepõem, o rótulo quebra sem corte e nada passa da borda", async ({
    page,
  }) => {
    const session = await page.context().newCDPSession(page);
    await session.send("Page.setFontSizes", {
      fontSizes: { fixed: 20, standard: 20 },
    });
    let release: (() => void) | undefined;
    const summary: Summary = {
      asked: [],
      fail: false,
      gate: new Promise<void>((resolve) => {
        release = resolve;
      }),
    };
    await openHistory(page, summary);
    await chooseSevenDays(page);
    const footer = footerOf(page);
    const geometry = () =>
      footer.evaluate((element) => {
        const box = element.getBoundingClientRect();
        const tip = element
          .querySelector("[data-slot=help-tip]")
          ?.getBoundingClientRect();
        const label = element.querySelector("p")?.getBoundingClientRect();
        const valueBox = element.querySelector(".tabular-nums");
        const skeleton = valueBox?.querySelector("[data-list-total-skeleton]");
        let value: DOMRect | undefined;
        if (skeleton) {
          value = skeleton.getBoundingClientRect();
        } else if (valueBox) {
          const range = document.createRange();
          range.selectNodeContents(valueBox);
          value = range.getBoundingClientRect();
        }
        const apart = (
          a: DOMRect | undefined,
          b: DOMRect | undefined
        ): boolean =>
          Boolean(
            a &&
              b &&
              (a.right <= b.left ||
                a.left >= b.right ||
                a.bottom <= b.top ||
                a.top >= b.bottom)
          );
        return {
          inside: Boolean(
            tip &&
              value &&
              label &&
              [tip, value, label].every(
                (rect) =>
                  rect.left >= box.left - 0.5 && rect.right <= box.right + 0.5
              )
          ),
          tipApartFromValue: apart(tip, value),
          wholePageFits:
            document.documentElement.scrollWidth <=
            document.documentElement.clientWidth,
        };
      });

    await expect(footer.locator("[data-slot=help-tip]")).toBeVisible();
    const reading = await geometry();
    expect(reading).toMatchObject({
      inside: true,
      tipApartFromValue: true,
      wholePageFits: true,
    });
    const readingHeight = await heightOf(footer);

    release?.();
    await expect(footer).toContainText(NET);
    const read = await geometry();
    expect(read).toMatchObject({
      inside: true,
      tipApartFromValue: true,
      wholePageFits: true,
    });
    expect(
      Math.abs(readingHeight - (await heightOf(footer)))
    ).toBeLessThanOrEqual(1);
    const tip = footer.locator("[data-slot=help-tip]");
    const tipBox = await tip.boundingBox();
    expect(tipBox?.width, "ícone de 24 px visíveis").toBeGreaterThanOrEqual(24);

    await tip.click();
    const popup = page.getByRole("dialog", {
      name: "Vendas líquidas do período",
    });
    await expect(popup).toBeVisible();
    const popupBox = await popup.boundingBox();
    expect(
      popupBox?.x,
      "o texto do (i) cabe na janela, à esquerda"
    ).toBeGreaterThanOrEqual(0);
    expect(
      (popupBox?.x ?? 0) + (popupBox?.width ?? 0),
      "o texto do (i) cabe na janela, à direita"
    ).toBeLessThanOrEqual(320);
  });
});
