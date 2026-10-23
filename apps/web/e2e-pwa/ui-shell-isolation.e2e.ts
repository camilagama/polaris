/// <reference lib="dom" />
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { acceptanceStates, firstAccessStates } from "./ui-account-states";
import { serveEntry } from "./ui-entry-states";
import {
  addLegacyRule,
  addPageRule,
  addProbe,
  leaks,
  legacyLayerOnAndOff,
} from "./ui-shell-isolation";
import { serveStockRows } from "./ui-stock-states";
import { WORKER_MARK } from "./worker-mark";

/**
 * The migrated screens inside the real shell (t193): nothing of `@layer legacy` may reach what is under `[data-ui]`
 * (ADR 0103, section 3; the break was `.ui-root input` giving the field of "Trocar senha" a border and a 2.8rem
 * height). The screens of the guardrails (`ui-screens.ts`) run in the lab, which has no `.ui-root`, so they do not see it.
 * How the proof works is in `ui-shell-isolation.ts`; the runbook is docs/runbooks/testes-de-tela.md.
 */
const ORGANIZATION = {
  id: "0199c2d0-0000-7000-8000-00000000a001",
  name: "Loja do teste",
  role: "owner",
  timezone: "America/Sao_Paulo",
};
const WRITE_OFF_SHIRT = /^Baixar estoque de Camiseta/;
const json = (body: unknown) => ({
  body: JSON.stringify(body),
  headers: { ...WORKER_MARK },
  contentType: "application/json",
});

const RPC_PREFIX = /^.*\/rpc\//;

/**
 * The fewest rules of `@layer legacy` that any measured screen has on the page (they are the sheets of the screens not
 * migrated yet, which are loaded everywhere). The number follows the migration: 120 until t233 took app-shell.css,
 * logout-dialog.css and update-banner.css out of the layer, 90 on the entry pages, "Trocar senha" and "Estoque" since
 * (135 and 156 on "Produtos" and "Venda"), and 57 on the first access, the acceptance and the legal texts after t239 deleted
 * legal.css, acceptance.css, sign-in.css and the rules of the old setup card from ui.css. The floor is below the measured minimum so that one more sheet leaving the
 * layer does not break it, and far above the few rules a stray `@layer legacy` could have: if the layer stopped being
 * loaded the count would fall to zero. The controls below prove that what leaves is what the check compares.
 */
const LEGACY_RULES_FLOOR = 40;

/** The fonts are in and the finite animations are over (a spinner that never ends is not waited for). */
const settle = async (page: Page) => {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .every(
        (animation) =>
          animation.effect?.getComputedTiming().iterations ===
            Number.POSITIVE_INFINITY || animation.playState !== "running"
      )
  );
};

/** The app as someone signed in sees it: a session, one organization, and no server for anything else (offline). */
async function openInShell(
  page: Page,
  path: string,
  ready: () => Promise<void>,
  answers: Readonly<Record<string, unknown>> = {},
  serve?: (page: Page) => Promise<void>
) {
  await page.route("**/api/auth-methods", (route) =>
    route.fulfill(
      json({ emailPassword: true, google: true, turnstileSiteKey: null })
    )
  );
  await page.route("**/api/auth/get-session", (route) =>
    route.fulfill(json({ session: { id: "s" }, user: { id: "u" } }))
  );
  await page.route("**/rpc/**", (route) => {
    const procedure = new URL(route.request().url()).pathname.replace(
      RPC_PREFIX,
      ""
    );
    const answer =
      procedure === "organization/listMine"
        ? { organizations: [ORGANIZATION] }
        : answers[procedure];
    return answer === undefined
      ? route.abort("internetdisconnected")
      : route.fulfill(json({ json: answer, meta: [] }));
  });
  // after the catch-all above: the last route registered is the first asked
  await serve?.(page);
  await page.goto(path);
  await expect(page.locator(".ui-root.app-shell-root")).toBeVisible();
  await ready();
  await settle(page);
}

/** The pages of the entry and of the password: outside the shell, with the same sheets on the page. */
const ENTRY_PAGES = [
  { heading: "Entrar no Polaris", path: "/entrar" },
  { heading: "Criar conta", path: "/criar-conta" },
  { heading: "Esqueci a senha", path: "/esqueci-a-senha" },
  { heading: "Nova senha", path: "/redefinir-senha#token=tok-de-teste" },
];

const CHANGE_PASSWORD = {
  name: "Trocar senha no shell",
  open: (page: Page) =>
    openInShell(page, "/conta/seguranca", () =>
      expect(page.getByLabel("Senha atual")).toBeVisible()
    ),
};

const id = (n: number) => `0199c2d0-0000-7000-8000-0000000000${n}`;
const product = (n: number, name: string, description: string | null) => ({
  archivedAt: null,
  categoryId: null,
  createdAt: "2026-10-14T12:00:00.000Z",
  deletedAt: null,
  description,
  id: id(20 + n),
  name,
  organizationId: ORGANIZATION.id,
  status: "active",
  updatedAt: "2026-10-14T12:00:00.000Z",
  version: 1,
});
const PRODUCTS = [
  product(1, "Camiseta do teste", "Algodão, corte reto, azul."),
  product(
    2,
    "Cinto de couro legítimo com fivela dourada, tamanho único ajustável",
    null
  ),
];
const VARIANTS = {
  configured: false,
  optionValues: [],
  productId: id(21),
  productVersion: 1,
  variants: [
    {
      id: id(31),
      isDefault: true,
      listPrice: "50.00",
      sku: "CAM-001",
      values: [],
      version: 1,
    },
  ],
};

/** The real route `/products` (server mode, the API answered here), then a state of the screen the check can mount. */
const openProducts = (
  page: Page,
  products: unknown[],
  then: (page: Page) => Promise<void> = async () => undefined
) =>
  openInShell(
    page,
    "/products",
    async () => {
      await expect(
        page.getByRole("heading", { exact: true, name: "Produtos" })
      ).toBeVisible();
      await then(page);
    },
    {
      "category/list": { categories: [] },
      "product/getVariants": VARIANTS,
      "product/list": { products },
    }
  );
const openMenu = (page: Page) =>
  page.getByRole("button", { name: "Mais ações para Camiseta do teste" });

const PRODUCTS_LIST = {
  name: "Produtos no shell: lista",
  open: (page: Page) =>
    openProducts(page, PRODUCTS, () =>
      expect(page.getByText("Camiseta do teste")).toBeVisible()
    ),
};

const PRODUCTS_SCREENS = [
  PRODUCTS_LIST,
  {
    name: "Produtos no shell: menu de ações aberto",
    open: (page: Page) =>
      openProducts(page, PRODUCTS, async () => {
        await openMenu(page).click();
        await expect(
          page.getByRole("menuitem", { name: "Variantes" })
        ).toBeVisible();
      }),
  },
  {
    name: "Produtos no shell: sem produto",
    open: (page: Page) =>
      openProducts(page, [], () =>
        expect(page.getByText("Cadastre o primeiro para vender.")).toBeVisible()
      ),
  },
  {
    name: "Produtos no shell: formulário novo",
    open: (page: Page) =>
      openProducts(page, PRODUCTS, async () => {
        await page
          .getByRole("button", { name: "Novo produto" })
          .first()
          .click();
        await expect(page.getByLabel("Nome do produto")).toBeFocused();
      }),
  },
  {
    name: "Produtos no shell: formulário com erro no nome",
    open: (page: Page) =>
      openProducts(page, PRODUCTS, async () => {
        await page
          .getByRole("button", { name: "Novo produto" })
          .first()
          .click();
        await page.getByRole("button", { name: "Cadastrar produto" }).click();
        await expect(
          page.getByText("Informe o nome do produto.")
        ).toBeVisible();
      }),
  },
  {
    name: "Produtos no shell: busca sem resultado",
    open: (page: Page) =>
      openProducts(page, PRODUCTS, async () => {
        await expect(page.getByText("Camiseta do teste")).toBeVisible();
        await page.getByLabel("Buscar produto").fill("zzz");
        await expect(page.getByText("Nenhum produto com “zzz”.")).toBeVisible();
      }),
  },
  {
    name: "Produtos no shell: variantes",
    open: (page: Page) =>
      openProducts(page, PRODUCTS, async () => {
        await openMenu(page).click();
        await page.getByRole("menuitem", { name: "Variantes" }).click();
        await expect(
          page.getByRole("heading", { level: 3, name: "SKU das variantes" })
        ).toBeVisible();
      }),
  },
];

const DAY = "2026-10-14T12:00:00.000Z";
const category = (n: number, name: string) => ({
  archivedAt: null,
  createdAt: DAY,
  deletedAt: null,
  id: id(40 + n),
  name,
  organizationId: ORGANIZATION.id,
  status: "active",
  updatedAt: DAY,
});
const customer = (n: number, name: string, phone: string) => ({
  anonymizedAt: null,
  archivedAt: null,
  createdAt: DAY,
  email: null,
  id: id(60 + n),
  name,
  notes: null,
  organizationId: ORGANIZATION.id,
  phone,
  status: "active",
  updatedAt: DAY,
  version: 1,
});
const PUBLIC_CATALOG_SETUP = {
  enabled: true,
  profile: {
    description: "Roupas e acessórios.",
    instagram: null,
    publicName: "Loja da Ana",
    published: true,
    slug: "loja-da-ana",
    version: 2,
    whatsapp: null,
  },
  publicOrigin: "https://catalogo.example",
  publishedProductIds: [],
};

/** Categorias, Clientes and the public catalog (t235): each with the screen as it opens and one state with a field. */
const LOT2_SCREENS = [
  {
    name: "Categorias no shell: lista",
    open: (page: Page) =>
      openInShell(
        page,
        "/categories",
        () => expect(page.getByText("Camisetas")).toBeVisible(),
        { "category/list": { categories: [category(1, "Camisetas")] } }
      ),
  },
  {
    name: "Categorias no shell: renomeando",
    open: (page: Page) =>
      openInShell(
        page,
        "/categories",
        async () => {
          await page
            .getByRole("button", { name: "Mais ações para Camisetas" })
            .click();
          await page
            .getByRole("menuitem", { exact: true, name: "Renomear" })
            .click();
          await expect(
            page.getByLabel("Novo nome para Camisetas")
          ).toBeVisible();
        },
        { "category/list": { categories: [category(1, "Camisetas")] } }
      ),
  },
  {
    name: "Clientes no shell: lista",
    open: (page: Page) =>
      openInShell(
        page,
        "/customers",
        () => expect(page.getByText("Ana Lima")).toBeVisible(),
        {
          "customer/list": {
            customers: [customer(1, "Ana Lima", "11912345678")],
          },
        }
      ),
  },
  {
    name: "Clientes no shell: formulário com erro no nome",
    open: (page: Page) =>
      openInShell(
        page,
        "/customers",
        async () => {
          await page.getByRole("button", { name: "Cadastrar cliente" }).click();
          await expect(
            page.getByText("Informe o nome do cliente.")
          ).toBeVisible();
        },
        { "customer/list": { customers: [] } }
      ),
  },
  {
    name: "Catálogo público no shell: no ar",
    open: (page: Page) =>
      openInShell(
        page,
        "/public-catalog",
        () =>
          expect(page.getByLabel("Nome público")).toHaveValue("Loja da Ana"),
        {
          "product/list": { products: [] },
          "publicCatalog/setup": PUBLIC_CATALOG_SETUP,
        }
      ),
  },
  {
    name: "Catálogo público no shell: endereço recusado",
    open: (page: Page) =>
      openInShell(
        page,
        "/public-catalog",
        async () => {
          await page
            .getByLabel("Endereço", { exact: true })
            .fill("Loja da Ana!");
          await page.getByRole("button", { name: "Salvar perfil" }).click();
          await expect(page.locator("#public-slug-error")).toBeVisible();
        },
        {
          "product/list": { products: [] },
          "publicCatalog/setup": PUBLIC_CATALOG_SETUP,
        }
      ),
  },
];

const SALE_ID = id(70);
const historyEntry = (n: number, overrides: Record<string, unknown> = {}) => ({
  cancelledAt: null,
  confirmedAt: "2026-10-14T12:00:01.000Z",
  customerId: null,
  customerName: null,
  hasReturns: false,
  id: id(70 + n),
  itemCount: 2,
  occurredAt: "2026-10-14T12:00:00.000Z",
  occurredOn: "2026-10-14",
  paymentMethod: "pix",
  status: "confirmed",
  totalDue: "219.90",
  ...overrides,
});

/** The real route `/sales/history` (server mode, the list answered here): every badge, a customer, "Carregar mais". */
const HISTORY = {
  name: "Histórico de vendas no shell",
  open: (page: Page) =>
    openInShell(
      page,
      "/sales/history",
      async () => {
        await expect(
          page.getByRole("heading", { level: 1, name: "Histórico de vendas" })
        ).toBeVisible();
        await expect(page.getByText("Ângela Souza")).toBeVisible();
      },
      {
        "sale/list": {
          hasMore: true,
          sales: [
            historyEntry(1, {
              customerId: id(90),
              customerName: "Ângela Souza",
            }),
            historyEntry(2, {
              cancelledAt: "2026-10-13T12:00:00.000Z",
              status: "cancelled",
            }),
            historyEntry(3, { hasReturns: true }),
          ],
        },
      }
    ),
};

/** The real route `/sales/detail`: the receipt, a return made, and under them the old panels (outside `data-ui`). */
const SALE_DETAIL = {
  name: "Detalhe da venda no shell",
  open: (page: Page) =>
    openInShell(
      page,
      `/sales/detail?saleId=${SALE_ID}`,
      async () => {
        await expect(
          page.getByRole("heading", { level: 1, name: "Detalhe da venda" })
        ).toBeVisible();
        await expect(
          page.getByRole("heading", { level: 2, name: "Devoluções" })
        ).toBeVisible();
      },
      {
        "sale/get": {
          cancellation: null,
          customer: { customerId: null, version: 0 },
          returnSummary: [
            {
              availableToReturn: 1,
              position: 0,
              restockedQuantity: 0,
              returnedQuantity: 1,
              sold: 2,
            },
          ],
          returns: [
            {
              commandId: id(80),
              id: id(81),
              items: [
                { position: 0, restockedQuantity: 0, returnedQuantity: 1 },
              ],
              reasonCode: "defective",
              reasonNote: "Rasgada",
              returnedAt: "2026-10-15T12:00:00.000Z",
              returnedBy: "user_1",
              saleId: SALE_ID,
            },
          ],
          sale: {
            adjustments: [
              {
                amount: "10.00",
                kind: "discount",
                percentage: null,
                position: 0,
                valueType: "fixed",
              },
            ],
            items: [
              {
                chargedUnitPrice: "114.95",
                listedUnitPrice: "139.90",
                position: 0,
                productId: id(21),
                productLabel: "Calça jeans — 42",
                quantity: 2,
                unitCost: null,
                variantId: id(31),
              },
            ],
            payment: {
              amount: "219.90",
              anticipationFee: {
                amount: "0.00",
                fixedAmount: null,
                mode: "not_applicable",
                percentage: null,
              },
              anticipationRequested: false,
              expectedSettlementDays: null,
              installmentPlan: null,
              installments: null,
              method: "pix",
              paymentProfileId: null,
              paymentProfileName: null,
              paymentProfileRuleId: null,
              paymentProfileVersion: null,
              processingFee: {
                amount: null,
                fixedAmount: null,
                mode: "unknown",
                percentage: null,
              },
            },
            sale: {
              commandId: id(82),
              confirmedAt: "2026-10-14T12:00:01.000Z",
              currency: "BRL",
              id: SALE_ID,
              occurredAt: "2026-10-14T12:00:00.000Z",
              occurredOn: "2026-10-14",
              recordedAt: null,
            },
            totals: {
              discountTotal: "10.00",
              freightTotal: "0.00",
              paymentSurchargeTotal: "0.00",
              subtotal: "229.90",
              surchargeTotal: "0.00",
              totalDue: "219.90",
            },
          },
        },
      }
    ),
};
const fee = (mode: string, percentage: string | null) => ({
  fixedAmount: null,
  mode,
  percentage,
});
const PAYMENT_PROFILE = {
  archivedAt: null,
  createdAt: "2026-10-01T12:00:00.000Z",
  id: id(41),
  name: "Maquininha da loja",
  organizationId: ORGANIZATION.id,
  rules: [
    {
      anticipationFee: fee("unknown", null),
      expectedSettlementDays: 30,
      id: "rule-1",
      installmentPlan: "merchant",
      installments: 3,
      method: "credit_card",
      processingFee: fee("percentage", "3.000000"),
    },
  ],
  status: "active",
  updatedAt: "2026-10-01T12:00:00.000Z",
  version: 1,
};

/** The real route `/payment-profiles`, the API answered here, then a state of the screen the check can mount. */
const openPaymentProfiles = (
  page: Page,
  then: (page: Page) => Promise<void> = async () => undefined
) =>
  openInShell(
    page,
    "/payment-profiles",
    async () => {
      await expect(page.getByText("Maquininha da loja").first()).toBeVisible();
      await then(page);
    },
    { "paymentProfile/list": { profiles: [PAYMENT_PROFILE] } }
  );

const PAYMENT_SCREENS = [
  {
    name: "Perfis de pagamento no shell: lista e formulário novo",
    open: (page: Page) => openPaymentProfiles(page),
  },
  {
    // the form filled by an edit: selects, a fee with a percentage, and the hint of the unknown fee
    name: "Perfis de pagamento no shell: edição",
    open: (page: Page) =>
      openPaymentProfiles(page, async () => {
        await page
          .getByRole("button", { name: "Editar perfil Maquininha da loja" })
          .click();
        await expect(page.getByLabel("Nome do perfil")).toBeFocused();
      }),
  },
  {
    name: "Perfis de pagamento no shell: percentual inválido",
    open: (page: Page) =>
      openPaymentProfiles(page, async () => {
        await page
          .getByRole("button", { name: "Editar perfil Maquininha da loja" })
          .click();
        await page
          .getByLabel("Percentual efetivo sobre o total devido")
          .fill("150");
        await page.getByRole("button", { name: "Salvar alterações" }).click();
        await expect(
          page.getByText("Informe um percentual de 0 a 100", { exact: false })
        ).toBeVisible();
      }),
  },
];

const NOW = "2026-10-14T12:00:00.000Z";
const expenseCategory = (n: number, groupKey: string, name: string) => ({
  archivedAt: null,
  createdAt: NOW,
  groupKey,
  id: id(50 + n),
  name,
  organizationId: ORGANIZATION.id,
  status: "active",
  systemKey: null,
  updatedAt: NOW,
  version: 1,
});
const EXPENSE_CATEGORIES = [
  expenseCategory(1, "operational", "Aluguel"),
  expenseCategory(2, "commercial", "Marketing"),
];
const EXPENSE = {
  amount: "1500.50",
  categoryGroup: "operational",
  categoryId: id(51),
  categoryName: "Aluguel",
  competenceOn: "2026-10-01",
  createdAt: NOW,
  description: "Aluguel de outubro",
  id: id(61),
  organizationId: ORGANIZATION.id,
  payee: "Imobiliária Centro",
  recurringRuleId: id(71),
  saleId: null,
  status: "active",
  updatedAt: NOW,
  version: 1,
  voidedAt: null,
};
const EXPENSE_RULE = {
  amount: "1500.50",
  archivedAt: null,
  categoryGroup: "operational",
  categoryId: id(51),
  categoryName: "Aluguel",
  createdAt: NOW,
  description: "Aluguel de outubro",
  endsOn: null,
  frequency: "monthly",
  generatedCount: 4,
  id: id(71),
  nextOccurrenceOn: "2026-11-01",
  organizationId: ORGANIZATION.id,
  payee: null,
  startsOn: "2026-07-01",
  status: "active",
  updatedAt: NOW,
  version: 1,
};

/** The real route `/expenses`, the API answered here (the same answer for any month), then a state to mount. */
const openExpenses = (
  page: Page,
  then: (page: Page) => Promise<void> = async () => undefined
) =>
  openInShell(
    page,
    "/expenses",
    async () => {
      await expect(page.getByText("Aluguel de outubro").first()).toBeVisible();
      await then(page);
    },
    {
      "expense/list": {
        count: 1,
        expenses: [EXPENSE],
        nextCursor: null,
        total: "1500.50",
      },
      "expense/listCategories": { categories: EXPENSE_CATEGORIES },
      "expense/listRules": { rules: [EXPENSE_RULE] },
    }
  );

const EXPENSE_SCREENS = [
  {
    // the form with its errors, the month picker, the category filter, the tabs, the total and a row
    name: "Despesas no shell: lista e erros do formulário",
    open: (page: Page) =>
      openExpenses(page, async () => {
        await page.getByRole("button", { name: "Registrar despesa" }).click();
        await expect(page.locator("#expense-description-error")).toBeVisible();
      }),
  },
  {
    // both closed sections open: the checkboxes, a rule row, the form of a new rule and the categories
    name: "Despesas no shell: recorrentes e categorias",
    open: (page: Page) =>
      openExpenses(page, async () => {
        await page
          .getByRole("button", { name: "Despesas recorrentes" })
          .click();
        await page
          .getByRole("button", { name: "Categorias de despesa" })
          .click();
        await page
          .getByRole("button", { name: "Nova despesa recorrente" })
          .click();
        await expect(
          page.getByLabel("Valor de cada ocorrência (R$)")
        ).toBeVisible();
      }),
  },
];

const device = (n: number, label: string | null, lastSeenAt: string) => ({
  createdAt: "2026-10-01T12:00:00.000Z",
  id: id(40 + n),
  label,
  lastSeenAt,
  revokedAt: null,
});
const DEVICES = [
  device(1, "Chrome no Android", "2026-10-14T10:00:00.000Z"),
  device(2, "Celular da Ana", "2026-10-13T10:00:00.000Z"),
  device(3, null, "2026-10-12T10:00:00.000Z"),
];

const SCREENS = [
  CHANGE_PASSWORD,
  ...PRODUCTS_SCREENS,
  ...LOT2_SCREENS,
  HISTORY,
  SALE_DETAIL,
  ...PAYMENT_SCREENS,
  {
    name: "Venda no shell",
    open: (page: Page) =>
      openInShell(page, "/", () =>
        expect(
          page.getByRole("heading", { level: 1, name: "Nova venda" })
        ).toBeVisible()
      ),
  },
  {
    // with the rows read and a write-off open: the list, the stepper, the choice list, the note and the date
    name: "Estoque no shell",
    open: async (page: Page) => {
      await openInShell(
        page,
        "/inventory",
        async () => {
          await expect(
            page.getByRole("heading", { level: 1, name: "Estoque" })
          ).toBeVisible();
          await page.getByRole("button", { name: WRITE_OFF_SHIRT }).click();
          await expect(page.getByLabel("Observação (opcional)")).toBeVisible();
        },
        {},
        serveStockRows
      );
    },
  },
  ...EXPENSE_SCREENS,
  {
    // the list read from the (answered) server, the runtime not ready: the rows, the line that says why the buttons are off
    name: "Aparelhos no shell",
    open: (page: Page) =>
      openInShell(
        page,
        "/devices",
        async () => {
          await expect(
            page.getByRole("heading", { level: 1, name: "Aparelhos" })
          ).toBeVisible();
          await expect(page.getByText("Celular da Ana")).toBeVisible();
        },
        { "device/list": { devices: DEVICES } }
      ),
  },
  {
    // without the runtime (the pwa-e2e shell has no server for it) the page is the loading of the shell pieces, which
    // says the offline mode is not ready; the panel with its title is measured by the guardrails
    name: "Pendências no shell",
    open: (page: Page) =>
      openInShell(page, "/attention", () =>
        expect(
          page.getByText(
            "O modo offline não está disponível neste aparelho agora."
          )
        ).toBeVisible()
      ),
  },
  // the first access, the acceptance and a legal text stand outside the shell, on the entry card
  { name: "Primeiro acesso", open: firstAccessStates.empty },
  { name: "Aceite dos termos", open: acceptanceStates.first },
  {
    name: "/privacidade",
    open: async (page: Page) => {
      await page.goto("/privacidade");
      await expect(page.getByText("Versão 1. Em vigor desde:")).toBeVisible();
      await settle(page);
    },
  },
  ...ENTRY_PAGES.map(({ heading, path }) => ({
    name: path,
    open: async (page: Page) => {
      await serveEntry(page);
      await page.goto(path);
      await expect(
        page.getByRole("heading", { level: 1, name: heading })
      ).toBeVisible();
      await settle(page);
    },
  })),
];

for (const screen of SCREENS) {
  test(`${screen.name}: a camada legacy não muda nada sob [data-ui]`, async ({
    page,
  }) => {
    await screen.open(page);
    await addProbe(page);
    const state = await legacyLayerOnAndOff(page);
    const names = Object.keys(state.on.snapshot);
    // the check is not vacuous: the layer was on the page and came off, there was something to measure, the probe
    // was measured, and so was the focus (Tab put the page in keyboard mode and some control took the ring)
    expect(state.off.removed).toBeGreaterThan(LEGACY_RULES_FLOOR);
    expect(names.length).toBeGreaterThan(20);
    expect(
      names.some((name) => name.startsWith('input "sonda com erro"'))
    ).toBe(true);
    expect(names.some((name) => name.endsWith(":focus-visible"))).toBe(true);
    expect(leaks(state)).toEqual([]);
  });
}

test.describe("controle: a verificação pega a regra legacy que vaza", () => {
  // each rule is the fault in the shape it had, injected in the layer; `found` is what the check must print for it
  const LEAKS = [
    // the real fault of "Trocar senha": the field of the group takes the border of the old input
    {
      css: ".ui-root input { border: 1px solid rgb(255 0 0); }",
      found:
        'input[input-group-control] "Senha atual": border-top-color rgb(255, 0, 0) (com legacy)',
      name: ".ui-root input (a regra do ui.css antes da correção)",
    },
    // a rule of the old sheets for every button of the page, with no `.ui-root` to say where it is meant for
    {
      css: "button { text-transform: uppercase; }",
      found: ": text-transform uppercase (com legacy)",
      from: 'button[button] "Mostrar',
      name: "button sem escopo",
    },
    {
      css: ".ui-root :focus-visible { outline: 3px solid rgb(255 0 0); }",
      found: ":focus-visible: outline-color rgb(255, 0, 0) (com legacy)",
      name: ".ui-root :focus-visible (o contorno do campo e do título)",
    },
    // the rules of ui.css that the open screens do not show, on the probe
    {
      css: '.ui-root input[aria-invalid="true"] { border-color: rgb(255 0 0); }',
      found:
        'input "sonda com erro": border-top-color rgb(255, 0, 0) (com legacy)',
      name: '.ui-root input[aria-invalid="true"]',
    },
    {
      css: ".ui-root input::placeholder { color: rgb(255 0 0); }",
      found:
        'input "sonda com texto de apoio" ::placeholder: color rgb(255, 0, 0) (com legacy)',
      name: ".ui-root input::placeholder",
    },
    {
      css: ".ui-root select { box-sizing: content-box; }",
      found: 'select "sonda de lista": box-sizing content-box (com legacy)',
      name: ".ui-root select",
    },
    // the margin of the probe: a side the layer gives to a control is a leak
    {
      css: ".ui-root select { margin-top: 7px; }",
      found: 'select "sonda de lista": margin-top 7px (com legacy)',
      name: ".ui-root select (margem)",
    },
    {
      css: ".ui-root textarea { box-sizing: content-box; }",
      found: 'textarea "sonda de texto": box-sizing content-box (com legacy)',
      name: ".ui-root textarea",
    },
  ];
  for (const leak of LEAKS) {
    test(leak.name, async ({ page }) => {
      await CHANGE_PASSWORD.open(page);
      await addProbe(page);
      await addLegacyRule(page, leak.css);
      const found = leaks(await legacyLayerOnAndOff(page));
      expect(
        found.some(
          (line) =>
            line.startsWith(leak.from ?? "") && line.includes(leak.found)
        )
      ).toBe(true);
    });
  }

  test("Produtos: a regra antiga do campo de busca é vista na tela de Produtos", async ({
    page,
  }) => {
    await PRODUCTS_LIST.open(page);
    await addLegacyRule(page, ".ui-root input { text-transform: uppercase; }");
    const found = leaks(await legacyLayerOnAndOff(page));
    expect(
      found.some(
        (line) =>
          line.startsWith('input[input-group-control] "Buscar produto"') &&
          line.includes("text-transform uppercase (com legacy)")
      )
    ).toBe(true);
  });

  test("o que transiciona também é visto (a leitura não pega o começo da transição)", async ({
    page,
  }) => {
    await CHANGE_PASSWORD.open(page);
    await addPageRule(page, "[data-ui] input { transition: border-color 5s; }");
    await addLegacyRule(page, ".ui-root input { border-color: rgb(255 0 0); }");
    const found = leaks(await legacyLayerOnAndOff(page));
    expect(
      found.some((line) =>
        line.includes(
          'input[input-group-control] "Senha atual": border-top-color rgb(255, 0, 0)'
        )
      )
    ).toBe(true);
  });

  test("a margem auto que acompanha o contêiner não reprova", async ({
    page,
  }) => {
    await CHANGE_PASSWORD.open(page);
    await addProbe(page);
    await addPageRule(
      page,
      '[data-ui] select[aria-label="sonda de lista"] { display: block; width: 10rem; margin-inline: auto; }'
    );
    // the old layer changes the width of the shell, so the used value of the `auto` margins changes
    await addLegacyRule(page, ".ui-root { padding-left: 40px; }");
    expect(leaks(await legacyLayerOnAndOff(page))).toEqual([]);
  });

  test("uma regra legacy só para o que é antigo não reprova", async ({
    page,
  }) => {
    await CHANGE_PASSWORD.open(page);
    await addProbe(page);
    // the frame of the shell is new since v5.1 (t225): what is old is `main` itself, where the old screens live
    await addLegacyRule(
      page,
      ".app-shell-root main { outline: 2px solid rgb(255 0 0); background: rgb(255 0 0); }"
    );
    expect(leaks(await legacyLayerOnAndOff(page))).toEqual([]);
  });
});
