import { test } from "@playwright/test";
import { homeStates } from "./ui-home-states";
test.use({ hasTouch: true, isMobile: true, viewport: { width: 360, height: 740 } });
test("tmp", async ({ page }) => {
  await homeStates.error(page);
  await page.screenshot({ path: "/tmp/t314-360-err.png" });
  const info = await page.evaluate(() => {
    const r = (t: string) => [...document.querySelectorAll("a,button")].find((a) => a.textContent?.trim() === t)?.getBoundingClientRect().toJSON();
    const leg = [...document.querySelectorAll("a")].find((a) => a.textContent?.includes("Termos"));
    return { termos: r("Termos de Uso"), inicio: r("Início"), legParent: leg?.parentElement?.parentElement?.className, sh: document.documentElement.scrollHeight, ih: innerHeight };
  });
  console.log(JSON.stringify(info));
});
