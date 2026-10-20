import { expect, test } from "@playwright/test";
import {
  productionPolicy,
  serveUnderProductionCsp,
  watchCspViolations,
} from "./csp-fixture";

/**
 * The offline store is SQLite compiled to WebAssembly, loaded in a worker. Under
 * the production Content-Security-Policy (the very one in public/_headers, applied
 * here to the documents, scripts and workers of the lab) it must still open.
 *
 * The fixture (csp-fixture.ts) also fails on any `securitypolicyviolation` event and on any CSP
 * console error (ADR 0103, condition 2); the control test proves it catches an injected `<style>`.
 */
const pending = /…/;

test("o armazenamento local abre sob a CSP de produção", async ({ page }) => {
  expect(productionPolicy).toContain("default-src 'self'");
  await serveUnderProductionCsp(page);
  const csp = await watchCspViolations(page);
  const violations: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      violations.push(message.text().slice(0, 200));
    }
  });
  await page.goto("/offline-local-lab");
  await page.getByLabel("Usuário").fill(`csp-${crypto.randomUUID()}`);
  await page.getByLabel("Organização").fill("org-1");
  await page.getByRole("button", { exact: true, name: "Sincronizar" }).click();
  await expect
    .poll(
      async () => pending.test(await page.getByTestId("message").innerText()),
      {
        timeout: 30_000,
      }
    )
    .toBe(false);
  await expect(page.getByTestId("message")).toContainText("concluído");
  expect(violations).toEqual([]);
  expect(csp.violations()).toEqual([]);
});

test("controle: a fixture pega um <style> injetado sob a CSP de produção", async ({
  page,
}) => {
  await serveUnderProductionCsp(page);
  const csp = await watchCspViolations(page);
  await page.goto("/offline-local-lab");
  expect(csp.violations()).toEqual([]);

  await page.evaluate(() => {
    const style = document.createElement("style");
    style.textContent = "body { outline: 1px solid red; }";
    document.head.append(style);
  });

  await expect.poll(() => csp.events().length).toBeGreaterThan(0);
  expect(csp.events().join(" ")).toContain("style-src");
  // The console error is printed apart from the event; both channels must catch it.
  await expect.poll(() => csp.consoleErrors().length).toBeGreaterThan(0);
  expect(csp.violations().length).toBeGreaterThanOrEqual(2);
});

test("controle: um eval fora da lista de conhecidos também é pego", async ({
  page,
}) => {
  await serveUnderProductionCsp(page);
  const csp = await watchCspViolations(page);
  await page.goto("/offline-local-lab");
  expect(csp.violations()).toEqual([]);

  // Code run through the test driver is not subject to the policy, so the eval goes in a script of the
  // origin (allowed by script-src 'self'), as the page's own code would.
  await page.route("**/csp-control.js", (route) =>
    route.fulfill({
      body: 'try { eval("1 + 1"); } catch {}',
      contentType: "text/javascript",
    })
  );
  await page.evaluate(() => {
    const script = document.createElement("script");
    script.src = "/csp-control.js";
    document.head.append(script);
  });

  await expect.poll(() => csp.events().length).toBeGreaterThan(0);
  expect(csp.events().join(" ")).toContain("script-src blocked eval");
});
