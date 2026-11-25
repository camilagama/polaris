/// <reference lib="dom" />
import { expect, test } from "@playwright/test";
import {
  assertNoPageScroll,
  assertNothingClipped,
  expectReflowFont,
  openReflowViewport,
  reflowTest,
  skipOutsideChromium,
} from "../e2e/reflow";
import { openControlled } from "./support";

const pages = [
  { path: "/privacidade", title: "Política de Privacidade" },
  { path: "/termos", title: "Termos de Uso" },
];

for (const { path, title } of pages) {
  test.describe(path, () => {
    test("abre sem login, sem menu da loja e sem pedir nada ao servidor", async ({
      context,
      page,
    }) => {
      const requests: string[] = [];
      page.on("request", (request) => requests.push(request.url()));

      const response = await page.goto(path);
      expect(response?.status()).toBe(200);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(title);
      await expect(page).toHaveTitle(`${title} · Polaris`);
      await expect(page.getByText("Versão 1. Em vigor desde:")).toBeVisible();
      await expect(
        page.getByRole("navigation", { name: "Sumário" })
      ).toBeVisible();
      await expect(
        page.getByRole("navigation", { name: "Principal" })
      ).toHaveCount(0);

      const url = new URL(page.url());
      for (const request of requests) {
        const { origin, pathname } = new URL(request);
        expect(origin).toBe(url.origin);
        expect(pathname.startsWith("/api/")).toBe(false);
        expect(pathname.startsWith("/rpc/")).toBe(false);
      }
      expect(await context.cookies()).toEqual([]);
      expect(await page.evaluate(() => localStorage.length)).toBe(0);
      await expect(
        page.locator("form, input, script[src^='http']")
      ).toHaveCount(0);
    });

    test("a 360 px não rola de lado e os links do sumário têm 44 px", async ({
      page,
    }) => {
      await page.setViewportSize({ height: 800, width: 360 });
      await page.goto(path);
      // the title shows while the text still loads: wait for the text
      await expect(page.getByText("Versão 1. Em vigor desde:")).toBeVisible();

      const overflow = await page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth
      );
      expect(overflow).toBeLessThanOrEqual(0);

      const links = page
        .getByRole("navigation", { name: "Sumário" })
        .getByRole("link");
      expect(await links.count()).toBeGreaterThan(5);
      const heights = await links.evaluateAll((elements) =>
        elements.map((element) => element.getBoundingClientRect().height)
      );
      for (const height of heights) {
        expect(height).toBeGreaterThanOrEqual(44);
      }
    });

    test.describe("a 320 px com a letra do navegador em 20 px", () => {
      skipOutsideChromium();

      reflowTest("não rola de lado e nada é cortado", async ({ page }) => {
        await openReflowViewport(page);
        await page.goto(path);
        await expect(page.getByText("Versão 1. Em vigor desde:")).toBeVisible();
        await expectReflowFont(page);
        await assertNoPageScroll(page);
        await assertNothingClipped(page.locator("main"));
        const summary = page.getByRole("navigation", { name: "Sumário" });
        await assertNothingClipped(summary);
        const heights = await summary
          .getByRole("link")
          .evaluateAll((links) =>
            links.map((link) => link.getBoundingClientRect().height)
          );
        expect(heights.length).toBeGreaterThan(5);
        for (const height of heights) {
          expect(height).toBeGreaterThanOrEqual(44);
        }
      });

      reflowTest("um link do sumário leva à seção", async ({ page }) => {
        await openReflowViewport(page);
        await page.goto(path);
        await expect(page.getByText("Versão 1. Em vigor desde:")).toBeVisible();
        await expectReflowFont(page);
        const first = page
          .getByRole("navigation", { name: "Sumário" })
          .getByRole("link")
          .nth(1);
        const heading = await first.textContent();
        await first.click();
        const section = page.getByRole("heading", {
          level: 2,
          name: heading ?? "",
        });
        await expect(section).toBeInViewport();
        await assertNothingClipped(section.locator("xpath=.."));
        await assertNoPageScroll(page);
      });
    });

    test("um link do sumário leva à seção", async ({ page }) => {
      await page.goto(path);
      const first = page
        .getByRole("navigation", { name: "Sumário" })
        .getByRole("link")
        .nth(1);
      const heading = await first.textContent();
      await first.click();
      await expect(
        page.getByRole("heading", { level: 2, name: heading ?? "" })
      ).toBeInViewport();
    });

    test('o quadro "O essencial" vem antes do sumário e cada seção volta a ele', async ({
      page,
    }) => {
      await page.setViewportSize({ height: 800, width: 360 });
      await page.goto(path);
      const essential = page.getByRole("note", { name: "O essencial" });
      await expect(essential).toBeVisible();
      const summary = page.getByRole("navigation", { name: "Sumário" });
      const [essentialBox, summaryBox] = await Promise.all([
        essential.boundingBox(),
        summary.boundingBox(),
      ]);
      expect(essentialBox?.y ?? Number.POSITIVE_INFINITY).toBeLessThan(
        summaryBox?.y ?? 0
      );

      const back = page.getByRole("link", { name: "Voltar ao sumário" });
      await back.nth(2).scrollIntoViewIfNeeded();
      await back.nth(2).click();
      await expect(summary).toBeInViewport();
    });

    test("se o texto não carrega, a página mostra a marca, o título e o erro", async ({
      page,
    }) => {
      await page.route("**/assets/legal-page-*.js", (route) => route.abort());
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(title);
      await expect(
        page.getByRole("link", { exact: true, name: "Polaris" })
      ).toBeVisible();
      await expect(page.getByRole("alert")).toContainText("Tente de novo");
      await expect(
        page.getByRole("button", { name: "Tentar novamente" })
      ).toBeVisible();
    });

    test("enquanto o texto carrega, a página já mostra a marca e o título", async ({
      page,
    }) => {
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      await page.route("**/assets/legal-page-*.js", async (route) => {
        await gate;
        await route.continue();
      });
      await page.goto(path, { waitUntil: "commit" });
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(title);
      await expect(page.getByRole("status")).toHaveText("Carregando…");
      release();
      await expect(page.getByText("Versão 1. Em vigor desde:")).toBeVisible();
    });

    test("abre sem rede depois de o app ser instalado", async ({
      context,
      page,
    }) => {
      await openControlled(page);
      await context.setOffline(true);
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(title);
      await expect(page.getByText("Versão 1. Em vigor desde:")).toBeVisible();
      await expect(page.getByRole("alert")).toHaveCount(0);
    });
  });
}

const CARD_WINDOWS = [
  { fontPixels: 16, width: 360 },
  { fontPixels: 20, width: 320 },
] as const;

test.describe("/privacidade: a tabela no celular é um cartão por linha", () => {
  skipOutsideChromium();

  for (const { fontPixels, width } of CARD_WINDOWS) {
    reflowTest(
      `a ${width} px com letra de ${fontPixels} px cada célula mostra o rótulo da sua coluna`,
      async ({ page }) => {
        await openReflowViewport(page, { fontPixels, width });
        await page.goto("/privacidade");
        await expect(page.getByText("Versão 1. Em vigor desde:")).toBeVisible();
        await expectReflowFont(page, fontPixels);

        const table = page.locator("main table").first();
        await expect(table).toBeVisible();
        const headers = await table
          .locator("thead th")
          .evaluateAll((cells) => cells.map((cell) => cell.textContent ?? ""));
        expect(headers.length).toBeGreaterThan(1);

        const header = await table.locator("thead").evaluate((element) => {
          const box = element.getBoundingClientRect();
          return {
            height: box.height,
            position: getComputedStyle(element).position,
          };
        });
        expect(
          header.position,
          "o cabeçalho sai da vista e fica para o leitor de tela"
        ).toBe("absolute");
        expect(header.height).toBeLessThanOrEqual(1);

        const rows = await table.locator("tbody tr").evaluateAll((elements) =>
          elements.map((row) => {
            const rowStyle = getComputedStyle(row);
            return {
              cells: [...row.querySelectorAll("td")].map((cell) => {
                const label = getComputedStyle(cell, "::before");
                return {
                  attribute: cell.getAttribute("data-label"),
                  display: getComputedStyle(cell).display,
                  label: label.content.replace(/^"|"$/g, ""),
                  labelDisplay: label.display,
                };
              }),
              display: rowStyle.display,
              width: row.getBoundingClientRect().width,
            };
          })
        );
        expect(rows.length).toBeGreaterThan(3);
        const tableWidth = (await table.boundingBox())?.width ?? 0;
        for (const row of rows) {
          expect(
            row.display,
            "a linha é um bloco, não uma linha de tabela"
          ).toBe("block");
          expect(row.width).toBeLessThanOrEqual(tableWidth + 1);
          expect(row.cells.map((cell) => cell.display)).toEqual(
            headers.map(() => "block")
          );
          for (const [column, cell] of row.cells.entries()) {
            expect(cell.attribute).toBe(headers[column]);
            if (column === 0) {
              expect(
                cell.label,
                "a primeira célula é o título do cartão, sem rótulo"
              ).not.toBe(headers[0]);
              continue;
            }
            expect(cell.label).toBe(headers[column]);
            expect(cell.labelDisplay).toBe("block");
          }
        }
        await assertNoPageScroll(page);
        await assertNothingClipped(table);
      }
    );
  }
});
