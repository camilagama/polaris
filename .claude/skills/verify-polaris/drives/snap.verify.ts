import { expect, test } from "../drive/fixture";

const NOT_A_NAME = /[^a-z0-9]+/gi;
const TRAILING_DASH = /-$/;
const LOADING = /^Carregando/;

/**
 * `verify.sh snap <caminho>`: opens one address of the app signed in, waits for its main heading and keeps a
 * screenshot and an ARIA snapshot. The quick look before writing a drive, and the first step of a vague report.
 */
test("snap", async ({ evidence, page }) => {
  const address = process.env.VERIFY_URL ?? "/";
  await page.goto(address);
  await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
  // the screens load their data after the shell: wait for the "Carregando…" states to go (or say they stayed)
  await page
    .waitForLoadState("networkidle", { timeout: 10_000 })
    .catch(() => undefined);
  await expect(page.getByText(LOADING)).toHaveCount(0, { timeout: 15_000 });
  const name = `snap${address.replace(NOT_A_NAME, "-").replace(TRAILING_DASH, "")}`;
  await evidence.shot(name, `snap de ${address}`);
});
