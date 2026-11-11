/// <reference lib="dom" />

import type { Page, Route } from "@playwright/test";
import { expect } from "@playwright/test";
import { buildOfflineLeaseClaims } from "@polaris/domain/offline/offline-lease";
import { signOfflineLease } from "../src/lib/offline-lease-token";
import { serveHealth, WORKER_MARK } from "./worker-mark";

/** The server of the specs of the shell, played by network interception with the offline runtime on. */

export const ORGANIZATION_ID = "0199c2d0-0000-7000-8000-00000000a001";
export const ORGANIZATIONS = [
  {
    id: ORGANIZATION_ID,
    name: "Loja do teste",
    role: "owner",
    timezone: "America/Sao_Paulo",
  },
];
export const SECOND_ORGANIZATION = {
  id: "0199c2d0-0000-7000-8000-00000000a002",
  name: "Loja da filial",
  role: "owner",
  timezone: "America/Sao_Paulo",
};
const USER_ID = "user-do-teste";
export const EMAIL = "contato@exemplo.com.br";
const LEASE_KEY = {
  id: "teste",
  secret: "teste-secret-teste-secret-teste-secret-0123456789",
};
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const SAO_PAULO_OFFSET = 3 * HOUR;
/** The instant a page was pinned to, so the lease the server signs is not in the future of that page's clock. */
const pinnedNow = new WeakMap<Page, Date>();
const DEVICE = {
  createdAt: "2026-10-01T12:00:00.000Z",
  id: "0199c2d0-0000-7000-8000-000000000001",
  label: "Caixa da loja",
  lastSeenAt: "2026-10-14T12:00:00.000Z",
  revokedAt: null,
};

export const json = (body: unknown) => ({
  body: JSON.stringify({ json: body, meta: [] }),
  contentType: "application/json",
  headers: { ...WORKER_MARK },
});
const inputOf = (route: Route) =>
  (route.request().postDataJSON() as { json: Record<string, unknown> }).json;

/** What the server says of the ways to sign in (the latest route wins over the one `serve` set). */
export const authMethods = (page: Page, emailPassword: boolean) =>
  page.route("**/api/auth-methods", (route) =>
    route.fulfill({
      body: JSON.stringify({
        emailPassword,
        google: true,
        turnstileSiteKey: null,
      }),
      contentType: "application/json",
      headers: { ...WORKER_MARK },
    })
  );

/** The server of a test: a signed-in person with one store, and nothing queued. */
export async function serve(page: Page, organizations = ORGANIZATIONS) {
  const state = { signOutCalls: 0 };
  // the Início reads in vain here (every other /rpc is cut): the probe finds the Worker, so it is not "offline"
  await serveHealth(page);
  await page.route("**/rpc/**", (route) => route.abort("internetdisconnected"));
  await page.route("**/rpc/organization/listMine", (route) =>
    route.fulfill(json({ organizations }))
  );
  // the password is off unless a test says otherwise: Senha is not a tab of Configurações then
  await authMethods(page, false);
  await page.route("**/api/auth/get-session", (route) =>
    route.fulfill({
      body: JSON.stringify(
        state.signOutCalls > 0 ? null : { user: { email: EMAIL, id: USER_ID } }
      ),
      contentType: "application/json",
      headers: { ...WORKER_MARK },
    })
  );
  await page.route("**/api/auth/sign-out", (route) => {
    state.signOutCalls += 1;
    return route.fulfill({
      body: "{}",
      contentType: "application/json",
      headers: { ...WORKER_MARK },
    });
  });
  await page.route("**/rpc/device/list", (route) =>
    route.fulfill(json({ devices: [DEVICE] }))
  );
  await page.route("**/rpc/device/register", (route) =>
    route.fulfill(json({ device: DEVICE }))
  );
  await page.route("**/rpc/device/check", (route) =>
    route.fulfill(json({ device: DEVICE }))
  );
  await page.route("**/rpc/offline/issueLease", async (route) => {
    const input = inputOf(route) as {
      deviceId: string;
      organizationId: string;
    };
    const issuedAt = pinnedNow.get(page) ?? new Date();
    const expiresAt = new Date(issuedAt.getTime() + 72 * HOUR);
    const lease = await signOfflineLease(
      buildOfflineLeaseClaims({
        capabilities: ["customer:create", "customer:update"],
        deviceId: input.deviceId,
        epoch: 0,
        expiresAt,
        grantId: "0199c2d0-0000-7000-8000-000000000901",
        issuedAt,
        organizationId: input.organizationId,
        userId: USER_ID,
      }),
      LEASE_KEY
    );
    await route.fulfill(
      json({
        expiresAt: expiresAt.toISOString(),
        grantId: "0199c2d0-0000-7000-8000-000000000901",
        issuedAt: issuedAt.toISOString(),
        lease,
      })
    );
  });
  await page.route("**/rpc/sync/getCursor", (route) =>
    route.fulfill(json({ cursor: "0" }))
  );
  await page.route("**/rpc/sync/bootstrapPage", (route) =>
    route.fulfill(
      json({
        collection: (inputOf(route) as { collection: string }).collection,
        nextAfterId: null,
        rows: [],
      })
    )
  );
  await page.route("**/rpc/sync/pull", (route) =>
    route.fulfill(json({ changes: [], hasMore: false, nextCursor: "0" }))
  );
  await page.route("**/rpc/sale/list", (route) =>
    route.fulfill(json({ sales: [] }))
  );
  return state;
}

/**
 * One command of this device that the server refused (as `sync.push` leaves it): written into the outbox of the
 * runtime, which opened with the page, and read again on a reload. The screens of this harness have no copy of their
 * own to queue with, so the record is made here, in the shape the outbox keeps.
 */
export async function leaveOneRefused(page: Page) {
  await page.goto("/");
  await expect(page.locator(".sync-status")).toContainText(
    "Tudo sincronizado",
    {
      timeout: 20_000,
    }
  );
  await page.evaluate(
    async ({ deviceId, organizationId }) => {
      const names = (await indexedDB.databases())
        .map(({ name }) => name ?? "")
        .filter((name) => name.startsWith("polaris-outbox-"));
      for (const name of names) {
        // biome-ignore lint/performance/noAwaitInLoops: one database, the one of this person
        await new Promise<void>((resolve, reject) => {
          const opening = indexedDB.open(name);
          opening.onerror = () => reject(opening.error);
          opening.onsuccess = () => {
            const tx = opening.result.transaction(
              ["commands", "meta"],
              "readwrite"
            );
            const at = new Date().toISOString();
            tx.objectStore("commands").put({
              attempts: 1,
              baseVersion: null,
              commandId: crypto.randomUUID(),
              createdAt: at,
              deviceId,
              lastAttemptAt: at,
              lease: "lease",
              organizationId,
              payload: { name: "Bia Souza" },
              rejection: { at, code: "validation_failed" },
              seq: 1,
              status: "rejected",
              type: "customer.create",
            });
            tx.objectStore("meta").put(1, "lastSeq");
            tx.oncomplete = () => {
              opening.result.close();
              resolve();
            };
            tx.onerror = () => reject(tx.error);
          };
        });
      }
      return names.length;
    },
    { deviceId: DEVICE.id, organizationId: ORGANIZATION_ID }
  );
  await page.reload();
  await expect(page.locator(".sync-status")).toContainText(
    "precisa de atenção",
    {
      timeout: 20_000,
    }
  );
}

/** `03/11/2026` at noon in São Paulo: the instant every page of `serveFoot` is pinned to. */
const FOOT_NOW = new Date("2026-11-03T15:00:00.000Z");
const TRIAL_DAYS = 7;
const CHARGE_DAY = new Date(
  FOOT_NOW.getTime() - SAO_PAULO_OFFSET + TRIAL_DAYS * DAY
)
  .toISOString()
  .slice(0, 10);
const ACCESS_ENDS_AT = new Date(
  Date.parse(`${CHARGE_DAY}T00:00:00.000Z`) + DAY + SAO_PAULO_OFFSET
).toISOString();

/**
 * A trial with its first charge set, as the server reads it (every key: the answer is strict). The dates come from
 * `FOOT_NOW`, which `serveFoot` pins in the page: the first charge is on `10/11/2026` and the access ends at the end of that day.
 */
export const TRIAL_PLAN = {
  accessEndsAt: ACCESS_ENDS_AT,
  cycleMonths: 1,
  kept: { historyMonths: 3, products: 18, sales: 47 },
  limits: { goals: 3, images: 5000, variants: 2000 },
  method: "card",
  nextCharge: { amount: "24.90", cycleMonths: 1, on: CHARGE_DAY },
  offer: {
    methods: ["card", "pix_automatic"],
    prices: [
      { amount: "249.00", cycleMonths: 12 },
      { amount: "24.90", cycleMonths: 1 },
    ],
  },
  recovery: null,
  refund: null,
  refundPending: false,
  refundWindowEndedOn: null,
  renewalCancelled: false,
  resubscribeFrom: null,
  state: "trialing",
  trialAvailable: false,
  usage: { goals: 1, images: 12, variants: 38 },
};

/**
 * The shell of a store in its trial: `steps` is what the Início read of the first steps in this tab, `role` and
 * `billingSelfService` say whether this person manages the billing. Counts the reads of the plan.
 */
export async function serveFoot(
  page: Page,
  {
    billingSelfService = true,
    name = "Loja do teste",
    role = "owner",
    steps = 2,
  }: {
    billingSelfService?: boolean;
    name?: string;
    role?: string;
    steps?: number | null;
  }
) {
  pinnedNow.set(page, FOOT_NOW);
  await page.clock.setFixedTime(FOOT_NOW);
  const organizations = [
    {
      id: ORGANIZATION_ID,
      name,
      role,
      timezone: "America/Sao_Paulo",
    },
  ];
  await serve(page, organizations);
  await page.route("**/rpc/organization/listMine", (route) =>
    route.fulfill(json({ billingSelfService, organizations }))
  );
  const reads = { plan: 0 };
  await page.route("**/rpc/billing/readPlan", (route) => {
    reads.plan += 1;
    return route.fulfill(json(TRIAL_PLAN));
  });
  if (steps !== null) {
    await page.addInitScript(
      ([organizationId, done]) => {
        sessionStorage.setItem(
          "polaris.home.firstSteps",
          JSON.stringify({ done, organizationId })
        );
      },
      [ORGANIZATION_ID, steps] as const
    );
  }
  return reads;
}
