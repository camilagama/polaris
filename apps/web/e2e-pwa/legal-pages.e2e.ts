/// <reference lib="dom" />
import { expect, test } from "@playwright/test";
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
      await page.goto(path);
      const essential = page.getByRole("complementary", {
        name: "O essencial",
      });
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
        page.getByRole("link", { name: "Polaris, início" })
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
