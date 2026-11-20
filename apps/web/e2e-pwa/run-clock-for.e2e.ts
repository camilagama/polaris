/// <reference lib="dom" />
import { expect } from "@playwright/test";
import { runClockFor } from "../e2e/run-clock-for";
import { test } from "./support";

test.use({ serviceWorkers: "block" });

const REACHED_THE_SERVER =
  /sentinel \/rpc\/settle reached the server, not a route of the test/;

test("runClockFor falha com mensagem clara quando a sentinela não passa por uma rota do teste", async ({
  page,
}) => {
  await page.clock.install();
  await page.goto("/");
  await expect(runClockFor(page, 100)).rejects.toThrow(REACHED_THE_SERVER);
});

test("runClockFor passa quando a rota do teste responde à sentinela", async ({
  page,
}) => {
  await page.clock.install();
  await page.route("**/rpc/settle", (route) =>
    route.fulfill({ body: "{}", contentType: "application/json" })
  );
  await page.goto("/");
  await runClockFor(page, 100);
});

test("runClockFor passa quando a rota do teste recusa a sentinela", async ({
  page,
}) => {
  await page.clock.install();
  await page.route("**/api/auth/get-session", (route) => route.abort("failed"));
  await page.goto("/");
  await runClockFor(page, 100, "/api/auth/get-session");
});

test("runClockFor falha quando a rota deixa a sentinela seguir para o servidor", async ({
  page,
}) => {
  await page.clock.install();
  await page.route("**/rpc/settle", (route) => route.continue());
  await page.goto("/");
  await expect(runClockFor(page, 100)).rejects.toThrow(REACHED_THE_SERVER);
});
