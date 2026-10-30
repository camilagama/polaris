/// <reference lib="dom" />
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { serveHealth, WORKER_MARK } from "./worker-mark";

/**
 * Where the app opens for an account with a closed store (L6, AC-10 of the corte encerrar-a-loja-e-painel-da-encerrada):
 * `listClosed` is read only when `listMine` came back empty, and the Início of an active store mentions a closed one
 * from what the browser already read, with no call of its own.
 */
const CLOSED_ID = "0199c2d0-0000-7000-8000-00000000a001";
const ACTIVE_ID = "0199c2d0-0000-7000-8000-00000000a002";
const ACTIVE = {
  id: ACTIVE_ID,
  name: "Loja nova",
  role: "owner",
  timezone: "America/Sao_Paulo",
};
const CLOSED = {
  canRecover: true,
  deletableFrom: "2027-01-18T03:00:00.000Z",
  deletionDate: "2027-01-18",
  exportOpenUntil: "2027-01-18T03:00:00.000Z",
  id: CLOSED_ID,
  milestones: {
    closure: "2026-10-20T12:00:00.000Z",
    d7: "2027-01-11T03:00:00.000Z",
    d30: "2026-12-19T03:00:00.000Z",
    deletionDay: "2027-01-18T03:00:00.000Z",
  },
  name: "Doce Mel",
  phase: "closing",
  recoverUntil: "2026-11-19T12:00:00.000Z",
  renewal: "not_handled",
  requestedAt: "2026-10-20T12:00:00.000Z",
  timezone: "America/Sao_Paulo",
};
const NOW = new Date("2026-10-30T12:00:00-03:00");
const CLOSED_STORES_KEY = "polaris.closedStores";

const rpc = (json: unknown, status = 200) => ({
  body: JSON.stringify({ json, meta: [] }),
  contentType: "application/json",
  headers: { ...WORKER_MARK },
  status,
});
const failure = (code: string, status: number) =>
  rpc({ code, data: undefined, defined: false, message: code, status }, status);

interface Account {
  closed: (typeof CLOSED)[];
  mine: (typeof ACTIVE)[];
}

interface Calls {
  creates: number;
  listClosed: number;
  listMine: number;
}

async function serveAccount(page: Page, account: Account): Promise<Calls> {
  const calls: Calls = { creates: 0, listClosed: 0, listMine: 0 };
  await page.route("**/api/auth/get-session", (route) =>
    route.fulfill({
      body: JSON.stringify({
        session: { id: "s" },
        user: { email: "dona@exemplo.test", id: "u", name: "Ana Dona" },
      }),
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
      calls.listMine += 1;
      return route.fulfill(
        rpc({ billingSelfService: false, organizations: account.mine })
      );
    }
    if (procedure === "organization/listClosed") {
      calls.listClosed += 1;
      return route.fulfill(rpc({ organizations: account.closed }));
    }
    if (procedure === "organization/closedStatus") {
      return route.fulfill(rpc({ organization: account.closed[0] ?? null }));
    }
    if (procedure === "dataExport/listClosed") {
      return route.fulfill(rpc({ exports: [] }));
    }
    if (procedure === "organization/createInitial") {
      calls.creates += 1;
      account.mine = [ACTIVE];
      return route.fulfill(rpc({ organization: ACTIVE }));
    }
    // the Início's own reads and the device: answered, not part of this test
    return route.fulfill(failure("INTERNAL_SERVER_ERROR", 500));
  });
  return calls;
}

const home = (page: Page) =>
  page.getByRole("heading", { exact: true, level: 1, name: "Início" });
const setupTitle = (page: Page) =>
  page.getByRole("heading", { level: 1, name: "Abra a sua loja" });
const closedLine = (page: Page) =>
  page.getByText("Você também tem uma loja encerrada: Doce Mel.");

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(NOW);
});

test("só loja encerrada do dono: abre o painel, não 'Abra a sua loja'", async ({
  page,
}) => {
  const calls = await serveAccount(page, { closed: [CLOSED], mine: [] });
  await page.goto("/");
  await page.waitForURL(`**/loja-encerrada?loja=${CLOSED_ID}`);
  await expect(
    page.getByRole("heading", { level: 1, name: "Doce Mel está encerrada" })
  ).toBeVisible();
  expect(calls.listClosed).toBe(1);
  await expect(setupTitle(page)).toHaveCount(0);
});

test("sem loja ativa e sem encerrada do dono (ou quem não é dono): 'Abra a sua loja', como antes", async ({
  page,
}) => {
  const calls = await serveAccount(page, { closed: [], mine: [] });
  await page.goto("/");
  await expect(setupTitle(page)).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/");
  expect(calls.listClosed).toBe(1);
});

test("com loja ativa, listClosed não é chamado; sem nada lembrado, nenhuma linha", async ({
  page,
}) => {
  const calls = await serveAccount(page, { closed: [CLOSED], mine: [ACTIVE] });
  await page.goto("/");
  await expect(home(page)).toBeVisible();
  await expect(closedLine(page)).toHaveCount(0);
  await page.reload();
  await expect(home(page)).toBeVisible();
  expect(calls.listClosed).toBe(0);
});

test("ativa e encerrada: do painel, 'Abrir outra loja' abre o formulário sem voltar ao painel, e o Início da nova loja mostra a linha com 'Ver'", async ({
  page,
}) => {
  const calls = await serveAccount(page, { closed: [CLOSED], mine: [] });
  await page.goto("/");
  await page.waitForURL(`**/loja-encerrada?loja=${CLOSED_ID}`);
  await page
    .getByRole("link", { exact: true, name: "Abrir outra loja" })
    .click();
  await expect(setupTitle(page)).toBeVisible();
  // the mark leaves the address: a reload of the form is a normal opening
  await expect.poll(() => new URL(page.url()).search).toBe("");
  expect(calls.listClosed).toBe(1);

  await page.getByLabel("Nome da loja").fill("Loja nova");
  await page.getByRole("button", { name: "Abrir loja" }).click();
  await expect(home(page)).toBeVisible();
  await expect(closedLine(page)).toBeVisible();
  const see = page.getByRole("link", {
    name: "Ver a loja encerrada Doce Mel",
  });
  await expect(see).toHaveAttribute(
    "href",
    `/loja-encerrada?loja=${CLOSED_ID}`
  );
  await page.reload();
  await expect(home(page)).toBeVisible();
  await expect(closedLine(page)).toBeVisible();
  expect(calls).toMatchObject({ creates: 1, listClosed: 1 });
});

test("a linha nunca fala de uma loja que o servidor lista como ativa", async ({
  page,
}) => {
  await serveAccount(page, { closed: [], mine: [ACTIVE] });
  await page.addInitScript(
    ([key, id]) =>
      window.localStorage.setItem(
        key,
        JSON.stringify([{ id, name: "Loja nova" }])
      ),
    [CLOSED_STORES_KEY, ACTIVE_ID]
  );
  await page.goto("/");
  await expect(home(page)).toBeVisible();
  await expect(
    page.getByText("Você também tem uma loja encerrada")
  ).toHaveCount(0);
});

test("depois de desfazer, o Início diz uma vez que a loja foi reaberta e tira a marca do endereço", async ({
  page,
}) => {
  await serveAccount(page, { closed: [], mine: [ACTIVE] });
  await page.goto("/?reaberta=1");
  await expect(home(page)).toBeVisible();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Loja reaberta. Você já pode usar o Polaris." })
  ).toBeVisible();
  await expect.poll(() => new URL(page.url()).search).toBe("");
  await page.reload();
  await expect(home(page)).toBeVisible();
  await expect(page.getByText("Loja reaberta.")).toHaveCount(0);
});
