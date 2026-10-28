/// <reference lib="dom" />
import type { Page, Route } from "@playwright/test";
import { expect } from "@playwright/test";
import {
  checkForUpdate,
  markPage,
  openControlled,
  runningVersion,
  setVisibility,
  stillHere,
  test,
  waitForWaiting,
} from "./support";
import { serveHome } from "./ui-home-states";
import { WORKER_MARK } from "./worker-mark";

/**
 * The moments of the swap that take time (ADR 0041, emenda de 28/10/2026), with the page's clock driven by the test
 * (`page.clock`; the worker keeps the real one): the return after 5 min away swaps before the first touch; the tab in
 * front and idle for 15 min swaps only a build waiting for more than 24 h, and comes back to the same scroll; a build
 * published less than 2 h ago never goes in. The rest of the swap is in `update.e2e.ts`.
 */
const HOUR = 60 * 60 * 1000;
const HOLD_MS = 2500;
const SALE_ADDRESS = /\/sales$/;

const rpc = (body: unknown) => ({
  body: JSON.stringify({ json: body, meta: [] }),
  contentType: "application/json",
  headers: { ...WORKER_MARK },
});

/** Version 1 open and controlled under a clock the test moves, signed in, with the sale's search answered. */
async function openVersion1(
  page: Page,
  buildVersion: (variant: string, options?: { publishedAt?: number }) => void,
  path = "/"
) {
  buildVersion("1");
  await page.clock.install();
  await serveHome(page, { signedIn: true });
  await page.route("**/rpc/paymentProfile/list", (route: Route) =>
    route.fulfill(rpc({ profiles: [] }))
  );
  await openControlled(page);
  if (path !== "/") {
    await page.goto(path);
  }
  await markPage(page);
}

test("de volta depois de 5 min fora, a build nova entra antes do primeiro toque", async ({
  buildVersion,
  page,
}) => {
  await openVersion1(page, buildVersion);
  await setVisibility(page, "hidden");
  await page.clock.fastForward("06:00");
  // published while the app was in the background; the page finds it as it comes back
  buildVersion("2");
  await setVisibility(page, "visible");
  await expect.poll(() => runningVersion(page), { timeout: 30_000 }).toBe("2");
  expect(await stillHere(page)).toBe(false);
});

test("de volta depois de 5 min, o primeiro toque fecha a janela: a build fica para o próximo momento", async ({
  buildVersion,
  page,
}) => {
  await openVersion1(page, buildVersion);
  await setVisibility(page, "hidden");
  await page.clock.fastForward("06:00");
  buildVersion("2");
  await setVisibility(page, "visible");
  await page.mouse.click(5, 5);
  await waitForWaiting(page);
  await page.waitForTimeout(HOLD_MS);
  expect(await runningVersion(page)).toBe("1");
  expect(await stillHere(page)).toBe(true);
});

test("de volta depois de menos de 5 min, nada troca com a aba à vista", async ({
  buildVersion,
  page,
}) => {
  await openVersion1(page, buildVersion);
  buildVersion("2");
  await checkForUpdate(page);
  await waitForWaiting(page);
  // hidden and back at once: the hidden moment is held by a dialog of the page itself
  await page.evaluate(() => {
    const dialog = document.createElement("dialog");
    document.body.append(dialog);
    dialog.show();
    (window as unknown as { held: HTMLDialogElement }).held = dialog;
  });
  await setVisibility(page, "hidden");
  await page.clock.fastForward("04:00");
  await page.evaluate(() =>
    (window as unknown as { held: HTMLDialogElement }).held.close()
  );
  await setVisibility(page, "visible");
  await page.waitForTimeout(HOLD_MS);
  expect(await runningVersion(page)).toBe("1");
  expect(await stillHere(page)).toBe(true);
});

test("a aba à vista e ociosa por 15 min não troca uma build esperando há menos de 24 h", async ({
  buildVersion,
  page,
}) => {
  await openVersion1(page, buildVersion);
  buildVersion("2", { publishedAt: Date.now() - 23 * HOUR });
  await checkForUpdate(page);
  await waitForWaiting(page);
  await page.clock.fastForward("16:00");
  await page.waitForTimeout(HOLD_MS);
  expect(await runningVersion(page)).toBe("1");
  expect(await stillHere(page)).toBe(true);
});

test("a aba à vista e ociosa por 15 min troca uma build esperando há mais de 24 h, e volta no mesmo endereço e na mesma rolagem", async ({
  buildVersion,
  page,
}) => {
  await openVersion1(page, buildVersion, "/sales");
  await page
    .getByRole("heading", { exact: true, name: "Nova venda" })
    .waitFor();
  await page.evaluate(() => window.scrollTo(0, 300));
  const scrolled = await page.evaluate(() => window.scrollY);
  expect(scrolled).toBeGreaterThan(100);
  buildVersion("2", { publishedAt: Date.now() - 25 * HOUR });
  await checkForUpdate(page);
  await waitForWaiting(page);
  // ten minutes idle is not enough
  await page.clock.fastForward("10:00");
  await page.waitForTimeout(HOLD_MS);
  expect(await runningVersion(page)).toBe("1");

  await page.clock.fastForward("06:00");
  await expect.poll(() => runningVersion(page), { timeout: 30_000 }).toBe("2");
  await expect(page).toHaveURL(SALE_ADDRESS);
  await expect
    .poll(() => page.evaluate(() => window.scrollY), { timeout: 10_000 })
    .toBe(scrolled);
  // the scroll is not left in the history for a later load
  expect(
    await page.evaluate(
      () =>
        (history.state as Record<string, unknown> | null)?.polarisSwapScroll ??
        null
    )
  ).toBeNull();
});

test("uma build publicada há menos de 2 h não entra; passadas as 2 h, entra no próximo momento", async ({
  buildVersion,
  page,
}) => {
  await openVersion1(page, buildVersion);
  buildVersion("2", { publishedAt: Date.now() - 30 * 60 * 1000 });
  await checkForUpdate(page);
  await waitForWaiting(page);
  await setVisibility(page, "hidden");
  await page.waitForTimeout(HOLD_MS);
  expect(await runningVersion(page)).toBe("1");
  expect(await stillHere(page)).toBe(true);

  await setVisibility(page, "visible");
  await page.clock.fastForward("01:45:00");
  await setVisibility(page, "hidden");
  await expect.poll(() => runningVersion(page), { timeout: 30_000 }).toBe("2");
});
