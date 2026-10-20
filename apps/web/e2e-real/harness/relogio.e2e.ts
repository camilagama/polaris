import { expect, openJourney, runT0, test } from "../fixtures";

/** The page clock starts at T0 and RUNS: timers fire as in the product (no pauseAt). */
test("o relógio parte de T0 e corre: um setTimeout de 100 ms dispara", async ({ browser }, testInfo) => {
  const { page } = await openJourney(browser, testInfo, "relogio", { organization: false });
  await page.goto("/offline-poc"); // any page of the app; no data needed
  const fired = await page.evaluate(
    () => new Promise<boolean>((resolve) => {
      setTimeout(() => resolve(true), 100);
      setTimeout(() => resolve(false), 5000);
    })
  );
  expect(fired).toBe(true);
  const [first, second] = await page.evaluate(async () => {
    const before = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 200));
    return [before, Date.now()];
  });
  expect(first).toBeGreaterThanOrEqual(runT0());
  expect(first).toBeLessThan(runT0() + 30 * 60_000);
  expect((second as number) - (first as number)).toBeGreaterThanOrEqual(200);
});
