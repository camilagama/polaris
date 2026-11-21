/// <reference lib="dom" />

import type { Locator } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { axeFaults } from "../../e2e-pwa/ui-guardrails/measures";
import {
  assertNoPageScroll,
  assertNothingClipped,
  expectReflowFont,
  openReflowViewport,
  reflowTest,
} from "../reflow";
import {
  FakeServer,
  goal,
  openHome,
  placeOf,
  readsEnded,
  region,
  SOLD,
} from "./shared";

/**
 * O traço e a palavra do ritmo da Meta no anel do Início, com 22 dos 31 dias do período já passados: o esperado até
 * hoje é 22 ÷ 31 do alvo.
 */
const EXPECTED_SHARE = 22 / 31;

const progress = (percent: string, value = "2670.60") => ({
  percent,
  periodEnded: false,
  reached: false,
  value,
});

const withGoal = (overrides: Record<string, unknown>) =>
  new FakeServer({ ...SOLD, goals: [goal(overrides)] });

/** Where the mark of the ring ends, as the share of the way round from where the arc begins (9 o'clock). */
async function markShare(ring: Locator) {
  return await ring.locator("[data-ring-marker]").evaluate((svg) => {
    const paths = svg.querySelectorAll("path");
    const line = paths.item(paths.length - 1) as SVGPathElement;
    const end = line.getPointAtLength(line.getTotalLength());
    const center = Number(svg.getAttribute("width")) / 2;
    const angle = Math.atan2(end.x - center, -(end.y - center));
    const share = (angle + Math.PI / 2) / (2 * Math.PI);
    return share < 0 ? share + 1 : share;
  });
}

test.describe("o ritmo da Meta no anel do Início", () => {
  for (const [percent, word] of [
    ["53.4", "Atrasada"],
    ["68.0", "No ritmo"],
    ["80.0", "Adiantada"],
  ] as const) {
    test(`com ${percent}% atingido e 71% esperado: o traço marca 22 de 31 dias e a palavra é "${word}", escrita e no nome do anel`, async ({
      page,
    }) => {
      await page.setViewportSize({ height: 800, width: 1280 });
      await openHome(page, withGoal({ progress: progress(percent) }));
      const meta = region(page, "Meta");
      const ring = meta.getByRole("img");
      await expect(ring.locator("[data-ring-marker]")).toBeAttached();
      expect(await markShare(ring)).toBeCloseTo(EXPECTED_SHARE, 3);
      await expect(meta.locator("[data-pace]")).toHaveText(word);
      await expect(ring).toHaveAttribute(
        "aria-label",
        new RegExp(`\\. ${word}: o esperado até hoje era 71%\\.$`)
      );
      await expect(ring.locator("[data-ring-marker]")).toHaveAttribute(
        "aria-hidden",
        "true"
      );
      await expect(
        meta.locator("[data-pace] svg[aria-hidden=true]")
      ).toHaveCount(1);
      expect(await axeFaults(page, "#home-goal")).toEqual([]);
    });
  }

  test("sem traço nem palavra: meta pausada, período sem progresso lido e primeiro dia do período", async ({
    page,
  }) => {
    const server = withGoal({ paused: true, progress: null });
    await openHome(page, server);
    const meta = region(page, "Meta");
    await expect(meta).toContainText("Pausada pelo plano");
    await expect(meta.locator("[data-ring-marker]")).toHaveCount(0);
    await expect(meta.locator("[data-pace]")).toHaveCount(0);

    server.scenario = {
      ...SOLD,
      goals: [goal({ endsOn: "2026-10-31", startsOn: "2026-10-23" })],
    };
    await page.reload();
    await expect(meta.getByRole("img")).toBeVisible();
    await expect(meta.locator("[data-ring-marker]")).toHaveCount(0);
    await expect(meta.locator("[data-pace]")).toHaveText("");
    await expect(meta.getByRole("img")).not.toHaveAttribute(
      "aria-label",
      SPOKEN_PACE
    );
  });

  for (const viewport of [
    { height: 800, width: 1280 },
    { height: 740, width: 360 },
  ]) {
    test(`a altura do bloco Meta é a mesma com e sem a palavra, a ${viewport.width} px`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      const server = withGoal({});
      await openHome(page, server);
      const meta = region(page, "Meta");
      await expect(meta.locator("[data-pace]")).toHaveText("Atrasada");
      const withWord = (await placeOf(meta)).height;
      server.scenario = {
        ...SOLD,
        goals: [goal({ endsOn: "2026-10-31", startsOn: "2026-10-23" })],
      };
      await page.reload();
      await expect(meta.locator("[data-pace]")).toHaveText("");
      expect(Math.abs((await placeOf(meta)).height - withWord)).toBeLessThan(1);
    });
  }

  test("nenhuma requisição a mais: o Início lê o que lia", async ({ page }) => {
    const server = withGoal({});
    await openHome(page, server);
    await readsEnded(page);
    const procedures = server.calls.map((call) => call.procedure);
    const perProcedure: Record<string, number> = {};
    for (const name of procedures) {
      perProcedure[name] = (perProcedure[name] ?? 0) + 1;
    }
    expect(perProcedure).toEqual(EXPECTED_READS);
  });
});

async function expectInside(inner: Locator, outer: Locator) {
  const [a, b] = await Promise.all([inner.boundingBox(), outer.boundingBox()]);
  expect(a && b).toBeTruthy();
  expect((a?.x ?? 0) + (a?.width ?? 0)).toBeLessThanOrEqual(
    (b?.x ?? 0) + (b?.width ?? 0) + 1
  );
  expect(a?.x ?? 0).toBeGreaterThanOrEqual((b?.x ?? 0) - 1);
}

test.describe("Meta a 320 px com a letra do navegador em 20 px", () => {
  reflowTest(
    "a palavra do ritmo e o percentual da meta sem corte nem rolagem",
    async ({ page }) => {
      await openReflowViewport(page, { fontPixels: 20, width: 320 });
      await openHome(page, withGoal({}));
      await expectReflowFont(page, 20);
      const meta = region(page, "Meta");
      await expect(meta.locator("[data-pace]")).toHaveText("Atrasada");
      await expect(meta.getByRole("img")).toContainText("53,4%");
      await assertNothingClipped(meta);
      await assertNoPageScroll(page);
      await expectInside(meta.locator("[data-pace]"), meta);
    }
  );
});

const SPOKEN_PACE = /esperado/;

const EXPECTED_READS: Record<string, number> = {
  "goal/list": 1,
  "inventory/listBalances": 1,
  "report/dailySales": 1,
  "report/periodSummary": 2,
};
