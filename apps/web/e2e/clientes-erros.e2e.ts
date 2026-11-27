/// <reference lib="dom" />
import type { Locator, Page, Route } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { MAX_CUSTOMER_PHONE_LENGTH } from "@polaris/domain/customers/customer";
import { serveHealth, WORKER_MARK } from "./worker-mark";

/**
 * The two reads of Clientes that fail with a text of their own: the list (`customer/list`, read with up to three
 * tries) and the check of possible duplicates that runs before a save. The real route, with the API answered by the
 * test (the server mode, no offline runtime).
 */
const ORGANIZATION = {
  id: "0199c2d0-0000-7000-8000-00000000a001",
  name: "Loja do teste",
  role: "owner",
  timezone: "America/Sao_Paulo",
};
const NOW = new Date("2026-10-14T12:00:00-03:00");
const DAY = NOW.toISOString();

const rpc = (json: unknown, status = 200) => ({
  body: JSON.stringify({ json, meta: [] }),
  contentType: "application/json",
  headers: { ...WORKER_MARK },
  status,
});
const refusal = (code: string, status: number) =>
  rpc({ code, data: undefined, defined: false, message: code, status }, status);

type Handler = (route: Route) => Promise<void>;
const reply =
  (json: unknown): Handler =>
  (route) =>
    route.fulfill(rpc(json));

const customer = (n: number, name: string) => ({
  anonymizedAt: null,
  archivedAt: null,
  createdAt: DAY,
  email: null,
  id: `0199c2d0-0000-7000-8000-0000000000${60 + n}`,
  name,
  notes: null,
  organizationId: ORGANIZATION.id,
  phone: "11 91234-5678",
  status: "active",
  updatedAt: DAY,
  version: 1,
});

async function openCustomers(page: Page, answers: Record<string, Handler>) {
  await page.clock.setFixedTime(NOW);
  await page.route("**/api/auth/get-session", (route) =>
    route.fulfill({
      body: JSON.stringify({ session: { id: "s" }, user: { id: "u" } }),
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
      return route.fulfill(rpc({ organizations: [ORGANIZATION] }));
    }
    const handler = answers[procedure];
    return handler ? handler(route) : route.abort("internetdisconnected");
  });
  await page.goto("/customers");
  await expect(
    page.getByRole("heading", { exact: true, level: 1, name: "Clientes" })
  ).toBeVisible();
}

const LOAD_FAILED = "Não foi possível carregar os clientes.";
const EMPTY_LIST = "Nenhum cliente ainda.";
const CHECK_FAILED = "Não foi possível conferir se o cliente já existe.";

test("Clientes: a lista que não carrega diz o motivo, não é uma lista vazia e 'Tentar novamente' lê de novo", async ({
  page,
}) => {
  let reads = 0;
  await openCustomers(page, {
    "customer/list": (route) => {
      reads += 1;
      return reads <= 3
        ? route.fulfill(refusal("INTERNAL_SERVER_ERROR", 500))
        : route.fulfill(rpc({ customers: [customer(1, "Ana Lima")] }));
    },
  });
  // three tries (the wait between them is ~1.5 s and ~4 s) before the screen gives up
  const alert = page.getByRole("alert");
  await expect(alert).toContainText(LOAD_FAILED, { timeout: 15_000 });
  await expect.poll(() => reads).toBe(3);
  await expect(page.getByText(EMPTY_LIST)).toHaveCount(0);
  await expect(page.getByText("Ana Lima")).toHaveCount(0);

  await alert.getByRole("button", { name: "Tentar novamente" }).click();
  await expect(page.getByText("Ana Lima")).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByText(EMPTY_LIST)).toHaveCount(0);
  await expect.poll(() => reads).toBe(4);
});

test("Clientes: a primeira leitura da lista com um 503 repete sozinha e abre sem o aviso", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const seen = { alert: false };
    (window as unknown as { alertSeen: typeof seen }).alertSeen = seen;
    new MutationObserver(() => {
      if (document.querySelector("[role=alert]")) {
        seen.alert = true;
      }
    }).observe(document, { childList: true, subtree: true });
  });
  let reads = 0;
  await openCustomers(page, {
    "customer/list": (route) => {
      reads += 1;
      return reads === 1
        ? route.fulfill(refusal("SERVICE_UNAVAILABLE", 503))
        : route.fulfill(rpc({ customers: [customer(1, "Ana Lima")] }));
    },
  });
  await expect(page.getByText("Ana Lima")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { alertSeen: { alert: boolean } }).alertSeen.alert
    )
  ).toBe(false);
  await expect.poll(() => reads).toBe(2);
});

const CHECK_UNAVAILABLE =
  "Não foi possível verificar possíveis clientes repetidos. Tente novamente antes de salvar.";

const FAILING_CHECKS = [
  {
    answer: refusal("UNAUTHORIZED", 401),
    label: "a sessão que acabou (401)",
    text: CHECK_FAILED,
  },
  {
    answer: refusal("SERVICE_UNAVAILABLE", 503),
    label: "o servidor indisponível (503)",
    text: CHECK_UNAVAILABLE,
  },
];

const SAVED = "Cliente “Bia Souza” cadastrado.";

async function fillNewCustomer(page: Page) {
  await page.getByRole("button", { name: "Novo cliente" }).click();
  const name = page.getByLabel("Nome", { exact: true });
  const phone = page.getByLabel("Telefone");
  await name.fill("Bia Souza");
  await phone.fill("11900000002");
  await page.getByRole("button", { name: "Cadastrar cliente" }).click();
  return { name, phone };
}

async function expectRefusedAndKept(
  page: Page,
  text: string,
  kept: { name: Locator; phone: Locator }
) {
  await expect(page.getByRole("alert")).toContainText(text);
  await expect(
    page.getByRole("dialog", { name: "Novo cliente" })
  ).toBeVisible();
  await expect(kept.name).toHaveValue("Bia Souza");
  await expect(kept.phone).toHaveValue("11900000002");
}

function saveAnswers(failure: ReturnType<typeof refusal>, failures: number) {
  const calls = { checks: 0, creates: 0 };
  const answers: Record<string, Handler> = {
    "customer/create": (route) => {
      calls.creates += 1;
      return route.fulfill(rpc(customer(2, "Bia Souza")));
    },
    "customer/findPossibleDuplicates": (route) => {
      calls.checks += 1;
      return calls.checks <= failures
        ? route.fulfill(failure)
        : route.fulfill(rpc({ matches: [] }));
    },
    "customer/list": reply({ customers: [] }),
  };
  return { answers, calls };
}

for (const failing of FAILING_CHECKS) {
  test(`Clientes: a conferência de repetidos que falha com ${failing.label} diz que não conferiu, não salva e o que foi digitado fica`, async ({
    page,
  }) => {
    const { answers, calls } = saveAnswers(failing.answer, 1);
    await openCustomers(page, answers);
    const kept = await fillNewCustomer(page);

    await expectRefusedAndKept(page, failing.text, kept);
    expect(calls.checks).toBe(1);
    expect(calls.creates).toBe(0);

    // the form is still open and the same button checks again; once the check answers, the customer is saved
    await page.getByRole("button", { name: "Cadastrar cliente" }).click();
    await expect(
      page.getByRole("status").filter({ hasText: SAVED })
    ).toBeVisible();
    expect(calls.checks).toBe(2);
    expect(calls.creates).toBe(1);
  });
}

test("Clientes: a conferência de repetidos que segue em 503 no segundo clique volta a dizer que não conferiu e só salva quando responde", async ({
  page,
}) => {
  const { answers, calls } = saveAnswers(
    refusal("SERVICE_UNAVAILABLE", 503),
    2
  );
  await openCustomers(page, answers);
  const kept = await fillNewCustomer(page);
  const save = page.getByRole("button", { name: "Cadastrar cliente" });

  await expectRefusedAndKept(page, CHECK_UNAVAILABLE, kept);
  expect(calls.checks).toBe(1);
  expect(calls.creates).toBe(0);

  await save.click();
  await expect.poll(() => calls.checks).toBe(2);
  await expect(save).toBeEnabled();
  await expectRefusedAndKept(page, CHECK_UNAVAILABLE, kept);
  expect(calls.creates).toBe(0);

  await save.click();
  await expect(
    page.getByRole("status").filter({ hasText: SAVED })
  ).toBeVisible();
  expect(calls.checks).toBe(3);
  expect(calls.creates).toBe(1);
});

test("Clientes: colar no Telefone um texto maior que o limite do domínio fica no limite e salvar não recusa o tamanho", async ({
  browserName,
  context,
  page,
}) => {
  test.skip(
    browserName !== "chromium",
    "only Chromium lets a test write the clipboard"
  );
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const pasted = "9".repeat(MAX_CUSTOMER_PHONE_LENGTH * 2);
  const created: { phone?: string }[] = [];
  const answers: Record<string, Handler> = {
    "customer/create": (route) => {
      const body = route.request().postDataJSON() as {
        json: { phone?: string };
      };
      created.push(body.json);
      return route.fulfill(rpc(customer(2, "Bia Souza")));
    },
    "customer/findPossibleDuplicates": reply({ matches: [] }),
    "customer/list": reply({ customers: [] }),
  };
  await openCustomers(page, answers);

  await page.getByRole("button", { name: "Novo cliente" }).click();
  await page.getByLabel("Nome", { exact: true }).fill("Bia Souza");
  const phone = page.getByLabel("Telefone");
  await phone.focus();
  await page.evaluate((text) => navigator.clipboard.writeText(text), pasted);
  await page.keyboard.press("ControlOrMeta+V");
  // the cut is the input's maxLength alone (apps/web/src/customers/customer-form.tsx:125, from packages/domain/src/customers/customer.ts:3);
  // without it all the pasted characters stay: no mask or normalization shortens the value
  await expect(phone).toHaveValue("9".repeat(MAX_CUSTOMER_PHONE_LENGTH));

  await page.getByRole("button", { name: "Cadastrar cliente" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: SAVED })
  ).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(created).toHaveLength(1);
  expect(created[0]?.phone).toBe("9".repeat(MAX_CUSTOMER_PHONE_LENGTH));
});
