/// <reference lib="dom" />

import type { BrowserContext, Page, Route } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { buildOfflineLeaseClaims } from "@polaris/domain/offline/offline-lease";
import { signOfflineLease } from "../src/lib/offline-lease-token";
import { deviceFamilyLabel } from "../src/server/device-family-label";
import { serveHealth, WORKER_MARK } from "./worker-mark";

/**
 * "Sair" revokes this device (ADR 0048, emenda de 22/10; U-50 and U-51), against a server played by network
 * interception that keeps its state across the pages of a test: the devices, the session of each browser, the queue.
 * The real server, its database and the gate `device-sessions` are proven elsewhere; here it is the order of the
 * requests, what the browser sends and what the screen shows.
 */

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
  headers: { ...WORKER_MARK },
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
    await serveHealth(page);
    await page.route("**/rpc/**", (route) =>
      route.abort("internetdisconnected")
    );
    await page.route("**/api/auth/get-session", (route) =>
      route.fulfill(
        signedIn()
          ? {
              body: JSON.stringify({ user: { id: USER_ID } }),
              contentType: "application/json",
              headers: { ...WORKER_MARK },
            }
          : {
              body: "null",
              contentType: "application/json",
              headers: { ...WORKER_MARK },
            }
      )
    );
    await page.route("**/api/auth/sign-out", (route) => {
      this.log.push("sign-out");
      this.sessions.delete(context);
      return route.fulfill({
        body: "{}",
        contentType: "application/json",
        headers: { ...WORKER_MARK },
      });
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

const SIGNED_OUT_URL = /\/entrar\?motivo=saiu(&|$)/;
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

/** "Sair": at the foot of the sidebar on a wide screen, under "Mais" on a narrow one. */
async function clickSair(page: Page) {
  const more = page.getByRole("button", { exact: true, name: "Mais" });
  if (await more.isVisible()) {
    await more.click();
  }
  await page.getByRole("button", { exact: true, name: "Sair" }).click();
}

async function queueCustomers(page: Page, count: number) {
  await page.context().setOffline(true);
  for (let n = 1; n <= count; n += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: the operations are queued in order
    await page.getByRole("button", { name: "Novo cliente" }).click();
    await page.locator("#customer-name").fill(`Cliente ${n}`);
    await page.locator("#customer-phone").fill(`1190000000${n}`);
    await page.getByRole("button", { name: "Cadastrar cliente" }).click();
    await expect(chip(page)).toContainText(
      `${n} ${n === 1 ? "operação guardada" : "operações guardadas"}`
    );
  }
  await page.context().setOffline(false);
}

const storedDevice = (page: Page) =>
  page.evaluate(() => window.localStorage.getItem("polaris.offline.device"));

/** The id is gone once the page that follows the Sair has loaded; a read during the navigation is retried. */
async function deviceForgotten(page: Page) {
  await expect
    .poll(() => storedDevice(page).catch(() => "navegando"), {
      timeout: 15_000,
    })
    .toBeNull();
}

async function signedOut(page: Page) {
  await expect
    .poll(() => new URL(page.url()).pathname, { timeout: 15_000 })
    .not.toBe("/customers");
}

test("sair com conexão revoga este aparelho com o id dele, e o login seguinte registra um só: a lista mostra um cartão", async ({
  page,
}) => {
  const server = new Server();
  await openApp(page, server);
  const deviceId = await storedDevice(page);
  expect(deviceId).not.toBeNull();

  await clickSair(page);
  await signedOut(page);
  // the screen after "Sair" says the person left, not that the session ended (U-01: the flow wrote the `saiu` mark)
  await page.waitForURL(SIGNED_OUT_URL);
  await expect(
    page.getByText("Você saiu. Entre de novo quando quiser.", { exact: true })
  ).toBeVisible();
  await expect(page.locator("body")).not.toContainText("sessão acabou");
  expect(server.log.filter((line) => line !== "check")).toEqual([
    "register",
    `revokeCurrent ${deviceId}`,
    "sign-out",
  ]);
  await deviceForgotten(page);

  // the same person signs in again on the same browser
  server.signIn(page.context());
  await openApp(page, server);
  expect(server.log.filter((line) => line === "register")).toHaveLength(2);
  await page.goto("/devices");
  await expect(deviceItems(page)).toHaveCount(1);
  await expect(deviceItems(page).first()).toContainText("Este aparelho");
});

test("sair sem conexão não chama a revogação e sai como antes; o registro antigo fica na lista", async ({
  page,
}) => {
  const server = new Server();
  await openApp(page, server);
  // the sign-out still needs the server: only the revocation is skipped when the browser says it is offline
  await page.evaluate(() => {
    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      get: () => false,
    });
  });
  await clickSair(page);
  await signedOut(page);
  expect(server.log.some((line) => line.startsWith("revokeCurrent"))).toBe(
    false
  );
  expect(server.log).toContain("sign-out");
  expect(server.live()).toHaveLength(1);
});

test("sair com 2 operações na fila: primeiro envia, depois revoga, depois encerra", async ({
  page,
}) => {
  const server = new Server();
  await openApp(page, server);
  server.pushReaches = false;
  await queueCustomers(page, 2);
  server.pushReaches = true;
  const deviceId = await storedDevice(page);

  await clickSair(page);
  await signedOut(page);
  const steps = server.log.filter(
    (line) =>
      line === "push" || line.startsWith("revokeCurrent") || line === "sign-out"
  );
  expect(steps.at(-2)).toBe(`revokeCurrent ${deviceId}`);
  expect(steps.at(-1)).toBe("sign-out");
  expect(steps.indexOf("push")).toBeLessThan(
    steps.indexOf(`revokeCurrent ${deviceId}`)
  );
  expect(server.pushAccepted).toBe(2);
});

test("com o envio falhando, o diálogo aparece e nada é revogado", async ({
  page,
}) => {
  const server = new Server();
  await openApp(page, server);
  server.pushReaches = false;
  await queueCustomers(page, 2);

  await clickSair(page);
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("2 operações");
  expect(server.log.some((line) => line.startsWith("revokeCurrent"))).toBe(
    false
  );
  expect(server.log).not.toContain("sign-out");
  expect(await storedDevice(page)).not.toBeNull();
});

test("no celular, fechar Mais antes da resposta do Sair não esconde o aviso da fila: Mais abre de novo", async ({
  page,
}) => {
  await page.setViewportSize({ height: 740, width: 360 });
  const server = new Server();
  await openApp(page, server);
  server.pushReaches = false;
  await queueCustomers(page, 2);
  // the send answers late, after the person closed "Mais"
  await page.route("**/rpc/sync/push", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.fallback();
  });

  await clickSair(page);
  const sheet = page.getByRole("dialog", { name: "Mais" });
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  await expect(sheet).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("alertdialog")).toContainText("2 operações");
  expect(server.log).not.toContain("sign-out");
});

for (const [name, answer] of [
  ["um 5xx", { code: "INTERNAL_SERVER_ERROR", status: 500 }],
  ["sem rede", "abort"],
  [
    "not_current_device",
    { code: "FORBIDDEN", reason: "not_current_device", status: 403 },
  ],
] as const) {
  test(`${name} na revogação ainda sai, sem erro na tela, e o id não fica guardado`, async ({
    page,
  }) => {
    const server = new Server();
    await openApp(page, server);
    server.revokeAnswer = answer;
    await clickSair(page);
    await signedOut(page);
    expect(server.log).toContain("sign-out");
    await deviceForgotten(page);
    await expect(page.locator("body")).not.toContainText(
      "não foi possível encerrar a sessão"
    );
  });
}

test("o aparelho iniciado depois da janela (vínculo `use`): o Sair recebe not_current_device e o duplicado volta, sem ser defeito", async ({
  page,
}) => {
  const server = new Server();
  await openApp(page, server);
  server.revokeAnswer = {
    code: "FORBIDDEN",
    reason: "not_current_device",
    status: 403,
  };
  await clickSair(page);
  await signedOut(page);
  server.signIn(page.context());
  server.revokeAnswer = "ok";
  await openApp(page, server);
  await page.goto("/devices");
  // the old record stays until it is revoked from another device; this one is marked
  await expect(deviceItems(page)).toHaveCount(2);
  await expect(
    deviceItems(page).filter({ hasText: "Este aparelho" })
  ).toHaveCount(1);
});

test("outro aparelho continua: depois do Sair de A, o envio de B é aceito", async ({
  browser,
}) => {
  const server = new Server();
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  try {
    const a = await contextA.newPage();
    const b = await contextB.newPage();
    await openApp(a, server);
    await openApp(b, server);
    expect(server.live()).toHaveLength(2);
    // B's operation waits in its queue while A leaves
    server.pushReaches = false;
    await queueCustomers(b, 1);

    await clickSair(a);
    await signedOut(a);
    expect(server.live()).toHaveLength(1);
    expect(server.pushAccepted).toBe(0);

    server.pushReaches = true;
    await b.reload();
    await expect(chip(b)).toContainText("Tudo sincronizado", {
      timeout: 20_000,
    });
    expect(server.pushAccepted).toBe(1);
  } finally {
    await contextA.close();
    await contextB.close();
  }
});

test("o nome padrão vem do navegador e do sistema, numa tabela fechada, e aparece na lista", async ({
  page,
  browserName,
}) => {
  const server = new Server();
  await openApp(page, server);
  const [headers] = server.registerHeaders;
  expect(headers).toBeDefined();
  const label = deviceFamilyLabel(new Headers(headers));
  // Playwright's Chromium names itself "Chromium" in the Client Hints, which is the unknown browser of the table;
  // its WebKit says Safari; the system is the one the project emulates (Windows for "Desktop Chrome")
  const userAgent = headers?.["user-agent"] ?? "";
  const expected = {
    chromium: userAgent.includes("Android")
      ? "Navegador no Android"
      : "Navegador no Windows",
    firefox: "Firefox no Linux",
    webkit: "Safari no Linux",
  }[browserName];
  expect(label).toBe(expected);
  // the whole User-Agent is never what the server keeps
  expect(server.devices[0]?.label).toBe(label);
  expect(server.devices[0]?.label?.length ?? 0).toBeLessThan(40);
  await page.goto("/devices");
  await expect(deviceItems(page).first()).toContainText(String(label));
});
