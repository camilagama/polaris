/// <reference lib="dom" />

import type { Page, Route } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { buildOfflineLeaseClaims } from "@polaris/domain/offline/offline-lease";
import {
  readUnverifiedOfflineLease,
  signOfflineLease,
} from "../src/lib/offline-lease-token";
import { SaleLabServer } from "../src/offline-poc/sale-lab-server";

/**
 * The app as it runs in production: the real screens, the real offline runtime
 * and the real `createRpcRuntimeApi` over the real oRPC client. Only the server
 * is played by network interception, so what the runtime does with each answer
 * of `/api/auth/get-session`, `device.check`, `offline.issueLease` and
 * `sync.push` is proved in a browser, which the laboratories (they hand the
 * runtime a fake API) and the unit tests (no browser) do not.
 */
const ORGANIZATION = {
  id: "0199c2d0-0000-7000-8000-00000000a001",
  name: "Loja do teste",
  role: "owner",
  timezone: "America/Sao_Paulo",
};
const LAB_KEY = {
  id: "lab",
  secret: "lab-secret-lab-secret-lab-secret-0123456789",
};
const HOUR = 3_600_000;
// the lookup gives up after 4 s (runtime-api.ts): an answer that takes 30 s only
// lets the app open within the chip's timeout if the app really stops waiting
const SLOW_ANSWER_MS = 30_000;
const DEVICE_KEY = "polaris.offline.device";
const SESSION_USER_KEY = "polaris.offline.session-user";
const SHIRT_OPTION = /Camiseta do laboratório — Azul/;
const uuid = (n: number) =>
  `0199c2d0-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const leaseKey = (userId: string) =>
  `polaris.offline.lease.${userId}.${ORGANIZATION.id}`;

type SessionAnswer = "ok" | "slow" | "throttled" | "unauthorized";
type DeviceCheckAnswer = "error" | "not-found" | "ok";
type PushAnswer = "accept" | "session_changed" | "unauthorized";

interface PushedCommand {
  commandId: string;
}

/** Plays the part of the server: who is signed in, which devices exist and how each call answers. */
class RpcServer {
  /** Who the session cookie belongs to; null is a session that ended. */
  sessionUser: string | null;
  sessionAnswer: SessionAnswer = "ok";
  deviceCheckAnswer: DeviceCheckAnswer = "ok";
  pushAnswer: PushAnswer = "accept";
  readonly devices = new Map<string, string>();
  readonly stock = new SaleLabServer();
  registered = 0;
  checked = 0;
  sessionLookups = 0;
  readonly pushed: PushedCommand[][] = [];
  /** Every call is dropped as if the connection were gone (the browser still says it is online). */
  connection: "down" | "up" = "up";
  /** How far the page's simulated clock is ahead of this process, so a lease issued now is current there. */
  clockOffsetMs = 0;
  leasesIssued = 0;

  constructor(userId: string) {
    this.sessionUser = userId;
  }

  private static ok(route: Route, json: unknown) {
    return route.fulfill({
      body: JSON.stringify({ json, meta: [] }),
      contentType: "application/json",
    });
  }

  private static fail(route: Route, status: number, code: string) {
    return route.fulfill({
      body: JSON.stringify({
        json: {
          code,
          data: undefined,
          defined: false,
          message: code,
          status,
        },
        meta: [],
      }),
      contentType: "application/json",
      status,
    });
  }

  async install(page: Page) {
    await page.route("**/api/auth/get-session", (route) =>
      this.connection === "down"
        ? route.abort("internetdisconnected")
        : this.answerSession(route)
    );
    await page.route("**/rpc/**", (route) =>
      this.connection === "down"
        ? route.abort("internetdisconnected")
        : this.answerRpc(route)
    );
  }

  private async answerSession(route: Route) {
    this.sessionLookups += 1;
    const user = this.sessionUser;
    if (this.sessionAnswer === "slow") {
      await new Promise((resolve) => setTimeout(resolve, SLOW_ANSWER_MS));
      // the page already gave up on this request (and may be gone)
      await route.abort().catch(() => undefined);
      return;
    }
    if (this.sessionAnswer === "throttled") {
      await route.fulfill({ body: "slow down", status: 429 });
      return;
    }
    if (this.sessionAnswer === "unauthorized" || user === null) {
      await route.fulfill({ body: "{}", status: 401 });
      return;
    }
    await route.fulfill({
      body: JSON.stringify({ session: { id: "s" }, user: { id: user } }),
      contentType: "application/json",
    });
  }

  private async answerRpc(route: Route) {
    const procedure = new URL(route.request().url()).pathname.replace(
      "/rpc/",
      ""
    );
    const input = (route.request().postDataJSON()?.json ?? {}) as Record<
      string,
      unknown
    >;
    const user = this.sessionUser;
    if (user === null) {
      await RpcServer.fail(route, 401, "UNAUTHORIZED");
      return;
    }
    switch (procedure) {
      case "organization/listMine":
        await RpcServer.ok(route, { organizations: [ORGANIZATION] });
        return;
      case "device/register": {
        this.registered += 1;
        const id = uuid(7000 + this.registered);
        this.devices.set(id, user);
        await RpcServer.ok(route, { device: { id } });
        return;
      }
      case "device/check":
        this.checked += 1;
        if (this.deviceCheckAnswer === "error") {
          await RpcServer.fail(route, 500, "INTERNAL_SERVER_ERROR");
        } else if (
          this.deviceCheckAnswer === "not-found" ||
          this.devices.get(String(input.deviceId)) !== user
        ) {
          await RpcServer.fail(route, 404, "NOT_FOUND");
        } else {
          await RpcServer.ok(route, { device: { id: input.deviceId } });
        }
        return;
      case "offline/issueLease":
        await RpcServer.ok(
          route,
          await this.issueLease(user, String(input.deviceId))
        );
        return;
      case "sync/push":
        await this.answerPush(route, input);
        return;
      case "sync/getCursor":
        await RpcServer.ok(route, { cursor: await this.stock.getCursor() });
        return;
      case "sync/bootstrapPage": {
        const page = await this.stock.page(
          input.collection as "products",
          input as { ids?: string[] }
        );
        await RpcServer.ok(route, { collection: input.collection, ...page });
        return;
      }
      case "sync/pull":
        await RpcServer.ok(
          route,
          await this.stock.pull(String(input.cursor), Number(input.limit))
        );
        return;
      case "sale/list":
        await RpcServer.ok(route, { sales: await this.stock.recentSales() });
        return;
      case "paymentProfile/list":
        await RpcServer.ok(route, { profiles: [] });
        return;
      default:
        // nothing else is needed to open the sale screen: anything more is a gap in this test
        await RpcServer.fail(route, 500, `NOT_PLAYED_${procedure}`);
    }
  }

  private async issueLease(userId: string, deviceId: string) {
    this.leasesIssued += 1;
    const issuedAt = new Date(Date.now() + this.clockOffsetMs);
    const expiresAt = new Date(issuedAt.getTime() + 72 * HOUR);
    const lease = await signOfflineLease(
      buildOfflineLeaseClaims({
        capabilities: ["sale:create", "customer:create", "inventory:adjust"],
        deviceId,
        epoch: 0,
        expiresAt,
        grantId: uuid(9000),
        issuedAt,
        organizationId: ORGANIZATION.id,
        userId,
      }),
      LAB_KEY
    );
    return { expiresAt: expiresAt.toISOString(), lease };
  }

  private async answerPush(route: Route, input: Record<string, unknown>) {
    const commands = input.commands as {
      commandId: string;
    }[];
    this.pushed.push(commands.map(({ commandId }) => ({ commandId })));
    if (this.pushAnswer === "unauthorized") {
      // the session ended between the lookup and the push: from now on every call is refused
      this.sessionUser = null;
      await RpcServer.fail(route, 401, "UNAUTHORIZED");
      return;
    }
    if (this.pushAnswer === "session_changed") {
      // what the server says when the lease of the command belongs to another user: nothing stored, nothing done
      await RpcServer.ok(route, {
        results: commands.map(({ commandId }, index) => ({
          code: index === 0 ? "session_changed" : null,
          commandId,
          replayed: false,
          result: null,
          status: index === 0 ? "rejected" : "not_processed",
        })),
      });
      return;
    }
    await RpcServer.ok(
      route,
      await this.stock.push(input as Parameters<SaleLabServer["push"]>[0])
    );
  }
}

const chip = (page: Page) => page.locator(".sync-status");

async function openSales(page: Page, server: RpcServer) {
  await server.install(page);
  await page.goto("/sales");
  await expect(
    page.getByRole("heading", { exact: true, name: "Nova venda" })
  ).toBeVisible();
  await expect(chip(page)).toContainText("Tudo sincronizado", {
    timeout: 20_000,
  });
}

async function goOffline(page: Page) {
  await page.context().setOffline(true);
  await expect(chip(page)).toContainText("Sem conexão", { timeout: 15_000 });
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

/** Opens the app, works offline and leaves `count` sales waiting on the device. */
async function queueSales(page: Page, count: number) {
  await goOffline(page);
  for (let sale = 1; sale <= count; sale += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: each sale is kept after the form of the previous one cleared
    await keepOneSale(page);
    await expect(chip(page)).toContainText(
      `Sem conexão · ${sale} ${sale === 1 ? "operação guardada" : "operações guardadas"}`
    );
  }
}

/** The commands the outbox (IndexedDB) holds, in queue order, whatever the namespace is called. */
async function outboxCommands(page: Page) {
  return await page.evaluate(async () => {
    const found: { commandId: string; status: string }[] = [];
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
        const rows = await new Promise<
          { commandId: string; seq: number; status: string }[]
        >((resolve, reject) => {
          const request = database
            .transaction("commands", "readonly")
            .objectStore("commands")
            .getAll();
          request.onerror = () => reject(request.error);
          request.onsuccess = () => resolve(request.result);
        });
        rows.sort((a, b) => a.seq - b.seq);
        found.push(
          ...rows.map(({ commandId, status }) => ({ commandId, status }))
        );
      }
      database.close();
    }
    return found;
  });
}

const stored = (page: Page, key: string) =>
  page.evaluate((name) => window.localStorage.getItem(name), key);

/** Whether the OPFS file of the local collections of this device exists. */
const collectionFiles = (page: Page) =>
  page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const names: string[] = [];
    for await (const name of (
      root as unknown as { keys: () => AsyncIterable<string> }
    ).keys()) {
      if (name.startsWith("polaris-local-") && name.endsWith(".sqlite")) {
        names.push(name);
      }
    }
    return names.length;
  });

test.describe("createRpcRuntimeApi no app real, com o servidor interceptado", () => {
  test("get-session 401 com duas operações na fila: nada é enviado, a fila fica intacta, o usuário lembrado é esquecido e a tela vai para a sessão encerrada", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const user = `user-${crypto.randomUUID()}`;
    const server = new RpcServer(user);
    await openSales(page, server);
    await queueSales(page, 2);
    const queued = await outboxCommands(page);
    expect(queued).toHaveLength(2);

    // the session ends while the work waits on the device; then the network returns
    server.sessionUser = null;
    await page.context().setOffline(false);

    // session_changed: the runtime stops, the app reads the organizations again and the server says no
    await expect(
      page.getByText("Sua sessão acabou. Entre de novo para continuar.").first()
    ).toBeVisible({ timeout: 20_000 });
    expect(server.pushed).toEqual([]); // a queue is never pushed for a session the server denies
    expect(await stored(page, SESSION_USER_KEY)).toBeNull();
    // Today a refused lookup stops the runtime but deletes nothing (the lease and
    // the collections stay under this user's own namespace, unusable without a
    // session): only a refusal of the server to a command wipes them (next test).
    expect(await stored(page, leaseKey(user))).not.toBeNull();
    expect(await collectionFiles(page)).toBe(1);
    // the queue is work nobody else can redo: same commands, same order, same IDs
    expect(await outboxCommands(page)).toEqual(queued);

    // the same person signs in again: the very same commands go out, once each
    server.sessionUser = user;
    await page.reload();
    // wait for the effect, not for the chip: "Tudo sincronizado" is also what the app shows before the queue is read
    await expect
      .poll(() => server.pushed.flat().length, { timeout: 30_000 })
      .toBe(queued.length);
    await expect
      .poll(() => outboxCommands(page), { timeout: 30_000 })
      .toEqual([]);
    expect(server.pushed.flat().map(({ commandId }) => commandId)).toEqual(
      queued.map(({ commandId }) => commandId)
    );
  });

  test("sessão encerrada com duas operações na fila: 'Entrar de novo' vai a /entrar sem passar pelo Sair, e a fila continua com as mesmas duas (AC-18)", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const user = `user-${crypto.randomUUID()}`;
    const server = new RpcServer(user);
    let signOutCalls = 0;
    await page.route("**/api/auth/sign-out", (route) => {
      signOutCalls += 1;
      return route.fulfill({ body: "{}", contentType: "application/json" });
    });
    await openSales(page, server);
    await queueSales(page, 2);
    const queued = await outboxCommands(page);
    expect(queued).toHaveLength(2);

    server.sessionUser = null;
    await page.context().setOffline(false);
    await expect(
      page.getByText("Sua sessão acabou. Entre de novo para continuar.").first()
    ).toBeVisible({ timeout: 20_000 });
    // the notice does not take the person anywhere by itself
    expect(new URL(page.url()).pathname).toBe("/sales");

    await page.getByRole("button", { name: "Entrar de novo" }).click();
    await page.waitForURL("**/entrar?motivo=sessao&voltar=/sales");
    await expect(
      page.getByRole("heading", { name: "Entrar no Polaris" })
    ).toBeVisible();
    expect(signOutCalls).toBe(0);
    // the work nobody else can redo is exactly where it was
    expect(await outboxCommands(page)).toEqual(queued);
    expect(
      await page.evaluate(() =>
        window.localStorage.getItem("polaris.offline.organizations")
      )
    ).toBeNull();
  });

  test("push 401 com duas operações na fila: o lease e as coleções são apagados, a fila fica", async ({
    page,
  }) => {
    // the other way a session ends: the server refuses the push itself (the session is still the same user to get-session)
    const user = `user-${crypto.randomUUID()}`;
    const server = new RpcServer(user);
    await openSales(page, server);
    await queueSales(page, 2);
    const queued = await outboxCommands(page);
    expect(await stored(page, leaseKey(user))).not.toBeNull();
    expect(await collectionFiles(page)).toBe(1);

    server.pushAnswer = "unauthorized";
    await page.context().setOffline(false);

    await expect(
      page.getByText("Sua sessão acabou. Entre de novo para continuar.").first()
    ).toBeVisible({ timeout: 20_000 });
    // the notice and the drop of the local copy are not one step: wait for the copy to go, then check the rest
    await expect.poll(() => stored(page, leaseKey(user))).toBeNull();
    await expect.poll(() => stored(page, SESSION_USER_KEY)).toBeNull();
    await expect.poll(() => collectionFiles(page)).toBe(0);
    expect(await outboxCommands(page)).toEqual(queued);
    // the copy of the organizations goes with the session, even if the person only closes the tab
    await expect
      .poll(() => stored(page, "polaris.offline.organizations"))
      .toBeNull();
  });

  test("get-session 429: o app segue com o usuário lembrado e o lease próprio, sem registrar outro aparelho", async ({
    page,
  }) => {
    const user = `user-${crypto.randomUUID()}`;
    const server = new RpcServer(user);
    await openSales(page, server);
    const device = await stored(page, DEVICE_KEY);
    const lease = await stored(page, leaseKey(user));
    expect(device).not.toBeNull();

    // throttling says nothing about who is signed in: it is "no answer", not a refusal
    server.sessionAnswer = "throttled";
    const before = server.sessionLookups;
    await page.reload();
    await expect(chip(page)).toContainText("Tudo sincronizado", {
      timeout: 20_000,
    });
    expect(server.sessionLookups).toBeGreaterThan(before);
    expect(server.registered).toBe(1);
    expect(await stored(page, DEVICE_KEY)).toBe(device);
    expect(await stored(page, SESSION_USER_KEY)).toBe(user);
    expect(await stored(page, leaseKey(user))).toBe(lease);
    await expect(page.getByLabel("Produto ou variante")).toBeVisible();
  });

  test("get-session lento (passa de 4 s): o app não espera e segue com o usuário lembrado e o lease próprio", async ({
    page,
  }) => {
    const user = `user-${crypto.randomUUID()}`;
    const server = new RpcServer(user);
    await openSales(page, server);
    const device = await stored(page, DEVICE_KEY);
    const lease = await stored(page, leaseKey(user));

    server.sessionAnswer = "slow";
    const before = server.sessionLookups;
    await page.reload();
    // the answer would take 30 s: opening within the timeout means the app gave up on it
    await expect(chip(page)).toContainText("Tudo sincronizado", {
      timeout: 20_000,
    });
    expect(server.sessionLookups).toBeGreaterThan(before);
    expect(server.registered).toBe(1);
    expect(await stored(page, DEVICE_KEY)).toBe(device);
    expect(await stored(page, SESSION_USER_KEY)).toBe(user);
    expect(await stored(page, leaseKey(user))).toBe(lease);
    await expect(page.getByLabel("Produto ou variante")).toBeVisible();
  });

  // ADR 0047 (emenda do 0044, L6): only an explicit refusal is "not mine". A
  // device the server does not know (404 NOT_FOUND) or one that belongs to
  // someone else (409 CONFLICT) is dropped with its lease, and the app registers
  // a new one for this user; any other failure is "no answer".
  test("device.check 404: o aparelho lembrado não é deste usuário, então é descartado e um novo é registrado", async ({
    page,
  }) => {
    const user = `user-${crypto.randomUUID()}`;
    const server = new RpcServer(user);
    await openSales(page, server);
    const device = await stored(page, DEVICE_KEY);

    server.deviceCheckAnswer = "not-found";
    await page.reload();
    await expect(chip(page)).toContainText("Tudo sincronizado", {
      timeout: 20_000,
    });
    expect(server.checked).toBeGreaterThan(0);
    expect(server.registered).toBe(2);
    const replaced = await stored(page, DEVICE_KEY);
    expect(replaced).not.toBeNull();
    expect(replaced).not.toBe(device);
    // the lease of the dropped device went with it: the one kept now names the new device
    const kept = JSON.parse((await stored(page, leaseKey(user))) ?? "null") as {
      lease: string;
    } | null;
    expect(kept).not.toBeNull();
    expect(readUnverifiedOfflineLease(String(kept?.lease))?.dev).toBe(replaced);
  });

  // A 500 (like a 429, a timeout or no connection) is the server that could not
  // answer, not a refusal: a user who already holds a lease for the device
  // keeps it and keeps working; the device is never lent to a user without one.
  test("device.check 500: sem resposta, o aparelho do próprio usuário fica e o app abre", async ({
    page,
  }) => {
    const user = `user-${crypto.randomUUID()}`;
    const server = new RpcServer(user);
    await openSales(page, server);
    const device = await stored(page, DEVICE_KEY);

    server.deviceCheckAnswer = "error";
    await page.reload();
    await expect(chip(page)).toContainText("Tudo sincronizado", {
      timeout: 20_000,
    });
    expect(server.checked).toBeGreaterThan(0);
    expect(server.registered).toBe(1);
    expect(await stored(page, DEVICE_KEY)).toBe(device);
  });

  test("device.check 500 para quem não tem lease do aparelho: falha fechada, o aparelho de outro usuário não é emprestado", async ({
    page,
  }) => {
    const first = `user-${crypto.randomUUID()}`;
    const server = new RpcServer(first);
    await openSales(page, server);
    const device = await stored(page, DEVICE_KEY);

    // another person signs in on the same browser, and the server cannot say whose the device is
    const second = `user-${crypto.randomUUID()}`;
    server.sessionUser = second;
    server.deviceCheckAnswer = "error";
    await page.reload();
    await expect(chip(page)).toContainText("Tudo sincronizado", {
      timeout: 20_000,
    });
    expect(server.registered).toBe(2);
    expect(await stored(page, DEVICE_KEY)).not.toBe(device);
    expect(server.devices.get(String(await stored(page, DEVICE_KEY)))).toBe(
      second
    );
  });

  test("push respondendo session_changed: o comando fica na fila com o mesmo ID e a venda precisa de atenção", async ({
    page,
  }) => {
    const user = `user-${crypto.randomUUID()}`;
    const server = new RpcServer(user);
    await openSales(page, server);
    await queueSales(page, 1);
    const [queued] = await outboxCommands(page);

    server.pushAnswer = "session_changed";
    await page.context().setOffline(false);

    await expect(
      page.getByText("Precisa de atenção", { exact: true })
    ).toBeVisible({
      timeout: 20_000,
    });
    await expect(chip(page)).toContainText("1 operação precisa de atenção");
    expect(server.pushed.flat()).toEqual([{ commandId: queued?.commandId }]);
    // not lost, not renumbered: the same command, now refused and kept for a person
    expect(await outboxCommands(page)).toEqual([
      { commandId: queued?.commandId, status: "rejected" },
    ]);
    // nothing reached the server's stock
    expect(server.stock.executions).toBe(0);
  });
});

test.describe("acesso sem internet vencido (AC-37, AC-38, emenda do ADR 0047)", () => {
  const EXPIRED_TITLE = "O acesso sem internet venceu";
  // a moment past the exp of the lease issued at the start (72 h)
  const PAST_EXP = 72 * HOUR + 1000;

  const notice = (page: Page) =>
    page.getByRole("heading", { name: EXPIRED_TITLE });
  const saleHeading = (page: Page) =>
    page.getByRole("heading", { exact: true, name: "Nova venda" });

  test("vence com o app aberto: o temporizador tira a venda na hora, a fila fica igual, e com a rede de volta o acesso se renova e a tela volta sem recarregar (AC-38)", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.clock.install();
    const user = `user-${crypto.randomUUID()}`;
    const server = new RpcServer(user);
    await openSales(page, server);
    await queueSales(page, 2);
    const queued = await outboxCommands(page);
    expect(queued).toHaveLength(2);
    const leases = server.leasesIssued;

    await page.clock.fastForward(PAST_EXP);

    await expect(notice(page)).toBeVisible();
    await expect(
      page.getByText(
        "Há 2 operações guardadas neste aparelho. Elas não se perdem."
      )
    ).toBeVisible();
    // no screen draws the copy and nothing new can be kept: the sale screen is gone
    await expect(saleHeading(page)).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Guardar venda neste aparelho" })
    ).toHaveCount(0);
    await expect(page.getByText(SHIRT_OPTION)).toHaveCount(0);
    // the remembered organization only drew the screen: hidden now
    await expect(page.locator(".app-org-name")).toHaveCount(0);
    await expect(chip(page)).toContainText("Conecte-se");
    // it ended with the app open: what was being put together is gone, and the notice says so
    await expect(
      page.getByText(
        "A venda que você estava montando não foi guardada. Quando o acesso voltar, monte de novo."
      )
    ).toBeVisible();
    await expect(
      page.getByText("Quando a internet voltar, o acesso volta sozinho.")
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Tentar agora" })
    ).toHaveCount(0);
    await expect(chip(page)).toHaveAttribute("title", EXPIRED_TITLE);
    expect(new URL(page.url()).pathname).toBe("/sales");
    expect(await outboxCommands(page)).toEqual(queued);
    expect(server.leasesIssued).toBe(leases); // no network, no try

    server.clockOffsetMs = PAST_EXP;
    await page.context().setOffline(false);

    await expect(saleHeading(page)).toBeVisible({ timeout: 30_000 });
    await expect(notice(page)).toHaveCount(0);
    await expect(
      page.getByRole("status").getByText("Acesso renovado.")
    ).toBeVisible();
    expect(server.leasesIssued).toBe(leases + 1);
    // the very same work goes out, once each
    await expect
      .poll(() => outboxCommands(page), { timeout: 30_000 })
      .toEqual([]);
    expect(server.pushed.flat().map(({ commandId }) => commandId)).toEqual(
      queued.map(({ commandId }) => commandId)
    );
    expect(new URL(page.url()).pathname).toBe("/sales");
  });

  test("aberto com o lease vencido e sem resposta do servidor: mostra o aviso com a fila, não vai a /entrar, não registra outro aparelho, e renova quando a conexão volta (AC-37)", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.clock.install();
    const user = `user-${crypto.randomUUID()}`;
    const server = new RpcServer(user);
    await openSales(page, server);
    await queueSales(page, 1);
    const queued = await outboxCommands(page);
    await page.clock.fastForward(PAST_EXP);
    await expect(notice(page)).toBeVisible();

    // a second visit, the device reaching no server at all
    server.connection = "down";
    await page.context().setOffline(false);
    await page.reload();

    await expect(notice(page)).toBeVisible({ timeout: 30_000 });
    await expect(
      page.getByText("Há 1 operação guardada neste aparelho. Ela não se perde.")
    ).toBeVisible();
    await expect(saleHeading(page)).toHaveCount(0);
    await expect(page.locator(".app-org-name")).toHaveCount(0);
    // opened already expired: nothing was being put together
    await expect(
      page.getByText("A venda que você estava montando não foi guardada.", {
        exact: false,
      })
    ).toHaveCount(0);
    // online but the server does not answer: the chip and the body do not ask for a connection that is already there
    await expect(chip(page)).toContainText("Sem acesso");
    await expect(
      page.getByText(
        "Este aparelho ficou muito tempo sem se conectar à internet.",
        { exact: true }
      )
    ).toBeVisible();
    // it says so and offers another try
    await expect(
      page.getByText(
        "Há internet, mas não conseguimos renovar o acesso agora. Vamos tentar de novo em instantes."
      )
    ).toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/sales");
    expect(await outboxCommands(page)).toEqual(queued);
    expect(server.registered).toBe(1);
    expect(await stored(page, leaseKey(user))).not.toBeNull();
    expect(await stored(page, SESSION_USER_KEY)).toBe(user);
    expect(await collectionFiles(page)).toBe(1);

    // the connection comes back
    server.connection = "up";
    server.clockOffsetMs = PAST_EXP;
    await page.getByRole("button", { name: "Tentar agora" }).click();

    await expect(saleHeading(page)).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(() => outboxCommands(page), { timeout: 30_000 })
      .toEqual([]);
    expect(server.pushed.flat().map(({ commandId }) => commandId)).toEqual(
      queued.map(({ commandId }) => commandId)
    );
  });
});
