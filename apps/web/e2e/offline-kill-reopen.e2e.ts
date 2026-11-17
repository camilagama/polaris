/// <reference lib="dom" />

import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserContext, Page, Route } from "@playwright/test";
import { chromium, devices, expect, test } from "@playwright/test";
import { buildOfflineLeaseClaims } from "@polaris/domain/offline/offline-lease";
import { signOfflineLease } from "../src/lib/offline-lease-token";
import { OFFLINE_POC_ORIGIN } from "./run-settings";
import { WORKER_MARK } from "./worker-mark";

/**
 * The browser dies in the middle of a send and comes back on the same data folder (profile on disk): the queue
 * is whole, the command that was being sent is still the head, and once the network is back the server
 * confirms each command once. The server is played by network interception that outlives the browser.
 */

const ORGANIZATION_ID = "0199c2d0-0000-7000-8000-00000000a001";
const USER_ID = "user-do-teste";
const LEASE_KEY = {
  id: "teste",
  secret: "teste-secret-teste-secret-teste-secret-0123456789",
};
const HOUR = 3_600_000;
const NOW = new Date("2026-11-17T15:00:00.000Z");
const QUEUED = 3;
const NUMERIC = /^\d+$/;
const OUTBOX_DATABASE_PREFIX = "polaris-outbox-";

const uuid = (n: number) =>
  `0199c2d0-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const json = (body: unknown, status = 200) => ({
  body: JSON.stringify({ json: body, meta: [] }),
  contentType: "application/json",
  headers: { ...WORKER_MARK },
  status,
});
const inputOf = (route: Route) =>
  (route.request().postDataJSON() as { json: Record<string, unknown> }).json;

interface DiskCommand {
  commandId: string;
  seq: number;
  status: string;
}

/**
 * What `sync.push` does: reach the server, fail on the network, hang with no answer (the request is in flight), or
 * hang after the server has already stored the commands (the answer is lost).
 */
type PushMode = "hang" | "keep-then-hang" | "cut" | "ok";

/** The server of a test; each browser the test opens talks to the same one. */
class Server {
  pushMode: PushMode = "ok";
  /** Answers a repeat of a stored command as a new one: the duplicate that the idempotency must prevent. */
  repeatsAsNew = false;
  /** The ids of every `sync.push` that arrived, in order, whatever it was answered. */
  readonly pushes: string[][] = [];
  /** Per command id, how many times the server took it as new (a repeat of one it has is a replay). */
  readonly accepted = new Map<string, number>();
  readonly replayed: string[] = [];
  private readonly devices = new Map<string, unknown>();
  private serial = 100;

  async install(context: BrowserContext) {
    const answered = (body: unknown) => ({
      body: JSON.stringify(body),
      contentType: "application/json",
      headers: { ...WORKER_MARK },
    });
    await context.route("**/health", (route) =>
      route.fulfill(answered({ status: "ok" }))
    );
    await context.route("**/rpc/**", (route) =>
      route.abort("internetdisconnected")
    );
    await context.route("**/api/auth/get-session", (route) =>
      route.fulfill(answered({ user: { id: USER_ID } }))
    );
    await context.route("**/rpc/organization/listMine", (route) =>
      route.fulfill(
        json({
          organizations: [
            {
              id: ORGANIZATION_ID,
              name: "Loja do teste",
              role: "owner",
              timezone: "America/Sao_Paulo",
            },
          ],
        })
      )
    );
    await context.route("**/rpc/device/list", (route) =>
      route.fulfill(json({ devices: [...this.devices.values()] }))
    );
    await context.route("**/rpc/device/register", async (route) => {
      this.serial += 1;
      const now = NOW.toISOString();
      const device = {
        createdAt: now,
        id: uuid(this.serial),
        label: "Navegador do teste",
        lastSeenAt: now,
        revokedAt: null,
      };
      this.devices.set(device.id, device);
      await route.fulfill(json({ device }));
    });
    await context.route("**/rpc/device/check", async (route) => {
      const { deviceId } = inputOf(route) as { deviceId: string };
      const device = this.devices.get(deviceId);
      await route.fulfill(
        device
          ? json({ device })
          : json(
              {
                code: "NOT_FOUND",
                defined: false,
                message: "NOT_FOUND",
                status: 404,
              },
              404
            )
      );
    });
    await context.route("**/rpc/offline/issueLease", async (route) => {
      const input = inputOf(route) as {
        deviceId: string;
        organizationId: string;
      };
      const issuedAt = NOW;
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
    await context.route("**/rpc/sync/getCursor", (route) =>
      route.fulfill(json({ cursor: "0" }))
    );
    await context.route("**/rpc/sync/bootstrapPage", (route) =>
      route.fulfill(
        json({
          collection: (inputOf(route) as { collection: string }).collection,
          nextAfterId: null,
          rows: [],
        })
      )
    );
    await context.route("**/rpc/sync/pull", (route) =>
      route.fulfill(json({ changes: [], hasMore: false, nextCursor: "0" }))
    );
    await context.route("**/rpc/sale/list", (route) =>
      route.fulfill(json({ sales: [] }))
    );
    await context.route("**/rpc/sync/push", async (route) => {
      const { commands } = inputOf(route) as {
        commands: { commandId: string }[];
      };
      this.pushes.push(commands.map(({ commandId }) => commandId));
      if (this.pushMode === "keep-then-hang") {
        for (const { commandId } of commands) {
          this.accepted.set(commandId, (this.accepted.get(commandId) ?? 0) + 1);
        }
      }
      if (this.pushMode === "hang" || this.pushMode === "keep-then-hang") {
        await new Promise<never>(() => undefined);
      }
      if (this.pushMode === "cut") {
        await route.abort("internetdisconnected");
        return;
      }
      const results = commands.map(({ commandId }) => {
        const seen = this.accepted.get(commandId) ?? 0;
        const replayed = seen > 0 && !this.repeatsAsNew;
        if (replayed) {
          this.replayed.push(commandId);
        } else {
          this.accepted.set(commandId, seen + 1);
        }
        return {
          code: null,
          commandId,
          replayed,
          result: null,
          status: "accepted",
        };
      });
      await route.fulfill(json({ results }));
    });
  }
}

const chip = (page: Page) => page.locator(".sync-status");

/** The commands of every outbox database of the page, in the order they were kept, as they are on disk. */
async function commandsOnDisk(page: Page): Promise<DiskCommand[]> {
  return await page.evaluate(async (prefix) => {
    const found: DiskCommand[] = [];
    for (const { name } of await indexedDB.databases()) {
      if (!name?.startsWith(prefix)) {
        continue;
      }
      // biome-ignore lint/performance/noAwaitInLoops: a handful of tiny databases
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(name);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
      });
      if (database.objectStoreNames.contains("commands")) {
        const rows = await new Promise<DiskCommand[]>((resolve, reject) => {
          const request = database
            .transaction("commands", "readonly")
            .objectStore("commands")
            .getAll();
          request.onerror = () => reject(request.error);
          request.onsuccess = () => resolve(request.result);
        });
        found.push(
          ...rows.map(({ commandId, seq, status }) => ({
            commandId,
            seq,
            status,
          }))
        );
      }
      database.close();
    }
    return found.sort((a, b) => a.seq - b.seq);
  }, OUTBOX_DATABASE_PREFIX);
}

/** The browsers and data folders of a test, closed and removed in the order that lets nothing write into a removed folder. */
class Workspace {
  private readonly contexts: BrowserContext[] = [];
  private readonly dirs: string[] = [];

  async newDir() {
    const dir = await mkdtemp(join(tmpdir(), "polaris-kill-reopen-"));
    this.dirs.push(dir);
    return dir;
  }

  async open(dataDir: string, server: Server) {
    const context = await chromium.launchPersistentContext(dataDir, {
      ...devices["Desktop Chrome"],
      baseURL: OFFLINE_POC_ORIGIN,
    });
    this.contexts.push(context);
    await context.clock.setFixedTime(NOW);
    await server.install(context);
    return { context, page: context.pages()[0] ?? (await context.newPage()) };
  }

  async dispose() {
    for (const context of this.contexts) {
      // biome-ignore lint/performance/noAwaitInLoops: one browser at a time
      await context.close().catch(() => undefined);
    }
    for (const dir of this.dirs) {
      // biome-ignore lint/performance/noAwaitInLoops: one folder at a time
      await rm(dir, {
        force: true,
        maxRetries: 5,
        recursive: true,
        retryDelay: 200,
      });
    }
  }
}

async function withWorkspace(run: (workspace: Workspace) => Promise<void>) {
  const workspace = new Workspace();
  try {
    await run(workspace);
  } finally {
    await workspace.dispose();
  }
}

async function createCustomer(page: Page, n: number) {
  await page.getByRole("button", { name: "Novo cliente" }).click();
  await page.locator("#customer-name").fill(`Cliente ${n}`);
  await page.locator("#customer-phone").fill(`1190000000${n}`);
  await page.getByRole("button", { name: "Cadastrar cliente" }).click();
}

/** Every process that was started on the data folder: the browser, which is what dies, and its helpers. */
function processesOn(dataDir: string) {
  return readdirSync("/proc")
    .filter((entry) => NUMERIC.test(entry))
    .flatMap((pid) => {
      try {
        const args = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
        return args.some((arg) => arg.includes(dataDir))
          ? [{ browser: !args.some((a) => a.startsWith("--type=")), pid }]
          : [];
      } catch {
        return [];
      }
    });
}

/** SIGKILL: no `beforeunload`, no `pagehide`, no flush the page could have asked for; returns when the folder has no process left. */
async function killBrowser(dataDir: string) {
  const main = processesOn(dataDir).filter(({ browser }) => browser);
  if (main.length !== 1) {
    throw new Error(
      `expected one browser process on ${dataDir}, found ${main.length}`
    );
  }
  process.kill(Number(main[0]?.pid), "SIGKILL");
  await expect
    .poll(() => processesOn(dataDir).length, { timeout: 15_000 })
    .toBe(0);
}

/** Queue of three with the head in flight (the push never answers, stored by the server or not), then the browser dies. Returns what was on disk. */
async function queueAndKill(
  workspace: Workspace,
  dataDir: string,
  server: Server,
  inFlight: PushMode = "hang"
) {
  const { page } = await workspace.open(dataDir, server);
  await page.goto("/customers");
  await expect(chip(page)).toContainText("Tudo sincronizado", {
    timeout: 20_000,
  });

  const slow = { timeout: 15_000 };
  server.pushMode = inFlight;
  await createCustomer(page, 1);
  await expect.poll(() => server.pushes.length, slow).toBe(1);
  await expect
    .poll(async () => (await commandsOnDisk(page)).map((c) => c.status), slow)
    .toEqual(["sending"]);
  for (let n = 2; n <= QUEUED; n += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: the commands are queued in order
    await createCustomer(page, n);
    await expect
      .poll(async () => (await commandsOnDisk(page)).length, slow)
      .toBe(n);
  }

  const onDisk = await commandsOnDisk(page);
  expect(onDisk.map((c) => c.status)).toEqual([
    "sending",
    "pending",
    "pending",
  ]);
  await killBrowser(dataDir);
  return onDisk;
}

/** The same folder reopened: the queue as it is on disk before the app starts, then the one send that follows. */
async function reopenAndAccept(
  workspace: Workspace,
  dataDir: string,
  server: Server,
  before: DiskCommand[],
  storedBeforeDeath = 0
) {
  server.pushMode = "cut";
  const pushesBefore = server.pushes.length;
  const { page } = await workspace.open(dataDir, server);
  // a page of the same origin that does not start the app: nothing has recovered or sent anything yet
  await page.goto("/offline-outbox-lab");
  expect(await commandsOnDisk(page)).toEqual(before);
  expect(server.pushes.length).toBe(pushesBefore);

  server.pushMode = "ok";
  await page.goto("/customers");
  await expect(chip(page)).toContainText("Tudo sincronizado", {
    timeout: 30_000,
  });
  const ids = before.map(({ commandId }) => commandId);
  expect(server.pushes.slice(pushesBefore)).toEqual([ids]);
  expect([...server.accepted]).toEqual(ids.map((id) => [id, 1]));
  expect(server.replayed).toEqual(ids.slice(0, storedBeforeDeath));
  expect(await commandsOnDisk(page)).toEqual([]);
  await expect(page.locator('[data-sync-state="rejected"]')).toHaveCount(0);
}

test.describe("matar o navegador no meio de um envio", () => {
  test.skip(
    ({ browserName }) =>
      browserName !== "chromium" || process.platform !== "linux",
    "só o Chromium de mesa no Linux: o processo a derrubar se acha por /proc"
  );
  test.describe.configure({ timeout: 120_000 });

  test("a fila volta inteira, o comando que estava em envio continua o primeiro e o servidor confirma cada um uma vez", async () => {
    await withWorkspace(async (workspace) => {
      const dataDir = await workspace.newDir();
      const server = new Server();
      const before = await queueAndKill(workspace, dataDir, server);
      await reopenAndAccept(workspace, dataDir, server, before);
    });
  });

  test("controle: reaberto numa pasta de dados vazia, o teste reprova na primeira conferência", async () => {
    await withWorkspace(async (workspace) => {
      const dataDir = await workspace.newDir();
      const emptyDir = await workspace.newDir();
      const server = new Server();
      const before = await queueAndKill(workspace, dataDir, server);
      await expect(
        reopenAndAccept(workspace, emptyDir, server, before)
      ).rejects.toMatchObject({
        matcherResult: expect.objectContaining({
          actual: [],
          expected: before,
          pass: false,
        }),
      });
    });
  });

  test("o servidor gravou e a resposta se perdeu: na reabertura o envio volta como repetido, a fila esvazia e nada grava duas vezes", async () => {
    await withWorkspace(async (workspace) => {
      const dataDir = await workspace.newDir();
      const server = new Server();
      const before = await queueAndKill(
        workspace,
        dataDir,
        server,
        "keep-then-hang"
      );
      const head = before[0]?.commandId;
      expect(server.pushes).toEqual([[head]]);
      expect([...server.accepted]).toEqual([[head, 1]]);
      await reopenAndAccept(workspace, dataDir, server, before, 1);
    });
  });

  test("controle: se o servidor responde à repetição como comando novo, o teste acusa a duplicata", async () => {
    await withWorkspace(async (workspace) => {
      const dataDir = await workspace.newDir();
      const server = new Server();
      const before = await queueAndKill(
        workspace,
        dataDir,
        server,
        "keep-then-hang"
      );
      const head = before[0]?.commandId;
      server.repeatsAsNew = true;
      await expect(
        reopenAndAccept(workspace, dataDir, server, before, 1)
      ).rejects.toMatchObject({
        matcherResult: expect.objectContaining({
          actual: expect.arrayContaining([[head, 2]]),
          pass: false,
        }),
      });
    });
  });
});
