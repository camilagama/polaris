/// <reference lib="dom" />
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { serveHealth, WORKER_MARK } from "./worker-mark";

/**
 * A cart left from the evening before, opened just after the store's midnight. Only the person's own edit moves
 * `updatedAt` (ADR 0041, emenda da meia-noite): opening the draft, the re-read of its variants and a reload must not
 * renew the six hours, or an old cart would never be dropped.
 */
const ORGANIZATION = {
  id: "0199c2d0-0000-7000-8000-00000000a001",
  name: "Loja do teste",
  role: "owner",
  timezone: "America/Sao_Paulo",
};
const PRODUCT_ID = "0199c2d0-0000-7000-8000-0000000000f1";
const VARIANT_ID = "0199c2d0-0000-7000-8000-0000000000b1";
const DRAFT_KEY = `polaris.sale.draft.v1:${ORGANIZATION.id}`;
const SEEDED_KEY = "polaris.e2e.sale-draft-midnight.seeded";
const NOW = new Date("2026-11-20T00:30:00-03:00");
const HOUR = 3_600_000;
const MINUTE = 60_000;
const LABEL = "Camiseta do teste · Azul";
const STARTED_AT = new Date(NOW.getTime() - 6.5 * HOUR).toISOString();
const FIVE_HOURS_AGO = new Date(NOW.getTime() - 5 * HOUR).toISOString();
const SIX_HOURS_AND_A_MINUTE_AGO = new Date(
  NOW.getTime() - 6 * HOUR - MINUTE
).toISOString();
const EXPIRED_MESSAGE =
  "A venda em andamento ficou parada por muito tempo e foi descartada.";
const NEW_DAY_NOTICE = /Esta venda começou ontem\./;
const REPRICED_NOTICE = /preço de tabela atualizado para R\$\s*50,00/;

const entry = (listPrice: string) => ({
  isDefaultVariant: false,
  listPrice,
  movingAverageCost: null,
  productId: PRODUCT_ID,
  productName: "Camiseta do teste",
  productStatus: "active",
  quantity: 5,
  sku: "CAM-AZ-M",
  updatedAt: NOW.toISOString(),
  values: [{ optionName: "color", optionValueName: "Azul" }],
  variantId: VARIANT_ID,
  version: 1,
});

const rpc = (json: unknown) => ({
  body: JSON.stringify({ json, meta: [] }),
  contentType: "application/json",
  headers: { ...WORKER_MARK },
  status: 200,
});

function savedDraft(updatedAt: string, startedAt = STARTED_AT) {
  return {
    form: {
      adjustments: [],
      items: [
        {
          chargedUnitPrice: "40,00",
          draftId: "0199c2d0-0000-7000-8000-0000000000d1",
          label: LABEL,
          listedUnitPrice: "40,00",
          productId: PRODUCT_ID,
          quantity: "2",
          variantId: VARIANT_ID,
        },
      ],
      occurredAtLocal: "",
      payment: {
        anticipationRequested: false,
        installmentPlan: "",
        installments: "",
        method: "pix",
      },
      profile: { choice: "", reviewNotice: null, seenVersion: null },
    },
    startedAt,
    updatedAt,
  };
}

/** The draft goes into the tab once, before the app runs: a reload then finds what the app itself wrote. */
async function seedDraft(page: Page, draft: unknown) {
  await page.addInitScript(
    ({ draftKey, seededKey, value }) => {
      if (window.sessionStorage.getItem(seededKey) === null) {
        window.sessionStorage.setItem(seededKey, "1");
        window.sessionStorage.setItem(draftKey, JSON.stringify(value));
      }
    },
    { draftKey: DRAFT_KEY, seededKey: SEEDED_KEY, value: draft }
  );
}

interface Server {
  reads: number;
}

async function install(page: Page, listPrice: string): Promise<Server> {
  const server: Server = { reads: 0 };
  await page.clock.setFixedTime(NOW);
  await serveHealth(page);
  await page.route("**/api/auth/get-session", (route) =>
    route.fulfill({
      body: JSON.stringify({
        session: { id: "s" },
        user: { id: "user-sale-draft-midnight" },
      }),
      contentType: "application/json",
      headers: { ...WORKER_MARK },
    })
  );
  await page.route("**/rpc/**", (route) => {
    const procedure = new URL(route.request().url()).pathname.replace(
      "/rpc/",
      ""
    );
    switch (procedure) {
      case "organization/listMine":
        return route.fulfill(
          rpc({ billingSelfService: false, organizations: [ORGANIZATION] })
        );
      case "inventory/listBalances":
        server.reads += 1;
        return route.fulfill(
          rpc({ entries: [entry(listPrice)], nextCursor: null })
        );
      case "paymentProfile/list":
        return route.fulfill(rpc({ profiles: [] }));
      default:
        return route.abort("internetdisconnected");
    }
  });
  return server;
}

const stored = async (page: Page) => {
  const text = await page.evaluate(
    (key) => window.sessionStorage.getItem(key),
    DRAFT_KEY
  );
  return text === null
    ? null
    : (JSON.parse(text) as { startedAt: string; updatedAt: string });
};

const heading = (page: Page) =>
  page.getByRole("heading", { exact: true, name: "Nova venda" });

test.describe("rascunho de venda que atravessa a meia-noite", () => {
  test.setTimeout(60_000);

  test("abrir, reler as variantes e recarregar não renovam o updatedAt", async ({
    page,
  }) => {
    const server = await install(page, "40.00");
    await seedDraft(page, savedDraft(FIVE_HOURS_AGO));

    await page.goto("/sales");
    await expect(heading(page)).toBeVisible();
    await expect(page.getByLabel("Quantidade")).toHaveValue("2");
    await expect(page.getByText(LABEL, { exact: true })).toBeVisible();
    await expect(page.getByText(NEW_DAY_NOTICE)).toBeVisible();
    await expect.poll(() => server.reads).toBeGreaterThan(0);
    await page.waitForLoadState("networkidle");
    await expect
      .poll(() => stored(page))
      .toMatchObject({
        startedAt: STARTED_AT,
        updatedAt: FIVE_HOURS_AGO,
      });

    const readsBeforeReload = server.reads;
    await page.reload();
    await expect(heading(page)).toBeVisible();
    await expect(page.getByLabel("Quantidade")).toHaveValue("2");
    await expect.poll(() => server.reads).toBeGreaterThan(readsBeforeReload);
    await page.waitForLoadState("networkidle");
    expect(await stored(page)).toMatchObject({
      form: { items: [{ quantity: "2", variantId: VARIANT_ID }] },
      startedAt: STARTED_AT,
      updatedAt: FIVE_HOURS_AGO,
    });
  });

  test("a releitura que muda o preço de tabela regrava o carrinho sem renovar o updatedAt", async ({
    page,
  }) => {
    await install(page, "50.00");
    await seedDraft(page, savedDraft(FIVE_HOURS_AGO));

    await page.goto("/sales");
    await expect(page.getByText(REPRICED_NOTICE)).toBeVisible();
    await expect(page.getByLabel("Quantidade")).toHaveValue("2");
    await expect
      .poll(async () => {
        const text = await page.evaluate(
          (key) => window.sessionStorage.getItem(key),
          DRAFT_KEY
        );
        return text?.includes("50,00") ?? false;
      })
      .toBe(true);
    expect(await stored(page)).toMatchObject({
      startedAt: STARTED_AT,
      updatedAt: FIVE_HOURS_AGO,
    });

    await page.reload();
    await expect(heading(page)).toBeVisible();
    await page.waitForLoadState("networkidle");
    expect(await stored(page)).toMatchObject({
      startedAt: STARTED_AT,
      updatedAt: FIVE_HOURS_AGO,
    });
  });

  test("com a última mudança há 6 h e 1 min o rascunho é descartado com o aviso", async ({
    page,
  }) => {
    await install(page, "40.00");
    await seedDraft(page, savedDraft(SIX_HOURS_AND_A_MINUTE_AGO));

    await page.goto("/sales");
    await expect(heading(page)).toBeVisible();
    await expect(page.getByText(EXPIRED_MESSAGE)).toBeVisible();
    await expect(page.getByLabel("Produto ou variante")).toHaveValue("");
    await expect(page.getByText(LABEL, { exact: true })).toHaveCount(0);
    await expect.poll(() => stored(page)).toBeNull();
  });

  test("uma edição da pessoa leva o updatedAt ao relógio e deixa o startedAt", async ({
    page,
  }) => {
    await install(page, "40.00");
    await seedDraft(page, savedDraft(FIVE_HOURS_AGO));

    await page.goto("/sales");
    await expect(page.getByLabel("Quantidade")).toHaveValue("2");
    await page.getByLabel("Quantidade").fill("3");

    await expect
      .poll(() => stored(page))
      .toMatchObject({
        startedAt: STARTED_AT,
        updatedAt: NOW.toISOString(),
      });
    expect(NOW.toISOString()).not.toBe(FIVE_HOURS_AGO);
  });
});
