/// <reference lib="dom" />
import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

/**
 * The offline store is SQLite compiled to WebAssembly, loaded in a worker. Under
 * the production Content-Security-Policy (the very one in public/_headers, applied
 * here to the documents, scripts and workers of the lab) it must still open.
 */
const headers = readFileSync(
  new URL("../public/_headers", import.meta.url),
  "utf8"
);
const policy = /Content-Security-Policy: (.*)/.exec(headers)?.[1] ?? "";
const pending = /…/;

test("o armazenamento local abre sob a CSP de produção", async ({ page }) => {
  expect(policy).toContain("default-src 'self'");
  await page.route("**/*", async (route) => {
    const response = await route.fetch();
    const responseHeaders = { ...response.headers() };
    if (
      ["document", "other", "script"].includes(route.request().resourceType())
    ) {
      responseHeaders["content-security-policy"] = policy;
    }
    await route.fulfill({ headers: responseHeaders, response });
  });
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
});
