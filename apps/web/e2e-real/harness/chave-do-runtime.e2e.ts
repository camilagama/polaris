import { readFileSync } from "node:fs";
import { expect, openJourney, test } from "../fixtures";

const MODULE_SCRIPT_SRC = /<script type="module"[^>]*src="([^"]+)"/;

/**
 * Each project says which side of VITE_OFFLINE_RUNTIME_ENABLED it proves, and that its preview serves its own
 * build (the two builds share the plugin's deploy pointer: serve.ts).
 */
test("a chave do runtime offline é a do projeto, e o preview serve o build do projeto", async ({
  browser,
  request,
}, testInfo) => {
  const enabled = testInfo.project.name === "runtime-ligado";
  const served = await (await request.get("/")).text();
  const built = readFileSync(
    new URL(
      `../../dist-e2e/${testInfo.project.name}/client/index.html`,
      import.meta.url
    ),
    "utf8"
  );
  const script = (html: string) => MODULE_SCRIPT_SRC.exec(html)?.[1];
  expect(script(served)).toBeTruthy();
  expect(script(served)).toBe(script(built));

  const { page } = await openJourney(browser, testInfo, "chave");
  const registered = page
    .waitForRequest((r) => r.url().includes("/rpc/device/register"), {
      timeout: 15_000,
    })
    .then(
      () => true,
      () => false
    );
  await page.goto("/");
  await expect(
    page.getByRole("navigation").getByRole("link", { name: "Vender" }).first()
  ).toBeVisible();
  // Aparelhos is a tab of Minha conta, there only with the offline runtime on; without it Senha is alone, with no strip
  await page.goto("/conta");
  await expect(
    page.getByRole("heading", { level: 1, name: "Minha conta" })
  ).toBeVisible();
  const accountTabs = page.getByRole("tablist", { name: "Minha conta" });
  if (enabled) {
    await expect(
      accountTabs.getByRole("tab", { exact: true, name: "Aparelhos" })
    ).toHaveCount(1);
  } else {
    await expect(accountTabs).toHaveCount(0);
    await expect(
      page.getByRole("tab", { exact: true, name: "Aparelhos" })
    ).toHaveCount(0);
  }
  expect(await registered).toBe(enabled);
});
