/// <reference lib="dom" />

import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { buildOfflineLeaseClaims } from "@polaris/domain/offline/offline-lease";
import { signOfflineLease } from "../src/lib/offline-lease-token";
import { serveHealth, WORKER_MARK } from "./worker-mark";

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

type Answer =
  | { abort: true; applied?: boolean }
  | { endedCurrentSession?: boolean; endedSessionCount?: number }
  | { error: ReturnType<typeof rpcError> };

interface Scenario {
  /** The answers to "revogar", in order; the last one repeats. */
  answers: Answer[];
  devices: ReturnType<typeof device>[];
  /** The list fails on the network. */
  down: boolean;
  listCalls: number;
  /** Holds the answer of the list until released. */
  listGate: Promise<void> | null;
  /** The sends answered 401 because the session is dead. */
  pushRefused: number;
  revokeBodies: { deviceId: string; endOtherSessions?: boolean }[];
  /** The server no longer knows the session (it ended with the revoked device). */
  sessionDead: boolean;
  /** What the session lookup does once the session is dead. */
  sessionLookup: "answers" | "unreachable";
  signOutCalls: number;
}

function scenario(overrides: Partial<Scenario> = {}): Scenario {
  return {
    answers: [{}],
    devices: [],
    down: false,
    listCalls: 0,
    listGate: null,
    pushRefused: 0,
    revokeBodies: [],
    sessionDead: false,
    sessionLookup: "answers",
    signOutCalls: 0,
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
  await serveHealth(page, () => state.down);
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
      if (answer.applied) {
        // the server did revoke it; only the answer was lost
        state.devices = state.devices.filter(
          (item) => item.id !== input.deviceId
        );
      }
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
      await route.fulfill({
        body: "null",
        contentType: "application/json",
        headers: { ...WORKER_MARK },
      });
    } else {
      await route.fulfill({
        body: JSON.stringify({ user: { id: USER_ID } }),
        contentType: "application/json",
        headers: { ...WORKER_MARK },
      });
    }
  });
  await page.route("**/api/auth/sign-out", (route) => {
    state.signOutCalls += 1;
    return route.fulfill({
      body: "{}",
      contentType: "application/json",
      headers: { ...WORKER_MARK },
    });
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
    // the Worker answers that it cannot take the push now: the connection is proven, the queue waits
    return route.fulfill(rpcError(503, "SERVICE_UNAVAILABLE"));
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

const transitionsEnded = (page: Page) =>
  page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter(
          (animation) =>
            animation.effect?.getComputedTiming().iterations !==
            Number.POSITIVE_INFINITY
        )
        // a cancelled animation rejects: it is over as well
        .map((animation) => animation.finished.catch(() => undefined))
    )
  );

async function openDevices(page: Page, state: Scenario) {
  await serve(page, state);
  await page.goto("/devices");
}

test("com a senha ligada, 'Segurança' vem depois da lista, com 'Trocar senha' como botão de 44 px (P6)", async ({
  page,
}) => {
  const state = scenario({ devices: twoDevices() });
  await page.route("**/api/auth-methods", (route) =>
    route.fulfill({
      body: JSON.stringify({
        emailPassword: true,
        google: true,
        turnstileSiteKey: null,
      }),
      contentType: "application/json",
      headers: { ...WORKER_MARK },
    })
  );
  await openDevices(page, state);

  const list = page.getByRole("list", { name: "Aparelhos" });
  await expect(list.getByRole("listitem")).toHaveCount(2);
  const section = page.getByRole("region", { name: "Segurança" });
  const link = section.getByRole("link", { name: "Trocar senha" });
  await expect(link).toHaveAttribute("href", "/conta/seguranca");
  const box = await link.boundingBox();
  // the outline button of the interface: 32 px with a mouse (36 with touch), and the 48 px touch area is the
  // guardrails' (check 2); it is still a button, not a link in a paragraph
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(32);
  // after the list, not in the paragraph of the heading
  const listBox = await list.boundingBox();
  expect(box?.y ?? 0).toBeGreaterThan(
    (listBox?.y ?? 0) + (listBox?.height ?? 0)
  );
  await expect(
    page
      .getByRole("heading", { level: 1, name: "Aparelhos" })
      .locator("..")
      .getByRole("link")
  ).toHaveCount(0);
  const shots = process.env.T166_SHOTS;
  if (shots && test.info().project.name === "chromium-desktop") {
    for (const [width, height] of [
      [360, 740],
      [1280, 800],
    ] as const) {
      // biome-ignore lint/performance/noAwaitInLoops: one size after the other on the same page
      await page.setViewportSize({ height, width });
      for (const scheme of ["light", "dark"] as const) {
        // biome-ignore lint/performance/noAwaitInLoops: one scheme after the other on the same page
        await page.emulateMedia({ colorScheme: scheme });
        await transitionsEnded(page);
        await page.screenshot({
          fullPage: true,
          path: `${shots}/aparelhos-seguranca-${width}-${scheme}.png`,
        });
      }
    }
  }
});

test("lista os aparelhos, pede confirmação clara e revoga um deles sem a opção", async ({
  page,
}) => {
  const state = scenario({ devices: twoDevices() });
  await openDevices(page, state);

  const list = page.getByRole("list", { name: "Aparelhos" });
  await expect(list.getByRole("listitem")).toHaveCount(2);
  await expect(list.getByRole("listitem").first()).toContainText(
    "Caixa da loja"
  );

  await askRevoke(page, "Celular da Ana").click();
  await expect(page.getByText("Não dá para desfazer")).toBeVisible();
  // nothing happened yet
  expect(state.revokeBodies).toHaveLength(0);
  expect(state.devices).toHaveLength(2);

  await confirmButton(page).click();
  await expect(
    page.getByText("Aparelho revogado. 1 permissão de uso offline cancelada.")
  ).toBeVisible();
  await expect(list.getByRole("listitem")).toHaveCount(1);
  await expect(list).not.toContainText("Celular da Ana");
  // the confirmation is gone: the focus stays on the page, not on the body
  await expect(page.getByRole("heading", { name: "Aparelhos" })).toBeFocused();
  // the option was not ticked: the call carries false
  expect(state.revokeBodies).toHaveLength(1);
  expect(state.revokeBodies[0]?.endOtherSessions ?? false).toBe(false);
});

test("com a opção marcada, a chamada leva endOtherSessions verdadeiro e o resultado conta as sessões", async ({
  page,
}) => {
  const state = scenario({
    answers: [{ endedSessionCount: 2 }],
    devices: twoDevices(),
  });
  await openDevices(page, state);

  await askRevoke(page, "Celular da Ana").click();
  const box = page.getByRole("checkbox", { name: OTHER_SESSIONS });
  await expect(box).not.toBeChecked();
  await expect(
    page.getByText("Quem estiver usando sua conta em outro aparelho")
  ).toHaveCount(0);
  await box.check();
  // the warning shows and the button says what it will do
  await expect(
    page.getByText("Quem estiver usando sua conta em outro aparelho")
  ).toBeVisible();
  await expect(confirmButton(page)).toHaveCount(0);
  await box.uncheck();
  await expect(confirmButton(page)).toBeVisible();
  await box.check();
  await confirmButton(page, CONFIRM_ALL).click();

  await expect(
    page.getByText(
      "Aparelho revogado. 1 permissão de uso offline cancelada. 2 acessos encerrados."
    )
  ).toBeVisible();
  expect(state.revokeBodies).toEqual([
    { deviceId: uuid(2), endOtherSessions: true },
  ]);
});

test("cancelar não chama o servidor, devolve o foco a Revogar, e a confirmação aberta é a única coisa ao alcance", async ({
  page,
}) => {
  const state = scenario({ devices: threeDevices() });
  await openDevices(page, state);

  await askRevoke(page, "Celular da Ana").click();
  const dialog = page.getByRole("dialog", {
    name: "Revogar este aparelho? (Celular da Ana)",
  });
  await expect(dialog).toContainText("Não dá para desfazer");
  // the focus went into the dialog, and the rest of the page is out of reach: one confirmation at a time
  await expect(dialog.locator(":focus")).toHaveCount(1);
  await expect(askRevoke(page, "Tablet do estoque")).toHaveCount(0);
  await expect(confirmButton(page)).toHaveCount(1);

  await page.getByRole("button", { name: "Cancelar" }).click();
  await expect(page.getByText("Não dá para desfazer")).toHaveCount(0);
  await expect(askRevoke(page, "Celular da Ana")).toBeFocused();
  expect(state.revokeBodies).toHaveLength(0);
  expect(state.devices).toHaveLength(3);
});

test("Esc fecha a confirmação como o Cancelar: nada é revogado e o foco volta a Revogar", async ({
  page,
}) => {
  const state = scenario({ devices: twoDevices() });
  await openDevices(page, state);

  await askRevoke(page, "Celular da Ana").click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(askRevoke(page, "Celular da Ana")).toBeFocused();
  expect(state.revokeBodies).toHaveLength(0);
});

test("a caixa vem desmarcada toda vez que a confirmação abre: depois de cancelar, de erro e de revogar outro", async ({
  page,
}) => {
  const state = scenario({
    answers: [{ error: rpcError(500, "INTERNAL_SERVER_ERROR") }, {}, {}],
    devices: threeDevices(),
  });
  await openDevices(page, state);
  const box = page.getByRole("checkbox", { name: OTHER_SESSIONS });

  // after cancelling
  await askRevoke(page, "Celular da Ana").click();
  await expect(box).not.toBeChecked();
  await box.check();
  await page.getByRole("button", { name: "Cancelar" }).click();
  await askRevoke(page, "Celular da Ana").click();
  await expect(box).not.toBeChecked();

  // an unknown outcome keeps the choice and repeating sends the same one
  await box.check();
  await confirmButton(page, CONFIRM_ALL).click();
  await expect(
    page.getByText(
      "Não conseguimos confirmar se o aparelho foi revogado. Feche este aviso e olhe a lista. Se o aparelho ainda aparecer, revogue de novo. Repetir é seguro."
    )
  ).toBeVisible();
  await expect(page.getByText("Aparelho revogado")).toHaveCount(0);
  await expect(box).toBeChecked();
  await confirmButton(page, CONFIRM_ALL).click();
  await expect(page.getByText("Aparelho revogado.")).toBeVisible();
  expect(state.revokeBodies.map((body) => body.endOtherSessions)).toEqual([
    true,
    true,
  ]);

  // after revoking another device
  await askRevoke(page, "Tablet do estoque").click();
  await expect(box).not.toBeChecked();
  await confirmButton(page).click();
  await expect(page.getByRole("list", { name: "Aparelhos" })).not.toContainText(
    "Tablet do estoque"
  );
  expect(state.revokeBodies.at(-1)?.endOtherSessions ?? false).toBe(false);
});

test("a opção só existe dentro da confirmação de outro aparelho, nunca no aparelho deste navegador", async ({
  page,
}) => {
  const state = scenario({ devices: twoDevices() });
  await openDevices(page, state);
  // this browser's device is known once the runtime has started
  await expect(chip(page)).toContainText("Tudo sincronizado", {
    timeout: 20_000,
  });
  const list = page.getByRole("list", { name: "Aparelhos" });
  await expect(list.getByRole("listitem").first()).toContainText(
    "Este aparelho"
  );
  await expect(
    page.getByRole("checkbox", { name: OTHER_SESSIONS })
  ).toHaveCount(0);
  await expect(page.getByRole("checkbox")).toHaveCount(0);
  // this device has no button: it leaves through "Sair"
  await expect(list.getByRole("listitem").first()).toContainText(
    "use Sair: no celular ele está em Mais; em tela grande, no menu ⋯ do cartão da loja, no pé da barra lateral"
  );
  await expect(askRevoke(page, "Caixa da loja")).toHaveCount(0);
  await askRevoke(page, "Celular da Ana").click();
  await expect(page.getByRole("checkbox")).toHaveCount(1);
  await expect(
    list.getByRole("listitem").first().getByRole("checkbox")
  ).toHaveCount(0);
});

test("mostra o carregando enquanto a lista não chega, sem lista, sem vazio e sem erro", async ({
  page,
}) => {
  let release: () => void = () => undefined;
  const state = scenario({
    devices: twoDevices(),
    listGate: new Promise<void>((resolve) => {
      release = resolve;
    }),
  });
  await openDevices(page, state);

  const loading = page.getByRole("status").filter({
    hasText: "Carregando seus aparelhos…",
  });
  await expect(loading).toBeVisible();
  await expect(loading).toHaveAttribute("aria-busy", "true");
  await expect(page.getByRole("list", { name: "Aparelhos" })).toHaveCount(0);
  await expect(page.getByText("Nenhum aparelho registrado")).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);

  release();
  await expect(loading).toHaveCount(0);
  await expect(deviceItems(page)).toHaveCount(2);
});

test("sem aparelhos mostra o vazio com o próximo passo, e nunca depois de um erro", async ({
  page,
}) => {
  const state = scenario({ down: true });
  await openDevices(page, state);
  await expect(
    page.getByText("Não foi possível carregar os aparelhos")
  ).toBeVisible();
  await expect(page.getByText("Nenhum aparelho registrado")).toHaveCount(0);

  state.down = false;
  await page.getByRole("button", { name: "Tentar novamente" }).click();
  await expect(
    page.getByText(
      "Nenhum aparelho registrado nesta conta. Um aparelho aparece aqui depois que você abre o Polaris nele com internet."
    )
  ).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("erro de carga: alerta com Tentar novamente, a tentativa recarrega e o aviso some", async ({
  page,
}) => {
  const state = scenario({ devices: twoDevices(), down: true });
  await openDevices(page, state);
  const alert = page.getByRole("alert").filter({
    hasText: "Não foi possível carregar os aparelhos",
  });
  await expect(alert).toBeVisible();
  await expect(page.getByRole("button", { name: REVOKE_BUTTON })).toHaveCount(
    0
  );

  // still down: the alert comes back
  await page.getByRole("button", { name: "Tentar novamente" }).click();
  await expect(alert).toBeVisible();

  state.down = false;
  await page.getByRole("button", { name: "Tentar novamente" }).click();
  await expect(alert).toHaveCount(0);
  await expect(deviceItems(page)).toHaveCount(2);
});

test("falhar ao revogar não esconde a lista já carregada", async ({ page }) => {
  const state = scenario({
    answers: [{ error: rpcError(500, "INTERNAL_SERVER_ERROR") }],
    devices: twoDevices(),
  });
  await openDevices(page, state);
  await askRevoke(page, "Celular da Ana").click();
  await confirmButton(page).click();
  await expect(page.getByRole("alert")).toContainText("Repetir é seguro");
  // the confirmation is a modal: the list stays under its veil, in place, and is only out of reach
  await expect(
    page
      .getByRole("list", { includeHidden: true, name: "Aparelhos" })
      .getByRole("listitem", { includeHidden: true })
  ).toHaveCount(2);
});

test("um 4xx definitivo diz o motivo sem prometer repetir", async ({
  page,
}) => {
  const state = scenario({
    answers: [{ error: rpcError(404, "NOT_FOUND") }],
    devices: twoDevices(),
  });
  await openDevices(page, state);
  await askRevoke(page, "Celular da Ana").click();
  await confirmButton(page).click();
  await expect(page.getByRole("alert")).toContainText(
    "já não existe ou já foi revogado"
  );
  await expect(page.getByRole("alert")).not.toContainText("repetir é seguro");
});

test("o botão de confirmar fica pendente durante a chamada e não reenvia", async ({
  page,
}) => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const state = scenario({ devices: twoDevices() });
  await openDevices(page, state);
  await page.route("**/rpc/device/revoke", async (route) => {
    await gate;
    await route.fallback();
  });
  await askRevoke(page, "Celular da Ana").click();
  await confirmButton(page).click();
  // while the call is out, the button says so and cannot be pressed again
  const pending = page.getByRole("button", { exact: true, name: "Revogando…" });
  await expect(pending).toBeDisabled();
  await pending.click({ force: true });
  release();
  await expect(page.getByText("Aparelho revogado.")).toBeVisible();
  expect(state.revokeBodies).toHaveLength(1);
});

test("sem conexão: um único aviso, tudo desabilitado, a confirmação aberta e a escolha ficam, e nada entra na fila", async ({
  page,
}) => {
  const state = scenario({ devices: twoDevices() });
  await openDevices(page, state);
  await expect(chip(page)).toContainText("Tudo sincronizado", {
    timeout: 20_000,
  });
  await askRevoke(page, "Celular da Ana").click();
  await page.getByRole("checkbox", { name: OTHER_SESSIONS }).check();
  const before = await queuedOperations(page);
  // the confirmation is open and modal: the list stays under its veil, in place, only out of reach
  const firstDevice = page
    .getByRole("list", { includeHidden: true, name: "Aparelhos" })
    .getByRole("listitem", { includeHidden: true })
    .first();

  await page.context().setOffline(true);
  await expect(page.getByText(OFFLINE_NOTICE)).toHaveCount(1);
  // this device's card stops promising that Sair takes it off the list
  await expect(firstDevice).toContainText(
    "Sair sem internet não tira este aparelho da lista."
  );
  await expect(
    page.getByText("Não foi possível carregar os aparelhos")
  ).toHaveCount(0);
  await expect(page.getByText("Não dá para desfazer")).toBeVisible();
  await expect(
    page.getByRole("checkbox", { name: OTHER_SESSIONS })
  ).toBeChecked();
  await expect(
    page.getByRole("checkbox", { name: OTHER_SESSIONS })
  ).toBeDisabled();
  await expect(confirmButton(page, CONFIRM_ALL)).toBeDisabled();
  expect(state.revokeBodies).toHaveLength(0);
  expect(await queuedOperations(page)).toBe(before);

  await page.context().setOffline(false);
  await expect(page.getByText(OFFLINE_NOTICE)).toHaveCount(0);
  await expect(firstDevice).toContainText("use Sair");
  await expect(
    page.getByRole("checkbox", { name: OTHER_SESSIONS })
  ).toBeChecked();
  await expect(confirmButton(page, CONFIRM_ALL)).toBeEnabled();
});

test("login antigo: o painel diz que nada foi revogado, não repete sozinho e um segundo clique chama de novo", async ({
  page,
}) => {
  const state = scenario({
    answers: [{ error: rpcError(403, "FORBIDDEN", "fresh_session_required") }],
    devices: twoDevices(),
  });
  const printed = watchConsole(page);
  await openDevices(page, state);
  await askRevoke(page, "Celular da Ana").click();
  await confirmButton(page).click();

  const panel = page.getByRole("alert").filter({
    hasText: "Entre de novo para continuar",
  });
  await expect(panel).toContainText("Nada foi revogado");
  await expect(panel).toContainText("15 minutos");
  await expect(panel).not.toContainText(TECHNICAL);
  await expect(page.getByText("tente de novo")).toHaveCount(0);
  await expect(deviceItems(page)).toHaveCount(2);
  // no automatic repetition
  await page.waitForTimeout(500);
  expect(state.revokeBodies).toHaveLength(1);

  // a login that is only old leaves the list as it is
  await expect(askRevoke(page, "Celular da Ana")).toBeEnabled();
  await expect(
    page.getByText("Entre de novo para usar esta lista.")
  ).toHaveCount(0);

  await panel.getByRole("button", { name: "Agora não" }).click();
  await expect(panel).toHaveCount(0);
  await askRevoke(page, "Celular da Ana").click();
  await confirmButton(page).click();
  await expect(panel).toBeVisible();
  expect(state.revokeBodies).toHaveLength(2);
  expect(printed.filter((line) => SECRET_IN_CONSOLE.test(line))).toEqual([]);
});

test("login antigo sem fila: Entrar de novo sai pela proteção do Sair e vai à entrada com o destino", async ({
  page,
}) => {
  const state = scenario({
    answers: [{ error: rpcError(403, "FORBIDDEN", "fresh_session_required") }],
    devices: twoDevices(),
  });
  await openDevices(page, state);
  await expect(chip(page)).toContainText("Tudo sincronizado", {
    timeout: 20_000,
  });
  await askRevoke(page, "Celular da Ana").click();
  await confirmButton(page).click();
  await page.getByRole("button", { name: "Entrar de novo" }).click();
  await page.waitForURL("**/entrar?motivo=recente&voltar=/devices");
  expect(state.signOutCalls).toBe(1);
});

test("login antigo com 2 operações na fila: o diálogo do Sair protege o trabalho e a sessão não acaba antes", async ({
  page,
}) => {
  const state = scenario({
    answers: [{ error: rpcError(403, "FORBIDDEN", "fresh_session_required") }],
    devices: twoDevices(),
  });
  await serve(page, state);
  await queueCustomers(page, 2);
  await page.goto("/devices");
  // the runtime of the page before may still be on the send it scheduled for the return of the connection
  await expect(chip(page)).toContainText("2 operações guardadas", {
    timeout: 15_000,
  });
  await askRevoke(page, "Celular da Ana").click();
  await confirmButton(page).click();
  await page.getByRole("button", { name: "Entrar de novo" }).click();

  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("Há trabalho que ainda não foi enviado");
  await expect(dialog).toContainText("2 operações");
  expect(state.signOutCalls).toBe(0);
  expect(await queuedOperations(page)).toBe(2);
  // there is no way out that throws the queue away without the two steps
  await expect(page.locator("body")).not.toContainText(FORCED_EXIT);
  // the only way to throw the queue away is the two steps, and the first one changes nothing
  await dialog.getByRole("button", { name: "Descartar e sair…" }).click();
  await expect(dialog).toContainText("Isto apaga 2 operações deste aparelho");
  expect(state.signOutCalls).toBe(0);
  expect(await queuedOperations(page)).toBe(2);
  await dialog.getByRole("button", { name: "Voltar" }).click();
  await dialog.getByRole("button", { name: "Ficar conectado" }).click();
  await expect(dialog).toHaveCount(0);
  expect(state.signOutCalls).toBe(0);
  expect(await queuedOperations(page)).toBe(2);
});

test("sessão que acabou durante a ação: painel próprio, sem passar pelo Sair, caches limpos e a fila fica", async ({
  page,
}) => {
  const state = scenario({
    answers: [{ error: rpcError(401, "UNAUTHORIZED") }],
    devices: twoDevices(),
  });
  await serve(page, state);
  await queueCustomers(page, 2);
  await page.goto("/devices");
  await expect(deviceItems(page)).toHaveCount(2);
  expect(
    await page.evaluate(() =>
      window.localStorage.getItem("polaris.offline.organizations")
    )
  ).not.toBeNull();
  await expect(chip(page)).toContainText("2 operações guardadas");
  state.sessionDead = true; // what the server answers from now on

  await askRevoke(page, "Celular da Ana").click();
  await confirmButton(page).click();
  const panel = page.getByRole("alert").filter({
    hasText: "Sua sessão acabou. Nada foi alterado.",
  });
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("button", { name: "Agora não" })).toHaveCount(0);
  // the list stays, but it is of no use without a session: "Revogar" is off and says why
  await expect(deviceItems(page)).toHaveCount(2);
  await expect(askRevoke(page, "Celular da Ana")).toBeDisabled();
  await expect(
    page.getByRole("status").filter({
      hasText: "Entre de novo para usar esta lista.",
    })
  ).toBeVisible();

  await panel.getByRole("button", { name: "Entrar de novo" }).click();
  await page.waitForURL("**/entrar?motivo=sessao&voltar=/devices");
  expect(state.signOutCalls).toBe(0);
  // leaving drops the lease and the collections too; the queue stays
  expect(await leaseKeys(page)).toEqual([]);
  expect(
    await page.evaluate(
      (pattern) =>
        Object.keys(window.localStorage).filter((key) =>
          new RegExp(pattern).test(key)
        ),
      CACHE_KEY.source
    )
  ).toEqual([]);
  expect(await queuedOperations(page)).toBe(2);
});

const rememberedUser = (page: Page) =>
  page.evaluate(() =>
    window.localStorage.getItem("polaris.offline.session-user")
  );

const leaseKeys = (page: Page) =>
  page.evaluate(() =>
    Object.keys(window.localStorage).filter((key) =>
      key.startsWith("polaris.offline.lease.")
    )
  );

/** Revokes the other device with 2 operations queued, the answer saying this browser left, then 401s. */
async function revokeAndLeave(
  page: Page,
  sessionLookup: Scenario["sessionLookup"]
) {
  const state = scenario({
    answers: [{ endedCurrentSession: true, endedSessionCount: 2 }],
    devices: twoDevices(),
    sessionLookup,
  });
  await serve(page, state);
  await queueCustomers(page, 2);
  await page.goto("/devices");
  // the runtime of the page before may still be on the send it scheduled for the return of the connection
  await expect(chip(page)).toContainText("2 operações guardadas", {
    timeout: 15_000,
  });
  await expect(deviceItems(page)).toHaveCount(2);
  expect(state.listCalls).toBeGreaterThan(0);
  // what the real storage (IndexedDB, where the queue lives) holds before the session ends
  const queuedBefore = await queuedOperations(page);
  expect(queuedBefore).toBe(2);
  const organizationsCache = await page.evaluate(() =>
    window.localStorage.getItem("polaris.offline.organizations")
  );

  await askRevoke(page, "Celular da Ana").click();
  await confirmButton(page).click();
  return { organizationsCache, queuedBefore, state };
}

for (const lookup of ["answers", "unreachable"] as const) {
  test(`este navegador saiu (${lookup === "answers" ? "a sessão responde que acabou" : "só o envio recebe 401"}): o painel fica, a lista não é lida de novo e as 2 operações continuam guardadas`, async ({
    page,
  }) => {
    const printed = watchConsole(page);
    const { queuedBefore, state } = await revokeAndLeave(page, lookup);
    const callsBefore = state.listCalls;

    const panel = page.getByRole("alert").filter({
      hasText: "Este navegador saiu da sua conta",
    });
    await expect(panel).toBeVisible();
    await expect(panel).toContainText("A revogação foi feita");
    await expect(panel).toContainText(
      "As operações que estavam guardadas neste aparelho continuam nele. Elas são enviadas quando você entrar de novo, com internet."
    );
    // the revoked device is not listed and nothing else needs a session
    await expect(page.getByRole("list", { name: "Aparelhos" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: REVOKE_BUTTON })).toHaveCount(
      0
    );
    await expect(
      page.getByRole("status").filter({ hasText: "Aparelho revogado" })
    ).toHaveCount(0);

    // the cached organizations are forgotten at once; the queue stays
    const cachedOrganizations = () =>
      page.evaluate(() =>
        window.localStorage.getItem("polaris.offline.organizations")
      );
    await expect.poll(cachedOrganizations).toBeNull();
    expect(await queuedOperations(page)).toBe(queuedBefore);

    // the next request is refused (401) too: nothing reads the list again
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect(chip(page)).not.toContainText("operações guardadas", {
      timeout: 20_000,
    });
    if (lookup === "unreachable") {
      // the send itself got the 401, and the runtime dropped the lease with it
      await expect.poll(() => state.pushRefused).toBeGreaterThan(0);
      await expect.poll(() => leaseKeys(page)).toEqual([]);
    }
    await page.waitForTimeout(1000);
    await expect(panel).toBeVisible();
    // the screen says it with its own panel; the shell adds no second notice
    await expect(page.locator('[data-notice="session-ended"]')).toHaveCount(0);
    expect(state.listCalls).toBe(callsBefore);
    // whatever way the 401 came, what was waiting is still waiting: the same count in the real storage
    expect(await queuedOperations(page)).toBe(queuedBefore);
    expect(printed.filter((line) => SECRET_IN_CONSOLE.test(line))).toEqual([]);

    await panel.getByRole("button", { name: "Entrar de novo" }).click();
    await page.waitForURL("**/entrar?motivo=sessao&voltar=/devices");
    expect(state.signOutCalls).toBe(0);
    expect(await queuedOperations(page)).toBe(queuedBefore);
  });
}

test("depois do 401 no envio, o início offline seguinte recusa: ninguém é lembrado, o lease some e a fila continua no disco", async ({
  page,
}) => {
  const { organizationsCache, queuedBefore, state } = await revokeAndLeave(
    page,
    "unreachable"
  );
  await expect(
    page.getByRole("alert").filter({
      hasText: "Este navegador saiu da sua conta",
    })
  ).toBeVisible();
  expect(await rememberedUser(page)).not.toBeNull();
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  // the 401 on the send: the runtime forgets the lease and who was signed in
  // the return goes through the probe and the sync ~1 s (±20%) after it
  await expect
    .poll(() => state.pushRefused, { timeout: 15_000 })
    .toBeGreaterThan(0);
  await expect.poll(() => leaseKeys(page)).toEqual([]);
  await expect.poll(() => rememberedUser(page)).toBeNull();

  // The next start has no network and nobody remembered, so it must refuse
  // (no_session_offline, the reason the unit test of the runtime names; the screen
  // only says "Offline indisponível"). The organizations cache is put back to
  // show it is the runtime that refuses, not the missing cache.
  // really without a network for the organizations too, so the cached list is what the app has
  await page.route("**/rpc/organization/listMine", (route) =>
    route.abort("internetdisconnected")
  );
  await page.addInitScript((cache) => {
    Object.defineProperty(navigator, "onLine", { get: () => false });
    if (cache) {
      window.localStorage.setItem("polaris.offline.organizations", cache);
    }
  }, organizationsCache);
  await page.goto("/customers");
  await expect(chip(page)).toContainText(
    "Offline indisponível neste aparelho",
    {
      timeout: 20_000,
    }
  );
  expect(await rememberedUser(page)).toBeNull();
  expect(await leaseKeys(page)).toEqual([]);
  // refusing to open does not touch the queue
  expect(await queuedOperations(page)).toBe(queuedBefore);
});

test("este navegador saiu e a pessoa clica em Entrar de novo antes de qualquer envio: o lease e as coleções vão embora, a fila fica e não passa pelo Sair", async ({
  page,
}) => {
  const { queuedBefore, state } = await revokeAndLeave(page, "answers");
  const panel = page.getByRole("alert").filter({
    hasText: "Este navegador saiu da sua conta",
  });
  await expect(panel).toBeVisible();
  expect(await leaseKeys(page)).not.toEqual([]); // nothing dropped it yet
  await panel.getByRole("button", { name: "Entrar de novo" }).click();
  await page.waitForURL("**/entrar?motivo=sessao&voltar=/devices");
  expect(await leaseKeys(page)).toEqual([]);
  expect(await queuedOperations(page)).toBe(queuedBefore);
  expect(state.signOutCalls).toBe(0);
});

test("depois de voltar à tela (a volta pelo login só será provada com a tela de entrada), a revogação não se repete e a caixa vem desmarcada", async ({
  page,
}) => {
  const state = scenario({
    answers: [
      { error: rpcError(403, "FORBIDDEN", "fresh_session_required") },
      {},
    ],
    devices: twoDevices(),
  });
  await openDevices(page, state);
  await askRevoke(page, "Celular da Ana").click();
  await page.getByRole("checkbox", { name: OTHER_SESSIONS }).check();
  await confirmButton(page, CONFIRM_ALL).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "Nada foi revogado" })
  ).toBeVisible();

  // the person signs in again and comes back to the screen (the sign-in screen does not exist yet)
  await page.reload();
  await expect(deviceItems(page)).toHaveCount(2);
  expect(state.revokeBodies).toHaveLength(1);
  await askRevoke(page, "Celular da Ana").click();
  await expect(
    page.getByRole("checkbox", { name: OTHER_SESSIONS })
  ).not.toBeChecked();
});

const RECOGNIZING =
  "Estamos reconhecendo este aparelho. Os botões liberam em instantes.";
const RECOGNIZING_UNAVAILABLE =
  "Este navegador não conseguiu preparar o acesso offline, e sem isso não dá para revogar por aqui. Recarregue a página. Se continuar, tente em outro celular ou computador em que o Polaris funcione.";
const RECOGNIZING_SLOW =
  "Não foi possível reconhecer este aparelho agora. Recarregue a página. Se continuar, tente de novo com uma internet melhor.";

/** The runtime has no context: the device registration does not answer, or fails. */
async function withoutRuntimeContext(
  page: Page,
  how: "hangs" | "fails"
): Promise<() => void> {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/rpc/device/register", async (route) => {
    if (how === "fails") {
      await route.abort("internetdisconnected");
      return;
    }
    await gate;
    await route.abort("internetdisconnected");
  });
  return release;
}

test("com internet e sem saber qual é este aparelho: a linha reconhecendo aparece acima da lista, os botões ficam desativados e depois de uns 5 s vira o texto de saída", async ({
  page,
}) => {
  const state = scenario({ devices: twoDevices() });
  await serve(page, state);
  const release = await withoutRuntimeContext(page, "hangs");
  await page.goto("/devices");
  await expect(deviceItems(page)).toHaveCount(2);

  const recognizing = page.getByRole("status").filter({ hasText: RECOGNIZING });
  await expect(recognizing).toBeVisible();
  await expect(askRevoke(page, "Celular da Ana")).toBeDisabled();
  // the wait is real: the promise still stands a few seconds in, and the exit text is not here yet
  await page.waitForTimeout(3000);
  await expect(recognizing).toBeVisible();
  await expect(page.getByText(RECOGNIZING_SLOW)).toHaveCount(0);
  // above the list
  const lineBox = await recognizing.boundingBox();
  const listBox = await page
    .getByRole("list", { name: "Aparelhos" })
    .boundingBox();
  expect(lineBox?.y ?? 0).toBeLessThan(listBox?.y ?? 0);

  const failed = page.getByRole("status").filter({ hasText: RECOGNIZING_SLOW });
  await expect(failed).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(RECOGNIZING)).toHaveCount(0);
  await expect(askRevoke(page, "Celular da Ana")).toBeDisabled();
  release();
});

test("com internet e o runtime indisponível: o texto de saída aparece logo, sem esperar os 5 s", async ({
  page,
}) => {
  const state = scenario({ devices: twoDevices() });
  await serve(page, state);
  await withoutRuntimeContext(page, "fails");
  await page.goto("/devices");
  await expect(deviceItems(page)).toHaveCount(2);
  await expect(chip(page)).toContainText("Offline indisponível", {
    timeout: 4000,
  });
  await expect(
    page.getByRole("status").filter({ hasText: RECOGNIZING_UNAVAILABLE })
  ).toBeVisible({ timeout: 1000 });
  await expect(page.getByText(RECOGNIZING)).toHaveCount(0);
  await expect(page.getByText(RECOGNIZING_SLOW)).toHaveCount(0);
  await expect(askRevoke(page, "Celular da Ana")).toBeDisabled();
});

test("com o aparelho reconhecido, nenhuma das duas linhas aparece", async ({
  page,
}) => {
  await openDevices(page, scenario({ devices: twoDevices() }));
  await expect(chip(page)).toContainText("Tudo sincronizado", {
    timeout: 20_000,
  });
  await expect(page.getByText(RECOGNIZING)).toHaveCount(0);
  await expect(page.getByText(RECOGNIZING_SLOW)).toHaveCount(0);
  await expect(page.getByText(RECOGNIZING_UNAVAILABLE)).toHaveCount(0);
  await expect(askRevoke(page, "Celular da Ana")).toBeEnabled();
});

test("o resultado incerto aparece dentro da confirmação, acima dos botões, e não no topo da página", async ({
  page,
}) => {
  const state = scenario({
    answers: [{ error: rpcError(500, "INTERNAL_SERVER_ERROR") }, {}],
    devices: twoDevices(),
  });
  await openDevices(page, state);
  await askRevoke(page, "Celular da Ana").click();
  await confirmButton(page).click();

  const confirmation = page.getByRole("dialog");
  const alert = confirmation.getByRole("alert");
  await expect(alert).toContainText("Não conseguimos confirmar se o aparelho");
  await expect(page.getByRole("alert")).toHaveCount(1); // only the one inside
  const alertBox = await alert.boundingBox();
  const buttonBox = await confirmButton(page).boundingBox();
  expect(alertBox ? alertBox.y + alertBox.height : 0).toBeLessThanOrEqual(
    buttonBox?.y ?? 0
  );
  await expect(page.getByText("Aparelho revogado")).toHaveCount(0);

  await confirmButton(page).click();
  // success stays at the top of the page, as a status
  await expect(
    page.getByRole("status").filter({ hasText: "Aparelho revogado." })
  ).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("cancelar a confirmação depois de um resultado incerto não deixa no topo um aviso que manda tocar em um Sim que já não existe", async ({
  page,
}) => {
  const state = scenario({
    answers: [{ error: rpcError(500, "INTERNAL_SERVER_ERROR") }, {}],
    devices: twoDevices(),
  });
  await openDevices(page, state);
  await askRevoke(page, "Celular da Ana").click();
  await confirmButton(page).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
    "Não conseguimos confirmar se o aparelho"
  );

  await page.getByRole("button", { name: "Cancelar" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByText("revogue de novo")).toHaveCount(0);
});

test("o resultado incerto de uma revogação que valeu não se perde quando a linha sai da lista: o aviso vai para o topo", async ({
  page,
}) => {
  const state = scenario({
    answers: [{ abort: true, applied: true }],
    devices: twoDevices(),
  });
  await openDevices(page, state);
  await askRevoke(page, "Celular da Ana").click();
  await confirmButton(page).click();

  await expect(deviceItems(page)).toHaveCount(1); // the list was read again: the device is gone
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("alert")).toContainText(
    "Não conseguimos confirmar se o aparelho foi revogado"
  );
  await expect(page.getByRole("alert")).toHaveCount(1);
});

test("uma recusa definitiva fecha a confirmação e o aviso fica no topo, com a lista à vista", async ({
  page,
}) => {
  const state = scenario({
    answers: [{ error: rpcError(400, "BAD_REQUEST") }],
    devices: twoDevices(),
  });
  await openDevices(page, state);
  await askRevoke(page, "Celular da Ana").click();
  await confirmButton(page).click();
  await expect(page.getByRole("alert")).toContainText("Nada foi alterado");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  // the confirmation that held the focus is gone: the focus goes to the heading, not to the body
  await expect(page.getByRole("heading", { name: "Aparelhos" })).toBeFocused();
  await expect(askRevoke(page, "Celular da Ana")).toBeEnabled();
});

test("o destino de 'Entrar de novo' é a tela de entrada, com a frase do motivo e o botão do Google, não 'Página não encontrada' (AC-19)", async ({
  page,
}) => {
  await serve(page, scenario({ devices: twoDevices() }));
  await page.goto("/entrar?motivo=recente&voltar=/devices");
  await expect(
    page.getByRole("heading", { name: "Entrar no Polaris" })
  ).toBeVisible();
  await expect(
    page.getByText("Por segurança, entre de novo para confirmar que é você.")
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Página não encontrada" })
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Continuar com o Google" })
  ).toBeVisible();
});

// the 48 px touch area is measured by the guardrails (check 2, e2e-pwa/ui-guardrails.e2e.ts); here, the visible height
// the design gives a control with touch (36 px) and that nothing scrolls sideways in the dialog and the panel
test("os controles têm a altura de toque de 36 px e nada rola na horizontal, a 360 px e no iPhone SE", async ({
  page,
}) => {
  const state = scenario({
    answers: [{ error: rpcError(403, "FORBIDDEN", "fresh_session_required") }],
    devices: twoDevices(),
  });
  await openDevices(page, state);
  const heightOf = async (locator: ReturnType<Page["getByRole"]>) =>
    (await locator.boundingBox())?.height ?? 0;
  for (const size of [
    { height: 740, width: 360 },
    { height: 667, width: 375 },
  ]) {
    // biome-ignore lint/performance/noAwaitInLoops: one viewport after the other
    await page.setViewportSize(size);
    await page.goto("/devices");
    await expect(deviceItems(page)).toHaveCount(2);
    expect(
      await heightOf(askRevoke(page, "Celular da Ana"))
    ).toBeGreaterThanOrEqual(36);
    await askRevoke(page, "Celular da Ana").click();
    expect(
      await heightOf(
        page
          .getByRole("checkbox", { name: OTHER_SESSIONS })
          .locator("xpath=ancestor::*[@data-slot='field'][1]")
      )
    ).toBeGreaterThanOrEqual(36);
    expect(await heightOf(confirmButton(page))).toBeGreaterThanOrEqual(36);
    expect(
      await heightOf(page.getByRole("button", { name: "Cancelar" }))
    ).toBeGreaterThanOrEqual(36);
    await page.getByRole("checkbox", { name: OTHER_SESSIONS }).check();
    expect(
      await heightOf(confirmButton(page, CONFIRM_ALL))
    ).toBeGreaterThanOrEqual(36);
    await confirmButton(page, CONFIRM_ALL).click();
    await expect(
      page.getByRole("button", { name: "Entrar de novo" })
    ).toBeVisible();
    expect(
      await heightOf(page.getByRole("button", { name: "Entrar de novo" }))
    ).toBeGreaterThanOrEqual(36);
    expect(
      await heightOf(page.getByRole("button", { name: "Agora não" }))
    ).toBeGreaterThanOrEqual(36);
    const overflow = await page.evaluate(
      () =>
        (document.scrollingElement?.scrollWidth ?? 0) -
        (document.scrollingElement?.clientWidth ?? 0)
    );
    expect(overflow).toBeLessThanOrEqual(0);
  }
});

test("o menu oferece Aparelhos quando o runtime offline está ligado", async ({
  page,
}) => {
  await serve(page, scenario({ devices: twoDevices() }));
  await page.goto("/");
  // on the phone the rest of the menu is under "Mais"
  const more = page.getByRole("button", { exact: true, name: "Mais" });
  if (await more.isVisible()) {
    await more.click();
  }
  await expect(page.getByRole("link", { name: "Aparelhos" })).toBeVisible();
});

test("a 360 px o chip é de uma linha e Mais abre com a frase do estado; no desktop a frase fica no title", async ({
  page,
}) => {
  await serve(page, scenario({ devices: twoDevices() }));
  await page.setViewportSize({ height: 740, width: 360 });
  await page.goto("/");
  await expect(chip(page)).toContainText("Tudo sincronizado", {
    timeout: 20_000,
  });
  const short = page.locator(".sync-status-short");
  await expect(short).toHaveText("Sincronizado");
  expect(
    await short.evaluate((node) => node.scrollWidth <= node.clientWidth)
  ).toBe(true);
  const line = page.locator(".sync-status-menu-line");
  await expect(line).toBeHidden();
  await page.getByRole("button", { exact: true, name: "Mais" }).click();
  await expect(line).toBeVisible();
  await expect(line).toHaveText("Tudo sincronizado");
  await page.keyboard.press("Escape");

  await page.setViewportSize({ height: 800, width: 1280 });
  await expect(line).toHaveCount(0);
  await expect(chip(page)).toHaveAttribute("title", "Tudo sincronizado");
});
