/// <reference lib="dom" />
// Only types from Playwright: `ui-screens.ts` is read under Vitest by the source rules.
import type { Page } from "@playwright/test";

/**
 * The states of Categorias, Clientes and the public catalog of the ERP the interface guardrails measure (t235, lot
 * 2): each screen in the lab of the screens (`/offline-screens-lab?screen=…`) over the real offline runtime, with the
 * server answered by the test (`page.route`; Clientes uses the lab's own simulated server) and synthetic data only.
 * The lab's own controls are hidden at the end of each state, so what is measured is the screen alone. Three states
 * per screen, as the lab starts the runtime (OPFS and SQLite) in every context of the map and the CI job has a limit;
 * the others (the empty list, the load error, the archived tab, the plan, the rename form) are proved in
 * `e2e/lote-2-telas.e2e.ts` and `e2e/usabilidade-lote-1.e2e.ts`, and in the captures of the pull request.
 */
const ORGANIZATION_ID = "0199c2d0-0000-7000-8000-00000000a001";
const DAY = "2026-10-14T12:00:00.000Z";
const id = (n: number) =>
  `0199c2d0-0000-7000-8000-${String(n).padStart(12, "0")}`;

const rpc = (body: unknown) => ({
  body: JSON.stringify({ json: body, meta: [] }),
  contentType: "application/json",
});

const STRIP = "Esta tela precisa de conexão.";

/** Starts the runtime of the lab for the screen and waits until it is ready. */
async function startLab(page: Page, screen: string) {
  await page.goto(`/offline-screens-lab?screen=${screen}`);
  await page.getByLabel("Usuário").fill(`guardrails-${crypto.randomUUID()}`);
  await page.getByRole("button", { exact: true, name: "Iniciar" }).click();
  await page
    .getByTestId("message")
    .filter({ hasText: "Iniciar: ok (ready)" })
    .waitFor({ timeout: 20_000 });
}

/** Hides the lab's own controls and waits for the fonts: what stays is the screen. */
async function showScreenAlone(page: Page) {
  await page.evaluate(() => {
    for (const element of document.querySelectorAll("[data-lab-chrome]")) {
      (element as HTMLElement).hidden = true;
    }
    (document.activeElement as HTMLElement | null)?.blur();
    window.scrollTo(0, 0);
  });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
}

const heading = (page: Page, name: string) =>
  page.getByRole("heading", { exact: true, level: 1, name }).waitFor();

// ---- Categorias -----------------------------------------------------------------------------------------------

const category = (n: number, name: string) => ({
  archivedAt: null,
  createdAt: DAY,
  deletedAt: null,
  id: id(100 + n),
  name,
  organizationId: ORGANIZATION_ID,
  status: "active",
  updatedAt: DAY,
});

const CATEGORIES = [
  category(1, "Camisetas"),
  category(
    2,
    "Acessórios para o verão com um nome bem comprido que quebra em duas linhas"
  ),
  category(3, "Calçados"),
];

async function openCategories(page: Page) {
  await page.route("**/rpc/category/list", (route) =>
    route.fulfill(rpc({ categories: CATEGORIES }))
  );
  await startLab(page, "categories");
  await heading(page, "Categorias");
  await page.getByText("Camisetas").waitFor();
}

export const categoryStates = {
  /** The list over the form of a new category. */
  async list(page: Page) {
    await openCategories(page);
    await showScreenAlone(page);
  },

  /** Without a connection: the strip of the screens that need one, over the same list. */
  async offline(page: Page) {
    await openCategories(page);
    await page.getByLabel("Rede disponível").uncheck();
    await page.getByText(STRIP).waitFor();
    await showScreenAlone(page);
  },

  /** The confirmation of a removal, in the row: the destructive button and the text of what stays. */
  async remove(page: Page) {
    await openCategories(page);
    await page
      .getByRole("button", { name: "Mais ações para Camisetas" })
      .click();
    await page.getByRole("menuitem", { exact: true, name: "Remover" }).click();
    await page
      .getByRole("group", { name: "Confirmar remoção de Camisetas" })
      .waitFor();
    await showScreenAlone(page);
  },
};

// ---- Clientes -------------------------------------------------------------------------------------------------

async function openCustomers(page: Page) {
  await startLab(page, "customers");
  await heading(page, "Clientes");
}

async function register(page: Page, name: string, phone: string) {
  await page.locator("#customer-name").fill(name);
  await page.locator("#customer-phone").fill(phone);
  await page.getByRole("button", { name: "Cadastrar cliente" }).click();
}

/** The customers that the server has confirmed: no row says "Aguardando envio" any more. */
const noPendingRow = (page: Page) =>
  page.waitForFunction(
    () => document.querySelectorAll("[data-sync-state]").length === 0
  );

export const customerStates = {
  /** Two customers, one with a name that does not fit a line; the form is over the list. */
  async list(page: Page) {
    await openCustomers(page);
    await register(page, "Ana Lima", "11912345678");
    await page.getByText("Ana Lima").first().waitFor();
    await register(
      page,
      "Bruno Carvalho de Albuquerque Montenegro Filho",
      "21988887777"
    );
    await page.getByText("Bruno Carvalho").first().waitFor();
    await noPendingRow(page);
    await showScreenAlone(page);
  },

  /** A customer with the phone of another: the panel of the possible duplicates, with its two buttons (U-25). */
  async duplicate(page: Page) {
    await openCustomers(page);
    await register(page, "Carla Dias", "11900000003");
    await page.getByText("Carla Dias").first().waitFor();
    await noPendingRow(page);
    await register(page, "Carla D.", "11900000003");
    await page.getByText("Mesmo telefone").waitFor();
    await showScreenAlone(page);
  },

  /** Without a connection a customer is kept on the device: the strip, the row waiting to be sent, the menu off. */
  async offline(page: Page) {
    await openCustomers(page);
    await page.getByLabel("Rede disponível").uncheck();
    await page.getByText("Sem conexão.", { exact: true }).waitFor();
    await register(page, "Bia Souza", "11900000002");
    await page.getByText("Aguardando envio").waitFor();
    await showScreenAlone(page);
  },
};

// ---- Catálogo público -----------------------------------------------------------------------------------------

const PROFILE = {
  description: "Roupas e acessórios para o dia a dia.",
  instagram: "lojadaana",
  publicName: "Loja da Ana",
  published: true,
  slug: "loja-da-ana",
  version: 2,
  whatsapp: "11912345678",
};
const SETUP = {
  enabled: true,
  profile: null,
  publicOrigin: "https://catalogo.example",
  publishedProductIds: [] as string[],
};
const product = (n: number, name: string) => ({
  archivedAt: null,
  categoryId: null,
  createdAt: DAY,
  deletedAt: null,
  description: null,
  id: id(300 + n),
  name,
  organizationId: ORGANIZATION_ID,
  status: "active",
  updatedAt: DAY,
  version: 1,
});
const PRODUCTS = [
  product(1, "Camiseta Básica"),
  product(2, "Calça jeans"),
  product(
    3,
    "Cinto de couro legítimo com fivela dourada, tamanho único ajustável"
  ),
];

async function openCatalog(page: Page, setup: unknown) {
  await page.route("**/rpc/publicCatalog/setup", (route) =>
    route.fulfill(rpc(setup))
  );
  await page.route("**/rpc/product/list", (route) =>
    route.fulfill(rpc({ products: PRODUCTS }))
  );
  await startLab(page, "public-catalog");
  await heading(page, "Catálogo público");
  await page.getByLabel("Nome público").waitFor();
}

export const catalogStates = {
  /** A saved profile, the catalog on the air and one product chosen: the three cards, with the link. */
  async live(page: Page) {
    await openCatalog(page, {
      ...SETUP,
      profile: PROFILE,
      publishedProductIds: [id(301)],
    });
    await page.getByText("No ar: qualquer pessoa").waitFor();
    await showScreenAlone(page);
  },

  /** Without a connection: the strip over a new profile, and what was typed stays (U-54). */
  async offline(page: Page) {
    await openCatalog(page, SETUP);
    await page.getByLabel("Nome público").fill("Loja da Ana");
    await page.getByLabel("Rede disponível").uncheck();
    await page.getByText(STRIP).waitFor();
    await showScreenAlone(page);
  },

  /** An address that the rules refuse: the message under its field and the summary under the button (U-48, U-49). */
  async slugError(page: Page) {
    await openCatalog(page, SETUP);
    await page.getByLabel("Nome público").fill("Loja da Ana");
    await page.getByLabel("Endereço", { exact: true }).fill("Loja da Ana!");
    await page.getByRole("button", { name: "Salvar perfil" }).click();
    await page.locator("#public-slug-error").waitFor();
    await showScreenAlone(page);
  },
};
