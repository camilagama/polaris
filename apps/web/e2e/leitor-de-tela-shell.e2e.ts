/// <reference lib="dom" />

import type { Locator, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { serve } from "./shell-server";

/**
 * What a screen reader gets from the shell, read from the real DOM after hydration: a tab is spoken with its own
 * name and does not point at its panel (the panel is named by the tab), and every control of the bottom bar has a name
 * and none is off. The chip of the header is covered in `src/offline/runtime/runtime-ui.test.tsx`.
 */
const BAR_CONTROLS = ["Início", "Histórico", "Vender", "Estoque", "Mais"];

const UNWANTED_ON_A_TAB = [
  "aria-label",
  "aria-labelledby",
  "aria-describedby",
  "title",
  "aria-controls",
];

const bottomBar = (page: Page) =>
  page.getByRole("navigation", { exact: true, name: "Destinos" });

async function attributeNames(element: Locator): Promise<string[]> {
  return await element.evaluate((node) =>
    node.getAttributeNames().map((name) => name.toLowerCase())
  );
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ height: 740, width: 360 });
});

test("a aba é dita uma vez, com o nome do texto, e não aponta para o painel", async ({
  page,
}) => {
  await serve(page);
  await page.goto("/products?aba=categorias");
  const list = page.getByRole("tablist", { exact: true });
  const tabs = list.first().getByRole("tab");
  await expect(tabs).toHaveText(["Produtos", "Categorias"]);
  const selected = list
    .first()
    .getByRole("tab", { exact: true, name: "Categorias" });
  await expect(selected).toHaveAttribute("aria-selected", "true");
  await expect(selected).toHaveCount(1);
  for (const tab of await tabs.all()) {
    // biome-ignore lint/performance/noAwaitInLoops: two tabs
    const names = await attributeNames(tab);
    for (const unwanted of UNWANTED_ON_A_TAB) {
      expect(names).not.toContain(unwanted);
    }
  }
  const panel = page.getByRole("tabpanel", { exact: true, name: "Categorias" });
  await expect(panel).toHaveCount(1);
  expect(await attributeNames(panel)).toContain("aria-labelledby");
});

test("a barra inferior tem cinco controles, cada um com nome, e nenhum desligado", async ({
  page,
}) => {
  await serve(page);
  await page.goto("/");
  const bar = bottomBar(page);
  await expect(bar).toBeVisible();
  const controls = bar.getByRole("link").or(bar.getByRole("button"));
  await expect(controls).toHaveCount(BAR_CONTROLS.length);
  await expect(controls).toHaveText(BAR_CONTROLS);
  await expect(bar.locator("[disabled], [aria-disabled], [inert]")).toHaveCount(
    0
  );
});
