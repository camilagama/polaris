/// <reference lib="dom" />
import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import {
  expectBadgesAtRight,
  expectBadgesBelow,
  expectTiles,
  rowGeometries,
} from "./lista-selo";
import {
  assertNoEllipsis,
  assertNoPageScroll,
  assertNothingClipped,
  expectReflowFont,
  openReflowViewport,
  reflowTest,
  skipOutsideChromium,
} from "./reflow";
import { serveLabWorker, WORKER_MARK } from "./worker-mark";

/**
 * The rows of Aparelhos and Formas de receber (the one of Clientes is in `clientes-reflow.e2e.ts`): the 36 px square
 * with a 16 px icon, the state badge at the right end of the row on a wide window, all at the same x, and under the
 * name, at the left of the text, on a phone or with the browser font at 20 px (AC-1.1, AC-1.3, AC-1.4).
 */
skipOutsideChromium();

const WIDE_WINDOW = 1280;
const PHONE = 360;
const READ = 16;
const LARGE = 20;
const NARROWEST = 320;
const NOW = new Date("2026-10-14T12:00:00-03:00");
const ORGANIZATION_ID = "0199c2d0-0000-7000-8000-00000000a001";
const rpc = (body: unknown) => ({
  body: JSON.stringify({ json: body, meta: [] }),
  contentType: "application/json",
  headers: { ...WORKER_MARK },
});
const uuid = (n: number) =>
  `0199c2d0-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const fee = (mode: string, percentage: string | null) => ({
  fixedAmount: null,
  mode,
  percentage,
});
const rule = (n: number, method: string) => ({
  anticipationFee: fee("none", null),
  expectedSettlementDays: 1,
  id: `rule-${n}-${method}`,
  installmentPlan: null,
  installments: null,
  method,
  processingFee: fee("percentage", "1.000000"),
});
const profile = (
  n: number,
  name: string,
  status: string,
  rules: unknown[]
) => ({
  archivedAt: status === "archived" ? NOW.toISOString() : null,
  createdAt: NOW.toISOString(),
  id: uuid(3072 + n),
  name,
  organizationId: ORGANIZATION_ID,
  rules,
  status,
  updatedAt: NOW.toISOString(),
  version: 1,
});
const PROFILES = [
  profile(1, "Maquininha da loja", "active", [rule(1, "pix"), rule(2, "cash")]),
  profile(
    2,
    "Link de pagamento da loja antiga com um nome bem comprido",
    "archived",
    [rule(3, "bank_transfer")]
  ),
];
const device = (n: number, label: string | null, lastSeenAt: string) => ({
  createdAt: "2026-10-01T12:00:00.000Z",
  id: uuid(n),
  label,
  lastSeenAt,
  revokedAt: null,
});
const DEVICES = [
  device(7001, "Chrome no Android", "2026-10-14T10:00:00.000Z"),
  device(2, "Celular da Ana", "2026-10-13T10:00:00.000Z"),
];

async function startLab(page: Page, screen: string) {
  await page.clock.setFixedTime(NOW);
  await serveLabWorker(page);
  await page.goto(`/offline-screens-lab?screen=${screen}`);
  await page.getByLabel("Usuário").fill(`lista-${crypto.randomUUID()}`);
  await page.getByRole("button", { exact: true, name: "Iniciar" }).click();
  await expect(page.getByTestId("message")).toContainText(
    "Iniciar: ok (ready)",
    { timeout: 20_000 }
  );
}

async function openProfiles(page: Page, width: number, fontPixels: number) {
  await openReflowViewport(page, { fontPixels, width });
  await page.route("**/rpc/paymentProfile/list", (route) =>
    route.fulfill(rpc({ profiles: PROFILES }))
  );
  await startLab(page, "payment-profiles");
  await page.getByRole("checkbox", { name: "Incluir arquivados" }).check();
  await expect(page.locator("[data-profile-id]")).toHaveCount(PROFILES.length);
  await expectReflowFont(page, fontPixels);
}

async function openDevices(page: Page, width: number, fontPixels: number) {
  await openReflowViewport(page, { fontPixels, width });
  await page.route("**/api/auth-methods", (route) =>
    route.fulfill({
      body: JSON.stringify({
        emailPassword: true,
        google: true,
        turnstileSiteKey: null,
      }),
      contentType: "application/json",
    })
  );
  await page.route("**/rpc/device/list", (route) =>
    route.fulfill(rpc({ devices: DEVICES }))
  );
  await startLab(page, "devices");
  await expect(page.getByText("Celular da Ana")).toBeVisible();
  await expect(page.getByText("Este aparelho", { exact: true })).toBeVisible();
  await expectReflowFont(page, fontPixels);
}

const PROFILE_ROW = "[data-profile-id]";
const DEVICE_ROW = "ul:has(> li [data-row-tile]) > li";

reflowTest(
  "Formas de receber: o quadro de 36 px e o selo no mesmo x a 1280 px",
  async ({ page }) => {
    await openProfiles(page, WIDE_WINDOW, READ);
    await expectTiles(page, PROFILE_ROW);
    const rows = await rowGeometries(page, PROFILE_ROW);
    expect(rows.map(({ badgeText }) => badgeText)).toEqual([
      "Ativo",
      "Arquivado",
    ]);
    expectBadgesAtRight(rows);
  },
  { coarse: false }
);

reflowTest(
  "Aparelhos: o quadro de 36 px e o selo à direita a 1280 px",
  async ({ page }) => {
    await openDevices(page, WIDE_WINDOW, READ);
    await expectTiles(page, DEVICE_ROW);
    expectBadgesAtRight(await rowGeometries(page, DEVICE_ROW), 1);
  },
  { coarse: false }
);

for (const [width, font] of [
  [PHONE, READ],
  [NARROWEST, LARGE],
] as const) {
  reflowTest(
    `Formas de receber a ${width} px com letra de ${font} px: o selo desce sob o nome e nada se corta`,
    async ({ page }) => {
      await openProfiles(page, width, font);
      await expectTiles(page, PROFILE_ROW);
      expectBadgesBelow(await rowGeometries(page, PROFILE_ROW), 2);
      const list = page.locator("main");
      await assertNothingClipped(list);
      await assertNoEllipsis(list.locator(PROFILE_ROW));
      await assertNoPageScroll(page);
    }
  );

  reflowTest(
    `Aparelhos a ${width} px com letra de ${font} px: o selo desce sob o nome e nada se corta`,
    async ({ page }) => {
      await openDevices(page, width, font);
      await expectTiles(page, DEVICE_ROW);
      expectBadgesBelow(await rowGeometries(page, DEVICE_ROW));
      const list = page.locator("main");
      await assertNothingClipped(list);
      await assertNoEllipsis(list.locator(DEVICE_ROW));
      await assertNoPageScroll(page);
    }
  );
}
