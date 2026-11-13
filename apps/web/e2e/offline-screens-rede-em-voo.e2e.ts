/// <reference lib="dom" />
import type { Page, Route } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { serveLabWorker, WORKER_MARK } from "./worker-mark";

/**
 * The lab's "Rede disponível" switch tells the runtime at once (`connectionChanged`), as the app's scheduler does on
 * the browser's online and offline events. A sync still in flight answers `syncNow()`, so without that call the
 * screens keep the old state until it ends. The order here: hold the Worker call of a sync, switch the network off,
 * and only then let the call go.
 */
const chip = (page: Page) => page.locator(".sync-status");

async function holdWorkerCalls(page: Page) {
  const held: Route[] = [];
  let holding = false;
  await page.route("**/rpc/__screens-lab", async (route) => {
    if (!holding) {
      await route.fallback();
      return;
    }
    held.push(route);
  });
  return {
    arrive: () => expect.poll(() => held.length).toBeGreaterThan(0),
    hold: () => {
      holding = true;
    },
    release: async () => {
      holding = false;
      await Promise.all(
        held.splice(0).map((route) =>
          route.fulfill({
            body: JSON.stringify({ error: { code: "not_found" } }),
            contentType: "application/json",
            headers: { ...WORKER_MARK },
            status: 404,
          })
        )
      );
    },
  };
}

test("Desmarcar a rede com um sync em voo mostra offline na hora e continua offline quando o sync termina", async ({
  page,
}) => {
  await serveLabWorker(page);
  const worker = await holdWorkerCalls(page);
  await page.goto("/offline-screens-lab?screen=customers");
  await page.getByLabel("Usuário").fill(`user-${crypto.randomUUID()}`);
  await page.getByRole("button", { exact: true, name: "Iniciar" }).click();
  await expect(page.getByTestId("message")).toContainText(
    "Iniciar: ok (ready)",
    { timeout: 20_000 }
  );
  await expect(chip(page)).toHaveAttribute("data-tone", "ok");

  worker.hold();
  await page.getByRole("button", { exact: true, name: "Sincronizar" }).click();
  await worker.arrive();

  await page.getByLabel("Rede disponível").uncheck();
  await expect(chip(page)).toHaveAttribute("data-tone", "offline");

  await worker.release();
  await expect(page.getByTestId("message")).toContainText("Sincronizar: ok");
  await expect(chip(page)).toHaveAttribute("data-tone", "offline");
  await expect(page.getByLabel("Rede disponível")).not.toBeChecked();
});
