/// <reference lib="dom" />
import type { Page, Route } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { buildOfflineLeaseClaims } from "@polaris/domain/offline/offline-lease";
import { signOfflineLease } from "../src/lib/offline-lease-token";
import { serveHealth, WORKER_MARK } from "./worker-mark";

const ORGANIZATION = {
  id: "0199c2d0-0000-7000-8000-00000000a001",
  name: "Loja do teste",
  role: "owner",
  timezone: "America/Sao_Paulo",
};
const SESSION_USER = { email: "dona@exemplo.test", id: "u", name: "Ana Dona" };
const DEVICE = {
  createdAt: "2026-10-01T12:00:00.000Z",
  id: "0199c2d0-0000-7000-8000-000000000001",
  label: "Caixa da loja",
  lastSeenAt: "2026-10-14T12:00:00.000Z",
  revokedAt: null,
};
const LEASE_KEY = {
  id: "teste",
  secret: "teste-secret-teste-secret-teste-secret-0123456789",
};
const HOUR = 3_600_000;
const PATH = "/configuracoes?aba=seus-dados";
const NOW = new Date("2026-10-30T12:00:00-03:00");
const PANEL_PATH =
  /\/loja-encerrada\?loja=0199c2d0-0000-7000-8000-00000000a001$/;
const CLOSED = {
  canRecover: true,
  deletableFrom: "2027-01-28T03:00:00.000Z",
  deletionDate: "2027-01-28",
  exportOpenUntil: "2027-01-28T03:00:00.000Z",
  id: ORGANIZATION.id,
  milestones: {
    closure: "2026-10-30T15:00:00.000Z",
    d7: "2027-01-21T03:00:00.000Z",
    d30: "2026-12-29T03:00:00.000Z",
    deletionDay: "2027-01-28T03:00:00.000Z",
  },
  name: ORGANIZATION.name,
  phase: "closing",
  recoverUntil: "2026-11-29T15:00:00.000Z",
  renewal: "not_handled",
  requestedAt: "2026-10-30T15:00:00.000Z",
  timezone: ORGANIZATION.timezone,
};

const rpc = (json: unknown, status = 200) => ({
  body: JSON.stringify({ json, meta: [] }),
  contentType: "application/json",
  headers: { ...WORKER_MARK },
  status,
});
const inputOf = (route: Route) =>
  (route.request().postDataJSON() as { json: unknown }).json;

interface ScreenOptions {
  billingSelfService?: boolean;
  closure?: (route: Route) => Promise<void>;
  role?: string;
  runtime?: boolean;
}

interface Calls {
  closures: Record<string, unknown>[];
}

async function serveRuntime(page: Page) {
  await page.route("**/rpc/device/*", (route) =>
    route.fulfill(rpc({ device: DEVICE, devices: [DEVICE] }))
  );
  await page.route("**/rpc/offline/issueLease", async (route) => {
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + 72 * HOUR);
    const lease = await signOfflineLease(
      buildOfflineLeaseClaims({
        capabilities: ["customer:create", "customer:update"],
        deviceId: (inputOf(route) as { deviceId: string }).deviceId,
        epoch: 0,
        expiresAt,
        grantId: "0199c2d0-0000-7000-8000-000000000901",
        issuedAt,
        organizationId: ORGANIZATION.id,
        userId: SESSION_USER.id,
      }),
      LEASE_KEY
    );
    await route.fulfill(
      rpc({
        expiresAt: expiresAt.toISOString(),
        grantId: "0199c2d0-0000-7000-8000-000000000901",
        issuedAt: issuedAt.toISOString(),
        lease,
      })
    );
  });
  await page.route("**/rpc/sync/getCursor", (route) =>
    route.fulfill(rpc({ cursor: "0" }))
  );
  await page.route("**/rpc/sync/bootstrapPage", (route) =>
    route.fulfill(
      rpc({
        collection: (inputOf(route) as { collection: string }).collection,
        nextAfterId: null,
        rows: [],
      })
    )
  );
  await page.route("**/rpc/sync/pull", (route) =>
    route.fulfill(rpc({ changes: [], hasMore: false, nextCursor: "0" }))
  );
}

async function openScreen(
  page: Page,
  {
    billingSelfService = false,
    closure = (route) =>
      route.fulfill(
        rpc({ recoverUntil: CLOSED.recoverUntil, revokedLeases: 0 })
      ),
    runtime = false,
    role = "owner",
  }: ScreenOptions = {}
): Promise<Calls> {
  const calls: Calls = { closures: [] };
  await page.route("**/api/auth/get-session", (route) =>
    route.fulfill({
      body: JSON.stringify({ session: { id: "s" }, user: SESSION_USER }),
      contentType: "application/json",
      headers: { ...WORKER_MARK },
    })
  );
  await serveHealth(page);
  await page.route("**/rpc/**", (route) => {
    const procedure = new URL(route.request().url()).pathname.replace(
      "/rpc/",
      ""
    );
    if (procedure === "organization/listMine") {
      return route.fulfill(
        rpc({
          billingSelfService,
          organizations: [{ ...ORGANIZATION, role }],
        })
      );
    }
    if (
      procedure === "dataExport/list" ||
      procedure === "dataExport/listClosed"
    ) {
      return route.fulfill(rpc({ exports: [] }));
    }
    if (procedure === "organization/requestClosure") {
      calls.closures.push(inputOf(route) as Record<string, unknown>);
      return closure(route);
    }
    if (procedure === "organization/closedStatus") {
      return route.fulfill(rpc({ organization: CLOSED }));
    }
    return route.abort("internetdisconnected");
  });
  if (runtime) {
    await serveRuntime(page);
  }
  await page.goto(PATH);
  return calls;
}

const section = (page: Page) =>
  page.getByRole("region", { exact: true, name: "Encerrar a loja" });
const openButton = (page: Page) =>
  section(page).getByRole("button", { exact: true, name: "Encerrar a loja" });
const dialog = (page: Page) =>
  page.getByRole("dialog", { name: "Encerrar a loja Loja do teste" });
const nameField = (page: Page) =>
  dialog(page).getByLabel(
    "Para confirmar, digite o nome da loja: Loja do teste"
  );
const confirmButton = (page: Page) =>
  dialog(page).getByRole("button", { name: "Encerrar a loja" });

async function waitForQueue(page: Page) {
  await expect
    .poll(
      async () =>
        (
          await page.evaluate(async () =>
            (await indexedDB.databases()).map(({ name }) => name ?? "")
          )
        ).some((name) => name.startsWith("polaris-outbox-")),
      { timeout: 20_000 }
    )
    .toBe(true);
}

async function leaveOneRefused(page: Page) {
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
    },
    { deviceId: DEVICE.id, organizationId: ORGANIZATION.id }
  );
  await page.reload();
}

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(NOW);
});

test("o dono encerra com o nome certo: um pedido para dois cliques, e a tela leva ao painel (AC-2, AC-4)", async ({
  page,
}) => {
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const calls = await openScreen(page, {
    closure: async (route) => {
      await held;
      await route.fulfill(
        rpc({ recoverUntil: CLOSED.recoverUntil, revokedLeases: 1 })
      );
    },
  });
  await expect(section(page)).toBeVisible();
  await openButton(page).click();
  await expect(dialog(page)).toBeVisible();
  const text = await dialog(page).innerText();
  for (const warning of [
    "Vender, mexer no estoque e cadastrar param na hora.",
    "Por 30 dias você pode desfazer o encerramento.",
    "Por 90 dias você ainda entra só para baixar seus dados",
    "os dados da loja podem ser apagados e não dá para recuperar.",
    "Guardar os documentos fiscais é responsabilidade sua.",
    "A cobrança do plano não é cancelada por aqui. Cancele a renovação no provedor de pagamento.",
    "Se você usa o Polaris em outros aparelhos, abra-os com internet",
  ]) {
    expect(text).toContain(warning);
  }
  await expect(
    dialog(page).getByRole("button", { name: "Voltar" })
  ).toBeVisible();
  await expect(confirmButton(page)).toBeDisabled();

  await nameField(page).fill("Loja do test");
  await expect(confirmButton(page)).toBeDisabled();
  await expect(dialog(page)).toContainText(
    "Digite o nome da loja como aparece acima para habilitar o botão."
  );
  await confirmButton(page).click({ force: true });
  expect(calls.closures).toHaveLength(0);

  await nameField(page).fill("  loja DO teste ");
  await expect(confirmButton(page)).toBeEnabled();
  await confirmButton(page).dblclick();
  await expect(
    dialog(page).getByRole("button", { name: "Encerrando…" })
  ).toBeDisabled();
  release();
  await expect(page).toHaveURL(PANEL_PATH);
  expect(calls.closures).toEqual([
    { confirmation: "  loja DO teste ", organizationId: ORGANIZATION.id },
  ]);
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: "Loja do teste está encerrada",
    })
  ).toBeVisible();
  await expect(page.getByRole("status").first()).toContainText(
    "Loja encerrada. Você pode desfazer até 29 de novembro de 2026, às 12:00. Seus dados ficam guardados e você pode baixá-los."
  );
  await expect(
    page.getByRole("link", { exact: true, name: "Baixar meus dados" })
  ).toBeVisible();
  await expect(
    page.getByRole("button", { exact: true, name: "Desfazer encerramento" })
  ).toBeVisible();
});

test("Voltar fecha sem pedir nada, e a recusa do servidor tem texto próprio sem código técnico", async ({
  page,
}) => {
  const calls = await openScreen(page, {
    closure: (route) =>
      route.fulfill(
        rpc(
          {
            code: "CONFLICT",
            data: { reason: "organization_not_active" },
            defined: false,
            message: "CONFLICT",
            status: 409,
          },
          409
        )
      ),
  });
  await openButton(page).click();
  await nameField(page).fill("Loja do teste");
  await dialog(page).getByRole("button", { name: "Voltar" }).click();
  await expect(dialog(page)).toBeHidden();
  expect(calls.closures).toHaveLength(0);

  await openButton(page).click();
  await expect(nameField(page)).toHaveValue("");
  await nameField(page).fill("Loja do teste");
  await confirmButton(page).click();
  await expect(dialog(page).getByRole("alert")).toHaveText(
    "Esta loja não está ativa e não pode ser encerrada agora. Nada foi encerrado."
  );
  await expect(dialog(page)).not.toContainText("organization_not_active");
  expect(calls.closures).toHaveLength(1);
});

test("com a cobrança pelo app ligada, o aviso diz que a renovação é cancelada e que o painel mostra quando (AC-2)", async ({
  page,
}) => {
  await openScreen(page, { billingSelfService: true });
  await openButton(page).click();
  await expect(dialog(page)).toContainText(
    "A renovação do plano é cancelada; o painel mostra quando foi confirmada."
  );
  await expect(dialog(page)).not.toContainText(
    "A cobrança do plano não é cancelada por aqui."
  );
});

test("com trabalho guardado neste aparelho o botão fica desligado mesmo com o nome certo (AC-3)", async ({
  page,
}) => {
  const calls = await openScreen(page, { runtime: true });
  await waitForQueue(page);
  await leaveOneRefused(page);
  await openButton(page).click();
  await nameField(page).fill("Loja do teste");
  await expect(dialog(page)).toContainText(
    "Este aparelho tem 1 registro recusado. Resolva em Precisa de ação antes de encerrar.",
    { timeout: 20_000 }
  );
  await expect(confirmButton(page)).toBeDisabled();
  await confirmButton(page).click({ force: true });
  await nameField(page).press("Enter");
  expect(calls.closures).toHaveLength(0);
});

test("sem conexão o botão da seção fica desligado e não abre o diálogo (AC-1)", async ({
  page,
}) => {
  const calls = await openScreen(page);
  await expect(openButton(page)).toBeEnabled();
  await page.context().setOffline(true);
  await expect(openButton(page)).toBeDisabled();
  await openButton(page).click({ force: true });
  await expect(dialog(page)).toBeHidden();
  expect(calls.closures).toHaveLength(0);
});

test("quem não é dono não vê a seção de encerrar (AC-1)", async ({ page }) => {
  await openScreen(page, { role: "cashier" });
  await expect(
    page.getByText("Só o dono da loja pode pedir e baixar a cópia dos dados.")
  ).toBeVisible();
  await expect(page.getByText("Encerrar a loja")).toHaveCount(0);
});
