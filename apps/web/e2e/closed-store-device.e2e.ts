/// <reference lib="dom" />

import type { Page, Route } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { buildOfflineLeaseClaims } from "@polaris/domain/offline/offline-lease";
import { signOfflineLease } from "../src/lib/offline-lease-token";
import { SaleLabServer } from "../src/offline-poc/sale-lab-server";
import { serveHealth, WORKER_MARK } from "./worker-mark";

/**
 * A device whose store was closed while it worked (AC-11 of the corte encerrar-a-loja-e-painel-da-encerrada): the real
 * app, the real offline runtime and the real oRPC client; only the server is played. The server refuses with
 * `FORBIDDEN` and `data.reason: "organization_closed"` on a read, on `sync/push` and on `offline/issueLease`, and the
 * app says so, drops the local copy and the lease, keeps the queue, and never goes round to the sign-in screen.
 */
const ORGANIZATION = {
  id: "0199c2d0-0000-7000-8000-00000000a001",
  name: "Loja do teste",
  role: "owner",
  timezone: "America/Sao_Paulo",
};
const CLOSED = {
  canRecover: true,
  deletableFrom: "2027-01-18T03:00:00.000Z",
  deletionDate: "2027-01-18",
  exportOpenUntil: "2027-01-18T03:00:00.000Z",
  id: ORGANIZATION.id,
  milestones: {
    closure: "2026-10-20T12:00:00.000Z",
    d7: "2027-01-11T03:00:00.000Z",
    d30: "2026-12-19T03:00:00.000Z",
    deletionDay: "2027-01-18T03:00:00.000Z",
  },
  name: ORGANIZATION.name,
  phase: "closing",
  recoverUntil: "2026-11-19T12:00:00.000Z",
  renewal: "not_handled",
  requestedAt: "2026-10-20T12:00:00.000Z",
  timezone: "America/Sao_Paulo",
};
const LAB_KEY = {
  id: "lab",
  secret: "lab-secret-lab-secret-lab-secret-0123456789",
};
const HOUR = 3_600_000;
const SESSION_USER_KEY = "polaris.offline.session-user";
const DEVICE_KEY = "polaris.offline.device";
const SHIRT_OPTION = /Camiseta do laboratório · Azul/;
const NOTICE =
  "Esta loja foi encerrada em 20 de outubro de 2026. A cópia deste aparelho foi apagada; o que não foi enviado continua guardado na fila.";
const uuid = (n: number) =>
  `0199c2d0-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const leaseKey = (userId: string) =>
  `polaris.offline.lease.${userId}.${ORGANIZATION.id}`;

type Refusing = "lease" | "none" | "push" | "read";

class ClosingServer {
  readonly devices = new Map<string, string>();
  readonly stock = new SaleLabServer();
  refusing: Refusing = "none";
  pushAnswer: "accept" | "fail" = "accept";
  listMine = 0;
  pushes = 0;
  leases = 0;
  closedRefusals = 0;

  readonly userId: string;

  constructor(userId: string) {
    this.userId = userId;
  }

  private static ok(route: Route, json: unknown) {
    return route.fulfill({
      body: JSON.stringify({ json, meta: [] }),
      contentType: "application/json",
      headers: { ...WORKER_MARK },
    });
  }

  private static fail(
    route: Route,
    status: number,
    code: string,
    reason?: string
  ) {
    return route.fulfill({
      body: JSON.stringify({
        json: {
          code,
          data: reason === undefined ? undefined : { reason },
          defined: false,
          message: code,
          status,
        },
        meta: [],
      }),
      contentType: "application/json",
      headers: { ...WORKER_MARK },
      status,
    });
  }

  private refuseClosed(route: Route) {
    this.closedRefusals += 1;
    return ClosingServer.fail(route, 403, "FORBIDDEN", "organization_closed");
  }

  async install(page: Page) {
    await serveHealth(page);
    await page.route("**/api/auth/get-session", (route) =>
      route.fulfill({
        body: JSON.stringify({
          session: { id: "s" },
          user: { id: this.userId },
        }),
        contentType: "application/json",
        headers: { ...WORKER_MARK },
      })
    );
    await page.route("**/rpc/**", (route) => this.answer(route));
  }

  private async answer(route: Route) {
    const procedure = new URL(route.request().url()).pathname.replace(
      "/rpc/",
      ""
    );
    const input = (route.request().postDataJSON()?.json ?? {}) as Record<
      string,
      unknown
    >;
    switch (procedure) {
      case "organization/listMine":
        this.listMine += 1;
        await ClosingServer.ok(route, {
          billingSelfService: false,
          organizations: [ORGANIZATION],
        });
        return;
      case "organization/closedStatus":
        await ClosingServer.ok(route, { organization: CLOSED });
        return;
      case "device/register": {
        const id = uuid(7000 + this.devices.size + 1);
        this.devices.set(id, this.userId);
        await ClosingServer.ok(route, { device: { id } });
        return;
      }
      case "device/check":
        await ClosingServer.ok(route, { device: { id: input.deviceId } });
        return;
      case "offline/issueLease":
        this.leases += 1;
        // a closed store refuses every tenant call: a lease too, whatever path said it first
        if (this.refusing !== "none" && this.refusing !== "push") {
          await this.refuseClosed(route);
          return;
        }
        await ClosingServer.ok(route, await this.issue(String(input.deviceId)));
        return;
      case "sync/push":
        this.pushes += 1;
        if (this.refusing === "push") {
          await this.refuseClosed(route);
          return;
        }
        if (this.pushAnswer === "fail") {
          await ClosingServer.fail(route, 500, "INTERNAL_SERVER_ERROR");
          return;
        }
        await ClosingServer.ok(
          route,
          await this.stock.push(input as Parameters<SaleLabServer["push"]>[0])
        );
        return;
      case "sync/getCursor":
        await ClosingServer.ok(route, {
          cursor: await this.stock.getCursor(),
        });
        return;
      case "sync/bootstrapPage": {
        const page = await this.stock.page(
          input.collection as "products",
          input as { ids?: string[] }
        );
        await ClosingServer.ok(route, {
          collection: input.collection,
          ...page,
        });
        return;
      }
      case "sync/pull":
        await ClosingServer.ok(
          route,
          await this.stock.pull(String(input.cursor), Number(input.limit))
        );
        return;
      case "sale/list":
        await ClosingServer.ok(route, {
          sales: await this.stock.recentSales(),
        });
        return;
      case "paymentProfile/list":
        if (this.refusing === "read") {
          await this.refuseClosed(route);
          return;
        }
        await ClosingServer.ok(route, { profiles: [] });
        return;
      default:
        await ClosingServer.fail(route, 500, `NOT_PLAYED_${procedure}`);
    }
  }

  private async issue(deviceId: string) {
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + 72 * HOUR);
    const lease = await signOfflineLease(
      buildOfflineLeaseClaims({
        capabilities: ["sale:create", "customer:create", "inventory:adjust"],
        deviceId,
        epoch: 0,
        expiresAt,
        grantId: uuid(9000 + this.leases),
        issuedAt,
        organizationId: ORGANIZATION.id,
        userId: this.userId,
      }),
      LAB_KEY
    );
    return { expiresAt: expiresAt.toISOString(), lease };
  }
}

const chip = (page: Page) => page.locator(".sync-status");
const notice = (page: Page) =>
  page.locator('[data-notice="organization-closed"]');

async function openSales(page: Page, server: ClosingServer) {
  await server.install(page);
  await page.goto("/sales");
  await expect(
    page.getByRole("heading", { exact: true, name: "Nova venda" })
  ).toBeVisible();
  await expect(chip(page)).toContainText("Tudo sincronizado", {
    timeout: 20_000,
  });
}

async function keepOneSale(page: Page) {
  await page.getByLabel("Produto ou variante").fill("camiseta azul");
  await page.getByRole("button", { name: SHIRT_OPTION }).click();
  await page.getByLabel("Quantidade").fill("1");
  await page
    .getByRole("radiogroup", { name: "Método de pagamento" })
    .getByRole("radio", { name: "Pix" })
    .check();
  await page
    .getByRole("combobox", { exact: true, name: "Perfil de pagamento" })
    .click();
  await page
    .getByRole("option", { exact: true, name: "Sem perfil de pagamento" })
    .click();
  await page
    .getByRole("button", { name: "Guardar venda neste aparelho" })
    .click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Venda guardada neste aparelho" })
  ).toBeVisible();
}

async function queueTwoSales(page: Page) {
  await page.context().setOffline(true);
  await expect(chip(page)).toContainText("Sem conexão", { timeout: 15_000 });
  await keepOneSale(page);
  await keepOneSale(page);
  await expect(chip(page)).toContainText("Sem conexão · 2 operações guardadas");
}

async function outboxCommands(page: Page) {
  return await page.evaluate(async () => {
    const found: string[] = [];
    for (const { name } of await indexedDB.databases()) {
      if (!name) {
        continue;
      }
      // biome-ignore lint/performance/noAwaitInLoops: a handful of tiny databases
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(name);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
      });
      if (database.objectStoreNames.contains("commands")) {
        const rows = await new Promise<{ commandId: string; seq: number }[]>(
          (resolve, reject) => {
            const request = database
              .transaction("commands", "readonly")
              .objectStore("commands")
              .getAll();
            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve(request.result);
          }
        );
        rows.sort((a, b) => a.seq - b.seq);
        found.push(...rows.map(({ commandId }) => commandId));
      }
      database.close();
    }
    return found;
  });
}

const stored = (page: Page, key: string) =>
  page.evaluate((name) => window.localStorage.getItem(name), key);

const collectionFiles = (page: Page) =>
  page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    let count = 0;
    for await (const name of (
      root as unknown as { keys: () => AsyncIterable<string> }
    ).keys()) {
      if (name.startsWith("polaris-local-") && name.endsWith(".sqlite")) {
        count += 1;
      }
    }
    return count;
  });

async function expectClosedDevice(
  page: Page,
  server: ClosingServer,
  queued: string[],
  device: string | null
) {
  await expect(notice(page)).toHaveText(`${NOTICE}Ver a loja encerrada`, {
    timeout: 20_000,
  });
  await expect(notice(page)).toHaveAttribute("role", "alert");
  await expect(
    notice(page).getByRole("link", { name: "Ver a loja encerrada" })
  ).toHaveAttribute("href", `/loja-encerrada?loja=${ORGANIZATION.id}`);
  await expect.poll(() => stored(page, leaseKey(server.userId))).toBeNull();
  await expect.poll(() => collectionFiles(page)).toBe(0);
  expect(await outboxCommands(page)).toEqual(queued);
  expect(await stored(page, SESSION_USER_KEY)).toBe(server.userId);
  expect(await stored(page, DEVICE_KEY)).toBe(device);
  await expect(page.getByText("Sua sessão acabou")).toHaveCount(0);
  const reads = server.listMine;
  await page.waitForTimeout(3000);
  expect(new URL(page.url()).pathname).toBe("/sales");
  expect(server.listMine - reads).toBeLessThanOrEqual(1);
  await expect(
    page.getByRole("heading", { exact: true, name: "Nova venda" })
  ).toHaveCount(0);
}

test.describe("aparelho com a loja encerrada (AC-11)", () => {
  test.setTimeout(90_000);

  test("recusa no sync/push: a faixa, a cópia apagada e a fila igual", async ({
    page,
  }) => {
    const server = new ClosingServer(`user-${crypto.randomUUID()}`);
    await openSales(page, server);
    await queueTwoSales(page);
    const queued = await outboxCommands(page);
    expect(queued).toHaveLength(2);
    const device = await stored(page, DEVICE_KEY);
    expect(await collectionFiles(page)).toBe(1);

    server.refusing = "push";
    await page.context().setOffline(false);

    await expectClosedDevice(page, server, queued, device);
    expect(server.closedRefusals).toBeGreaterThan(0);
  });

  test("recusa na renovação da concessão, ao abrir o app: a faixa, a cópia apagada e a fila igual, sem novo aparelho", async ({
    page,
  }) => {
    const server = new ClosingServer(`user-${crypto.randomUUID()}`);
    await openSales(page, server);
    await queueTwoSales(page);
    const queued = await outboxCommands(page);
    const device = await stored(page, DEVICE_KEY);
    const registered = server.devices.size;

    // the lease the device kept is gone (revoked with the closure): the next opening asks for a new one
    await page.evaluate(
      (key) => window.localStorage.removeItem(key),
      [leaseKey(server.userId)]
    );
    server.refusing = "lease";
    await page.context().setOffline(false);
    await page.reload();

    await expectClosedDevice(page, server, queued, device);
    expect(server.devices.size).toBe(registered);
    expect(server.pushes).toBe(0);
  });

  test("recusa numa leitura da tela: a faixa, a cópia apagada e a fila igual", async ({
    page,
  }) => {
    const server = new ClosingServer(`user-${crypto.randomUUID()}`);
    await openSales(page, server);
    await queueTwoSales(page);
    const queued = await outboxCommands(page);
    const device = await stored(page, DEVICE_KEY);

    server.pushAnswer = "fail";
    server.refusing = "read";
    await page.context().setOffline(false);
    await page.reload();

    await expectClosedDevice(page, server, queued, device);
  });

  test("contraste: um FORBIDDEN sem motivo no push não vira loja encerrada", async ({
    page,
  }) => {
    const server = new ClosingServer(`user-${crypto.randomUUID()}`);
    await openSales(page, server);
    await queueTwoSales(page);
    await page.route("**/rpc/sync/push", (route) =>
      route.fulfill({
        body: JSON.stringify({
          json: {
            code: "FORBIDDEN",
            data: undefined,
            defined: false,
            message: "FORBIDDEN",
            status: 403,
          },
          meta: [],
        }),
        contentType: "application/json",
        headers: { ...WORKER_MARK },
        status: 403,
      })
    );
    await page.context().setOffline(false);
    await expect
      .poll(() => stored(page, leaseKey(server.userId)), {
        timeout: 40_000,
      })
      .toBeNull();
    await expect(notice(page)).toHaveCount(0);
  });
});
