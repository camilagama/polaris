/// <reference lib="dom" />
import { expect } from "@playwright/test";
import { test } from "./support";
import { serveHome } from "./ui-home-states";

/**
 * "Tentar novamente" of a screen whose chunk did not download. The worker is blocked so the page's own routes
 * see the chunk requests. The Início is the screen: its chunk fails on the way in, and the way out is the button.
 */
test.use({ serviceWorkers: "block" });

const HOME_CHUNK = "**/assets/home-page-*.js";
const FAILED_TITLE = "Algo deu errado nesta tela";
/** A little over `RELOAD_WINDOW_MS` of `app-shell/chunk-load-error.ts`. */
const AFTER_RELOAD_WINDOW_MS = 10_500;

test("um pedaço da tela que não baixou: a tela de erro aparece e Tentar novamente recupera, sem recarregar à mão", async ({
  buildVersion,
  page,
}) => {
  buildVersion("1");
  await serveHome(page, { signedIn: true });
  let asked = 0;
  await page.route(HOME_CHUNK, (route) => {
    asked += 1;
    return asked === 1 ? route.abort("failed") : route.fallback();
  });
  await page.goto("/");
  await expect(page.getByText(FAILED_TITLE)).toBeVisible({ timeout: 20_000 });
  expect(asked).toBe(1);

  await page.getByRole("button", { name: "Tentar novamente" }).click();
  // the page reloads itself once and asks for the chunk again
  await expect(page.getByRole("region", { name: "Hoje" })).toContainText("R$", {
    timeout: 20_000,
  });
  await expect(page.getByText(FAILED_TITLE)).toHaveCount(0);
  expect(asked).toBe(2);
});

test("se o pedaço continua faltando, um clique logo depois do recarregamento não recarrega de novo; passado um tempo, recarrega e recupera", async ({
  buildVersion,
  page,
}) => {
  buildVersion("1");
  await serveHome(page, { signedIn: true });
  let asked = 0;
  await page.route(HOME_CHUNK, (route) => {
    asked += 1;
    return asked <= 2 ? route.abort("failed") : route.fallback();
  });
  await page.goto("/");
  await expect(page.getByText(FAILED_TITLE)).toBeVisible({ timeout: 20_000 });

  // 1st click: reload (the mark is written), the chunk fails again
  await page.getByRole("button", { name: "Tentar novamente" }).click();
  await expect.poll(() => asked, { timeout: 20_000 }).toBe(2);
  await expect(page.getByText(FAILED_TITLE)).toBeVisible();
  await page.evaluate(() => {
    (window as unknown as { stillHere: boolean }).stillHere = true;
  });

  // 2nd click, right after: no second reload (the page is the same), the panel stays
  await page.getByRole("button", { name: "Tentar novamente" }).click();
  await page.waitForTimeout(500);
  await expect(page.getByText(FAILED_TITLE)).toBeVisible();
  expect(
    await page.evaluate(
      () => (window as unknown as { stillHere?: boolean }).stillHere
    )
  ).toBe(true);

  // a while later the click reloads again, and now the chunk is there
  await page.waitForTimeout(AFTER_RELOAD_WINDOW_MS);
  await page.getByRole("button", { name: "Tentar novamente" }).click();
  await expect(page.getByRole("region", { name: "Hoje" })).toContainText("R$", {
    timeout: 20_000,
  });
  expect(asked).toBe(3);
});
