/// <reference lib="dom" />
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { serve } from "./shell-server";

const SCREEN_READER_ONLY = /sr-only/;
const CUSTOMERS_CHUNK = /customers-page[^/]*\.js/;
const EXPENSE_LIST = "**/rpc/expense/list";
const VIEWPORTS = [
  { height: 740, minNoteHeight: 84, width: 360 },
  { height: 800, minNoteHeight: 66, width: 1280 },
] as const;

/** The text a sighted person reads: `innerText` also counts the `sr-only` clip, so a text in a 1 px box is left out. */
const visibleText = (page: Page) =>
  page.evaluate(() => {
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT
    );
    const drawn: string[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const box = node.parentElement?.getBoundingClientRect();
      if (box && (box.width > 1 || box.height > 1) && node.textContent) {
        drawn.push(node.textContent);
      }
    }
    return drawn.join(" ");
  });

function hold() {
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { held, release };
}

for (const viewport of VIEWPORTS) {
  test.describe(`carregando só para o leitor de tela a ${viewport.width} px`, () => {
    test.use({ viewport: { height: viewport.height, width: viewport.width } });

    test("a troca de tela espera o código com o esqueleto, sem a palavra Carregando à vista, e o status tem nome", async ({
      page,
    }) => {
      const { held, release } = hold();
      await page.route(CUSTOMERS_CHUNK, async (route) => {
        await held;
        await route.continue();
      });
      await serve(page);
      await page.goto("/customers");
      const status = page
        .getByRole("status")
        .filter({ hasText: "Carregando…" });
      await expect(status).toBeAttached();
      await expect(
        status.locator('[data-slot="skeleton"]').first()
      ).toBeVisible();
      expect(await visibleText(page)).not.toContain("Carregando");
      await expect(page.getByText("Carregando…", { exact: true })).toHaveClass(
        SCREEN_READER_ONLY
      );
      release();
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    });

    test("Despesas lê a lista com o status nomeado e sem a frase à vista", async ({
      page,
    }) => {
      const { held, release } = hold();
      await page.route(EXPENSE_LIST, async (route) => {
        await held;
        await route.abort("internetdisconnected");
      });
      await serve(page);
      await page.goto("/dashboard?aba=despesas");
      const status = page
        .getByRole("status")
        .filter({ hasText: "Carregando despesas…" });
      await expect(status).toBeAttached();
      expect(await visibleText(page)).not.toContain("Carregando");
      const box = await status.boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(viewport.minNoteHeight);
      release();
    });
  });
}
