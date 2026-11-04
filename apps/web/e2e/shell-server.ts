import type { Page, Route } from "@playwright/test";
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
export const USER_ID = "user-do-teste";
export const EMAIL = "contato@exemplo.com.br";
const LEASE_KEY = {
  id: "teste",
  secret: "teste-secret-teste-secret-teste-secret-0123456789",
};
const HOUR = 3_600_000;
export const DEVICE = {
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
export const inputOf = (route: Route) =>
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
    const issuedAt = new Date();
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
