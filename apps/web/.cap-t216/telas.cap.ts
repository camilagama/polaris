/// <reference lib="dom" />
// Temporary (t216, never committed): screenshots of the devices list and "Sair", before and after.
import type { BrowserContext, Page, Route } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { buildOfflineLeaseClaims } from "@polaris/domain/offline/offline-lease";
import { signOfflineLease } from "../src/lib/offline-lease-token";
import { deviceFamilyLabel as tableLabel } from "/home/dev/wt/t216/apps/web/src/server/device-family-label";

const MODE = process.env.CAP_MODE ?? "after";
const OUT = process.env.CAPTURE_DIR ?? "/tmp/t216-cap";
// before: the server of main names nothing
const deviceFamilyLabel = (headers: Headers) =>
  MODE === "before" ? null : tableLabel(headers);

const ORGANIZATION_ID = "0199c2d0-0000-7000-8000-00000000a001";
const ORGANIZATIONS = [
  {
    id: ORGANIZATION_ID,
    name: "Loja do teste",
    role: "owner",
    timezone: "America/Sao_Paulo",
  },
];
const USER_ID = "user-do-teste";
const LEASE_KEY = {
  id: "teste",
  secret: "teste-secret-teste-secret-teste-secret-0123456789",
};
const HOUR = 3_600_000;
const uuid = (n: number) =>
  `0199c2d0-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;

const json = (body: unknown, status = 200) => ({
  body: JSON.stringify({ json: body, meta: [] }),
  contentType: "application/json",
  status,
});
const rpcError = (status: number, code: string, reason?: string) =>
  json(
    {
      code,
      data: reason ? { reason } : undefined,
      defined: false,
      message: code,
      status,
    },
    status
  );
const inputOf = (route: Route) =>
  (route.request().postDataJSON() as { json: Record<string, unknown> }).json;

type RevokeAnswer =
  | "ok"
  | { status: number; code: string; reason?: string }
  | "abort";

interface Device {
  createdAt: string;
  id: string;
  label: string | null;
  lastSeenAt: string;
  revokedAt: string | null;
}

/** The server of a test; every browser context of the test talks to the same one. */
class Server {
  devices: Device[] = [];
  /** What each request did, in order: `push`, `revokeCurrent <id>`, `sign-out`, `register`… */
  log: string[] = [];
  /** The headers of each `device.register`, to name the device as the server does. */
  registerHeaders: Record<string, string>[] = [];
  revokeAnswer: RevokeAnswer = "ok";
  /** Whether `sync.push` reaches the server or fails on the network. */
  pushReaches: boolean;
  pushAccepted = 0;
  private serial = 100;
  /** The browsers signed in, by context; a sign-out (or a revocation that ends the session) takes one out. */
  private readonly sessions = new Map<BrowserContext, string | null>();

  constructor() {
    this.pushReaches = true;
  }

  signIn(context: BrowserContext) {
    this.sessions.set(context, null);
  }

  live() {
    return this.devices.filter((device) => device.revokedAt === null);
  }

  async install(page: Page) {
    const context = page.context();
    if (!this.sessions.has(context)) {
      this.signIn(context);
    }
    const signedIn = () => this.sessions.has(context);
    const refused = () => rpcError(401, "UNAUTHORIZED");
    await page.route("**/rpc/**", (route) =>
      route.abort("internetdisconnected")
    );
    await page.route("**/api/auth/get-session", (route) =>
      route.fulfill(
        signedIn()
          ? {
              body: JSON.stringify({ user: { id: USER_ID } }),
              contentType: "application/json",
            }
          : { body: "null", contentType: "application/json" }
      )
    );
    await page.route("**/api/auth/sign-out", (route) => {
      this.log.push("sign-out");
      this.sessions.delete(context);
      return route.fulfill({ body: "{}", contentType: "application/json" });
    });
    await page.route("**/rpc/organization/listMine", (route) =>
      route.fulfill(
        signedIn() ? json({ organizations: ORGANIZATIONS }) : refused()
      )
    );
    await page.route("**/rpc/device/list", (route) =>
      route.fulfill(signedIn() ? json({ devices: this.live() }) : refused())
    );
    await page.route("**/rpc/device/register", async (route) => {
      if (!signedIn()) {
        await route.fulfill(refused());
        return;
      }
      const headers = await route.request().allHeaders();
      this.registerHeaders.push(headers);
      this.serial += 1;
      const now = new Date().toISOString();
      const created: Device = {
        createdAt: now,
        id: uuid(this.serial),
        // the server's own rule: no label, the closed table of browser and system
        label: deviceFamilyLabel(new Headers(headers)),
        lastSeenAt: now,
        revokedAt: null,
      };
      this.devices.push(created);
      this.sessions.set(context, created.id);
      this.log.push("register");
      await route.fulfill(json({ device: created }));
    });
    await page.route("**/rpc/device/check", async (route) => {
      const { deviceId } = inputOf(route) as { deviceId: string };
      const found = this.devices.find((device) => device.id === deviceId);
      this.log.push("check");
      if (!signedIn()) {
        await route.fulfill(refused());
      } else if (!found) {
        await route.fulfill(rpcError(404, "NOT_FOUND"));
      } else if (found.revokedAt) {
        await route.fulfill(rpcError(409, "CONFLICT"));
      } else {
        this.sessions.set(context, found.id);
        await route.fulfill(json({ device: found }));
      }
    });
    await page.route("**/rpc/device/revokeCurrent", async (route) => {
      const { deviceId } = inputOf(route) as { deviceId: string };
      this.log.push(`revokeCurrent ${deviceId}`);
      const answer = this.revokeAnswer;
      if (answer === "abort") {
        await route.abort("internetdisconnected");
        return;
      }
      if (answer !== "ok") {
        await route.fulfill(
          rpcError(answer.status, answer.code, answer.reason)
        );
        return;
      }
      const found = this.devices.find((device) => device.id === deviceId);
      if (!(signedIn() && found)) {
        await route.fulfill(
          signedIn() ? rpcError(404, "NOT_FOUND") : refused()
        );
        return;
      }
      const alreadyRevoked = found.revokedAt !== null;
      found.revokedAt ??= new Date().toISOString();
      // the sessions linked to it end, this one included; the other browsers keep theirs
      for (const [other, linked] of this.sessions) {
        if (linked === deviceId) {
          this.sessions.delete(other);
        }
      }
      await route.fulfill(
        json({
          alreadyRevoked,
          endedCurrentSession: true,
          revokedGrantCount: 1,
        })
      );
    });
    await page.route("**/rpc/offline/issueLease", async (route) => {
      const input = inputOf(route) as {
        deviceId: string;
        organizationId: string;
      };
      if (!signedIn()) {
        await route.fulfill(refused());
        return;
      }
      const issuedAt = new Date();
      const expiresAt = new Date(issuedAt.getTime() + 72 * HOUR);
      const lease = await signOfflineLease(
        buildOfflineLeaseClaims({
          capabilities: ["customer:create", "customer:update"],
          deviceId: input.deviceId,
          epoch: 0,
          expiresAt,
          grantId: uuid(901),
          issuedAt,
          organizationId: input.organizationId,
          userId: USER_ID,
        }),
        LEASE_KEY
      );
      await route.fulfill(
        json({
          expiresAt: expiresAt.toISOString(),
          grantId: uuid(901),
          issuedAt: issuedAt.toISOString(),
          lease,
        })
      );
    });
    await page.route("**/rpc/sync/getCursor", (route) =>
      route.fulfill(signedIn() ? json({ cursor: "0" }) : refused())
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
    await page.route("**/rpc/sync/push", async (route) => {
      if (!this.pushReaches) {
        this.log.push("push failed");
        await route.abort("internetdisconnected");
        return;
      }
      if (!signedIn()) {
        await route.fulfill(refused());
        return;
      }
      const { commands } = inputOf(route) as {
        commands: { commandId: string }[];
      };
      this.log.push("push");
      this.pushAccepted += commands.length;
      await route.fulfill(
        json({
          results: commands.map(({ commandId }) => ({
            code: null,
            commandId,
            replayed: false,
            result: null,
            status: "accepted",
          })),
        })
      );
    });
  }
}

const chip = (page: Page) => page.locator(".sync-status");
const deviceItems = (page: Page) =>
  page.getByRole("list", { name: "Aparelhos" }).getByRole("listitem");

async function openApp(page: Page, server: Server, path = "/customers") {
  await server.install(page);
  await page.goto(path);
  await expect(chip(page)).toContainText("Tudo sincronizado", {
    timeout: 20_000,
  });
}

/** "Sair": at the top on a wide screen, in the Menu on a narrow one. */
async function clickSair(page: Page) {
  const toggle = page.getByRole("button", { name: "Menu" });
  if (await toggle.isVisible()) {
    await toggle.click();
  }
  await page.getByRole("button", { exact: true, name: "Sair" }).click();
}

async function queueCustomers(page: Page, count: number) {
  await page.context().setOffline(true);
  for (let n = 1; n <= count; n += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: the operations are queued in order
    await page.locator("#customer-name").fill(`Cliente ${n}`);
    await page.locator("#customer-phone").fill(`1190000000${n}`);
    await page.getByRole("button", { name: "Cadastrar cliente" }).click();
    await expect(chip(page)).toContainText(
      `${n} ${n === 1 ? "operação guardada" : "operações guardadas"}`
    );
  }
  await page.context().setOffline(false);
}


async function shot(page: Page, name: string, info: { project: { name: string } }) {
  await page.waitForTimeout(400);
  await page.screenshot({
    fullPage: true,
    path: `${OUT}/${MODE}-${info.project.name}-${name}.png`,
  });
}

test("fluxo", async ({ page }, info) => {
  const server = new Server();
  await openApp(page, server);
  await page.goto("/devices");
  await expect(deviceItems(page)).toHaveCount(1, { timeout: 20_000 });
  await shot(page, "1-lista-primeiro-login", info);
  const toggle = page.getByRole("button", { name: "Menu" });
  if (await toggle.isVisible()) {
    await toggle.click();
    await shot(page, "2-menu-com-sair", info);
  }
  await page.getByRole("button", { exact: true, name: "Sair" }).click();
  await expect.poll(() => new URL(page.url()).pathname, { timeout: 15_000 }).not.toBe("/devices");
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await shot(page, "3-depois-de-sair", info);
  server.signIn(page.context());
  await openApp(page, server);
  await page.goto("/devices");
  await expect(deviceItems(page).first()).toBeVisible({ timeout: 20_000 });
  await shot(page, "4-lista-depois-de-entrar-de-novo", info);
});

test("estados", async ({ page }, info) => {
  const server = new Server();
  await openApp(page, server);
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/rpc/device/list", async (route) => {
    await gate;
    await route.fulfill(json({ devices: server.live() }));
  });
  await page.goto("/devices");
  await expect(page.getByText("Carregando seus aparelhos")).toBeVisible();
  await shot(page, "5-carregando", info);
  release();
  await expect(deviceItems(page)).toHaveCount(1);
  await page.unroute("**/rpc/device/list");
  await page.route("**/rpc/device/list", (route) => route.abort("internetdisconnected"));
  await page.reload();
  await expect(page.getByRole("alert").first()).toBeVisible({ timeout: 20_000 });
  await shot(page, "6-erro", info);
  await page.unroute("**/rpc/device/list");
  await page.route("**/rpc/device/list", (route) => route.fulfill(json({ devices: [] })));
  await page.reload();
  await page.waitForTimeout(1500);
  await shot(page, "7-vazio", info);
  await page.unroute("**/rpc/device/list");
  await page.route("**/rpc/device/list", (route) => route.fulfill(json({ devices: server.live() })));
  await page.reload();
  await expect(deviceItems(page).first()).toBeVisible({ timeout: 20_000 });
  await page.context().setOffline(true);
  await page.waitForTimeout(1500);
  await shot(page, "8-offline", info);
  await page.context().setOffline(false);
});
