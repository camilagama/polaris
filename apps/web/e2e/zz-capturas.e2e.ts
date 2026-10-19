import { mkdirSync } from "node:fs";
/// <reference lib="dom" />
import { buildOfflineLeaseClaims } from "@polaris/domain/offline/offline-lease";
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { signOfflineLease } from "../src/lib/offline-lease-token";

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
const REVOKE_BUTTON = /^Revogar o aparelho/;
const CONFIRM_ONE = "Sim, revogar este aparelho";
const CONFIRM_ALL = "Sim, revogar e encerrar as outras sessões";
const OTHER_SESSIONS = "Encerrar também as outras sessões";
const OFFLINE_NOTICE = /^Sem conexão\. Para revogar um aparelho/;
const TECHNICAL = /fresh_session_required|FORBIDDEN|UNAUTHORIZED|\b40[13]\b/;
const FORCED_EXIT = /sair assim mesmo|forç/i;
const CACHE_KEY = /organizations|paymentProfiles|periodSummary/;
const SECRET_IN_CONSOLE = /cookie|token|session[-_ ]?id|set-cookie/i;
const uuid = (n: number) =>
  `0199c2d0-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const device = (n: number, label: string | null, lastSeen: string) => ({
  createdAt: "2026-10-01T12:00:00.000Z",
  id: uuid(n),
  label,
  lastSeenAt: lastSeen,
  revokedAt: null,
});

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

type Answer =
  | { abort: true }
  | { endedCurrentSession?: boolean; endedSessionCount?: number }
  | { error: ReturnType<typeof rpcError> };

interface Scenario {
  /** The answers to "revogar", in order; the last one repeats. */
  answers: Answer[];
  devices: ReturnType<typeof device>[];
  /** The list fails on the network. */
  down: boolean;
  /** Holds the answer of the list until released. */
  listGate: Promise<void> | null;
  listCalls: number;
  /** The server no longer knows the session (it ended with the revoked device). */
  sessionDead: boolean;
  /** What the session lookup does once the session is dead. */
  sessionLookup: "answers" | "unreachable";
  revokeBodies: { deviceId: string; endOtherSessions?: boolean }[];
  signOutCalls: number;
  /** The sends answered 401 because the session is dead. */
  pushRefused: number;
}

function scenario(overrides: Partial<Scenario> = {}): Scenario {
  return {
    answers: [{}],
    devices: [],
    down: false,
    listCalls: 0,
    listGate: null,
    revokeBodies: [],
    sessionDead: false,
    sessionLookup: "answers",
    signOutCalls: 0,
    pushRefused: 0,
    ...overrides,
  };
}

const twoDevices = () => [
  device(1, "Caixa da loja", "2026-10-14T10:00:00.000Z"),
  device(2, "Celular da Ana", "2026-10-13T10:00:00.000Z"),
];
const threeDevices = () => [
  ...twoDevices(),
  device(3, "Tablet do estoque", "2026-10-12T10:00:00.000Z"),
];

const inputOf = (route: { request: () => { postDataJSON: () => unknown } }) =>
  (route.request().postDataJSON() as { json: Record<string, unknown> }).json;

/**
 * The server of the scenarios, by network interception: the organizations, the
 * session, this device (the first one), the lease, the sync and the devices. What
 * the app asks and is not here is unreachable.
 */
async function serve(page: Page, state: Scenario) {
  const refused = () => rpcError(401, "UNAUTHORIZED");
  // everything else the offline runtime asks for is unreachable here
  await page.route("**/rpc/**", (route) => route.abort("internetdisconnected"));
  await page.route("**/rpc/organization/listMine", (route) =>
    route.fulfill(
      state.sessionDead ? refused() : json({ organizations: ORGANIZATIONS })
    )
  );
  await page.route("**/rpc/device/list", async (route) => {
    state.listCalls += 1;
    if (state.listGate) {
      await state.listGate;
    }
    if (state.down) {
      await route.abort("internetdisconnected");
    } else if (state.sessionDead) {
      await route.fulfill(refused());
    } else {
      await route.fulfill(json({ devices: state.devices }));
    }
  });
  await page.route("**/rpc/device/revoke", async (route) => {
    const input = inputOf(route) as {
      deviceId: string;
      endOtherSessions?: boolean;
    };
    state.revokeBodies.push(input);
    const answer =
      state.answers[
        Math.min(state.revokeBodies.length, state.answers.length) - 1
      ] ?? {};
    if ("abort" in answer) {
      await route.abort("internetdisconnected");
      return;
    }
    if ("error" in answer) {
      await route.fulfill(answer.error);
      return;
    }
    const gone = state.devices.find((item) => item.id === input.deviceId);
    state.devices = state.devices.filter((item) => item.id !== input.deviceId);
    const endedCurrentSession = answer.endedCurrentSession ?? false;
    if (endedCurrentSession) {
      state.sessionDead = true;
    }
    await route.fulfill(
      json({
        device: { ...gone, revokedAt: "2026-10-14T13:00:00.000Z" },
        endedCurrentSession,
        endedSessionCount: answer.endedSessionCount ?? 0,
        revokedGrantIds: [uuid(900)],
      })
    );
  });
  await page.route("**/api/auth/get-session", async (route) => {
    if (state.sessionDead && state.sessionLookup === "unreachable") {
      await route.abort("internetdisconnected");
    } else if (state.sessionDead) {
      await route.fulfill({ body: "null", contentType: "application/json" });
    } else {
      await route.fulfill({
        body: JSON.stringify({ user: { id: USER_ID } }),
        contentType: "application/json",
      });
    }
  });
  await page.route("**/api/auth/sign-out", (route) => {
    state.signOutCalls += 1;
    return route.fulfill({ body: "{}", contentType: "application/json" });
  });
  await page.route("**/rpc/device/register", (route) =>
    route.fulfill(json({ device: twoDevices()[0] }))
  );
  await page.route("**/rpc/device/check", (route) =>
    route.fulfill(json({ device: twoDevices()[0] }))
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
  await page.route("**/rpc/sync/push", (route) => {
    if (state.sessionDead) {
      state.pushRefused += 1;
      return route.fulfill(refused());
    }
    return route.abort("internetdisconnected");
  });
}

/** What the page printed: nothing in it may be a cookie, a token or a session id. */
function watchConsole(page: Page): string[] {
  const lines: string[] = [];
  page.on("console", (message) => lines.push(message.text()));
  page.on("pageerror", (error) => lines.push(error.message));
  return lines;
}

/** How many operations the outbox of this browser holds, whoever's namespace it is. */
function queuedOperations(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const open = (name: string) =>
      new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(name);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    let total = 0;
    for (const info of await indexedDB.databases()) {
      if (info.name?.startsWith("polaris-outbox-")) {
        // biome-ignore lint/performance/noAwaitInLoops: a handful of databases, one at a time
        const database = await open(info.name);
        total += await new Promise<number>((resolve, reject) => {
          const request = database
            .transaction("commands")
            .objectStore("commands")
            .count();
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        database.close();
      }
    }
    return total;
  });
}

const deviceItems = (page: Page) =>
  page.getByRole("list", { name: "Aparelhos" }).getByRole("listitem");
const chip = (page: Page) => page.locator(".sync-status");
const askRevoke = (page: Page, name: string) =>
  page.getByRole("button", { name: `Revogar o aparelho ${name}` });
const confirmButton = (page: Page, text = CONFIRM_ONE) =>
  page.getByRole("button", { exact: true, name: text });

/** Opens the customers screen with the real runtime ready, and queues operations while offline. */
async function queueCustomers(page: Page, count: number) {
  await page.goto("/customers");
  await expect(chip(page)).toContainText("Tudo sincronizado", {
    timeout: 20_000,
  });
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

async function openDevices(page: Page, state: Scenario) {
  await serve(page, state);
  await page.goto("/devices");
}


const OUT = `${process.env.HOME}/tasks/t074-telas`;
mkdirSync(OUT, { recursive: true });
const VIEWS = [
  { name: "celular-390x844", size: { height: 844, width: 390 } },
  { name: "desktop-1280x800", size: { height: 800, width: 1280 } },
];

async function shot(page: Page, name: string, view: (typeof VIEWS)[number]) {
  await page.waitForTimeout(300);
  await page.screenshot({
    fullPage: true,
    path: `${OUT}/${name}-${view.name}.png`,
  });
}

for (const view of VIEWS) {
  test(`capturas ${view.name}`, async ({ page }) => {
    await page.setViewportSize(view.size);
    const forbidden = rpcError(403, "FORBIDDEN", "fresh_session_required");

    // carregando
    let release: () => void = () => undefined;
    const loadingState = scenario({
      devices: threeDevices(),
      listGate: new Promise<void>((resolve) => { release = resolve; }),
    });
    await openDevices(page, loadingState);
    await expect(page.getByText("Carregando seus aparelhos…")).toBeVisible();
    await shot(page, "01-carregando", view);
    release();
    await expect(deviceItems(page)).toHaveCount(3);
    await expect(chip(page)).toContainText("Tudo sincronizado", { timeout: 20000 });
    await shot(page, "02-lista", view);

    // confirmação desmarcada e marcada
    await askRevoke(page, "Celular da Ana").click();
    await shot(page, "03-confirmacao-desmarcada", view);
    await page.getByLabel(OTHER_SESSIONS).check();
    await shot(page, "04-confirmacao-marcada", view);

    // sem conexão com a confirmação aberta
    await page.context().setOffline(true);
    await expect(page.getByText(OFFLINE_NOTICE)).toBeVisible();
    await shot(page, "05-offline-com-confirmacao", view);
    await page.context().setOffline(false);
  });

  test(`capturas resultado ${view.name}`, async ({ page }) => {
    await page.setViewportSize(view.size);
    const state = scenario({
      answers: [
        { error: rpcError(500, "INTERNAL_SERVER_ERROR") },
        { endedSessionCount: 2 },
      ],
      devices: threeDevices(),
    });
    await openDevices(page, state);
    await expect(deviceItems(page)).toHaveCount(3);
    await askRevoke(page, "Celular da Ana").click();
    await page.getByLabel(OTHER_SESSIONS).check();
    await confirmButton(page, CONFIRM_ALL).click();
    await expect(page.getByText("repetir é seguro")).toBeVisible();
    await shot(page, "06-resultado-incerto", view);
    await confirmButton(page, CONFIRM_ALL).click();
    await expect(page.getByText("2 sessões encerradas.")).toBeVisible();
    await shot(page, "07-sucesso", view);
  });

  test(`capturas vazio e erro ${view.name}`, async ({ page }) => {
    await page.setViewportSize(view.size);
    const empty = scenario({ down: true });
    await openDevices(page, empty);
    await expect(page.getByText("Não foi possível carregar os aparelhos")).toBeVisible();
    await shot(page, "08-erro-de-carga", view);
    empty.down = false;
    await page.getByRole("button", { name: "Tentar novamente" }).click();
    await expect(page.getByText("Nenhum aparelho registrado")).toBeVisible();
    await shot(page, "09-vazio", view);
  });

  test(`capturas entre de novo ${view.name}`, async ({ page }) => {
    await page.setViewportSize(view.size);
    const state = scenario({
      answers: [{ error: rpcError(403, "FORBIDDEN", "fresh_session_required") }, { error: rpcError(401, "UNAUTHORIZED") }],
      devices: twoDevices(),
    });
    await openDevices(page, state);
    await expect(deviceItems(page)).toHaveCount(2);
    await askRevoke(page, "Celular da Ana").click();
    await confirmButton(page).click();
    await expect(page.getByText("Nada foi revogado")).toBeVisible();
    await shot(page, "10-entre-de-novo-login-antigo", view);
    await page.getByRole("button", { name: "Agora não" }).click();
    await askRevoke(page, "Celular da Ana").click();
    await confirmButton(page).click();
    await expect(page.getByText("Sua sessão acabou")).toBeVisible();
    await shot(page, "11-sessao-acabou", view);
  });

  test(`capturas navegador saiu ${view.name}`, async ({ page }) => {
    await page.setViewportSize(view.size);
    const state = scenario({
      answers: [{ endedCurrentSession: true, endedSessionCount: 2 }],
      devices: twoDevices(),
    });
    await serve(page, state);
    await queueCustomers(page, 2);
    await page.goto("/devices");
    await expect(chip(page)).toContainText("2 operações guardadas");
    await askRevoke(page, "Celular da Ana").click();
    await shot(page, "12-confirmacao-com-fila", view);
    await confirmButton(page).click();
    await expect(page.getByText("Este navegador também saiu")).toBeVisible();
    await shot(page, "13-este-navegador-saiu", view);
  });
}
