/// <reference lib="dom" />
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { mediaListBody, solidPng } from "../e2e/media-fixtures";
import { DETAIL_SALE_ID, saleDetailAnswers } from "./sale-detail-fixture";
import { acceptanceStates, firstAccessStates } from "./ui-account-states";
import { serveEntry } from "./ui-entry-states";
import { serveHome } from "./ui-home-states";
import { resultAnswers } from "./ui-result-states";
import { addSheet, rulesOutsideTailwindLayers } from "./ui-shell-isolation";
import { serveStockRows } from "./ui-stock-states";
import { WORKER_MARK } from "./worker-mark";

/**
 * The screens inside the real shell and the pages outside it (t193; since batch 6, t256): every style rule on the page
 * is in a layer of Tailwind, so nothing old or stray (a sheet with no layer, the old `@layer legacy`) can reach a
 * screen. The break this used to catch was `.ui-root input` giving the field of "Trocar senha" a border and a 2.8rem
 * height (ADR 0103, section 3). Every screen and state is opened, not one: the build splits CSS by chunk, so a sheet
 * can come with the lazy route or the state that loads it. How the proof works is in `ui-shell-isolation.ts`; the
 * runbook is docs/runbooks/testes-de-tela.md.
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
  contentType: "application/json",
  headers: { ...WORKER_MARK },
});

const RPC_PREFIX = /^.*\/rpc\//;

/**
 * The fewest style rules any measured page has (the CSS of the build is one sheet with every utility of every screen,
 * about a thousand rules). Far above zero, so a page whose sheet did not load, or a walk that reads nothing, fails.
 */
const STYLE_RULES_FLOOR = 500;

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
  await expect(page.locator(".app-shell-root")).toBeVisible();
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
        page.getByRole("heading", { exact: true, level: 1, name: "Produtos" })
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

/** The images panel of a product (v5.1) inside the real shell: the list answered here, two images and the variants to tie one to. */
const MEDIA_VARIANTS = {
  ...VARIANTS,
  configured: true,
  variants: [
    ...VARIANTS.variants,
    ...[1, 2].map((n) => ({
      id: id(60 + n),
      isDefault: false,
      listPrice: "50.00",
      sku: null,
      values: [
        {
          optionName: "color",
          optionValueId: id(40 + n),
          optionValueName: n === 1 ? "Azul" : "Preta",
        },
      ],
    })),
  ],
};

const serveMedia = async (page: Page) => {
  await page.route("**/api/media/**", (route) =>
    route.fulfill({
      body: solidPng(96, 96, [150, 160, 170]),
      contentType: "image/png",
    })
  );
  await page.route("**/api/products/*/media**", (route) =>
    route.request().method() === "GET"
      ? route.fulfill(json(JSON.parse(mediaListBody(2))))
      : route.abort("internetdisconnected")
  );
};

const openMediaPanel = (
  page: Page,
  then: (page: Page) => Promise<void> = async () => undefined
) =>
  openInShell(
    page,
    "/products",
    async () => {
      await expect(
        page.getByRole("heading", { exact: true, level: 1, name: "Produtos" })
      ).toBeVisible();
      await openMenu(page).click();
      await page.getByRole("menuitem", { name: "Imagens" }).click();
      await expect(
        page.getByRole("heading", { level: 3, name: "Imagens associadas" })
      ).toBeVisible();
      await expect(
        page.getByRole("img", { name: "Camiseta do teste, imagem 2" })
      ).toBeVisible();
      await then(page);
    },
    {
      "category/list": { categories: [] },
      "product/getVariants": MEDIA_VARIANTS,
      "product/list": { products: PRODUCTS },
    },
    serveMedia
  );

const CROP_AREA = /^Área de recorte/;

const MEDIA_SCREENS = [
  {
    name: "Produtos no shell: painel de imagens, remoção pedindo confirmação",
    open: (page: Page) =>
      openMediaPanel(page, async () => {
        await page.getByRole("button", { name: "Remover imagem 2" }).click();
        await expect(page.getByRole("alertdialog")).toBeVisible();
      }),
  },
  {
    name: "Produtos no shell: painel de imagens, imagem escolhida e recorte",
    open: (page: Page) =>
      openMediaPanel(page, async () => {
        await page.getByLabel("Escolher imagem").setInputFiles({
          buffer: solidPng(480, 320),
          mimeType: "image/png",
          name: "foto.png",
        });
        await expect(
          page.getByRole("button", { name: CROP_AREA })
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
          await page.getByRole("button", { name: "Novo cliente" }).click();
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

/** The real route `/sales/detail`, the API answered here: the receipt, a return made and the three panels in cards. */
const openSaleDetail = (
  page: Page,
  withReturn: boolean,
  then: (page: Page) => Promise<void> = async () => undefined
) =>
  openInShell(
    page,
    `/sales/detail?saleId=${DETAIL_SALE_ID}`,
    async () => {
      await expect(
        page.getByRole("heading", { level: 1, name: "Detalhe da venda" })
      ).toBeVisible();
      await expect(page.getByText("Ângela Souza").first()).toBeVisible();
      await then(page);
    },
    saleDetailAnswers({ withReturn })
  );

const SALE_DETAIL_SCREENS = [
  {
    name: "Detalhe da venda no shell",
    open: (page: Page) =>
      openSaleDetail(page, true, () =>
        expect(
          page.getByRole("heading", { level: 2, name: "Devoluções" })
        ).toBeVisible()
      ),
  },
  {
    // the return and the cancellation open: the table with its fields, the choice lists and the notes
    name: "Detalhe da venda no shell: devolução e cancelamento abertos",
    open: (page: Page) =>
      openSaleDetail(page, false, async () => {
        await page.getByRole("button", { name: "Registrar devolução" }).click();
        await page.getByRole("button", { name: "Cancelar venda" }).click();
        await expect(
          page.getByRole("button", { name: "Revisar cancelamento" })
        ).toBeVisible();
      }),
  },
];

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
    name: "Formas de receber no shell: lista e formulário novo",
    open: (page: Page) =>
      openPaymentProfiles(page, async () => {
        await page.getByRole("button", { name: "Novo perfil" }).click();
        await expect(page.getByLabel("Nome do perfil")).toBeFocused();
      }),
  },
  {
    // the form filled by an edit: selects, a fee with a percentage, and the hint of the unknown fee
    name: "Formas de receber no shell: edição",
    open: (page: Page) =>
      openPaymentProfiles(page, async () => {
        await page
          .getByRole("button", { name: "Editar perfil Maquininha da loja" })
          .click();
        await expect(page.getByLabel("Nome do perfil")).toBeFocused();
      }),
  },
  {
    name: "Formas de receber no shell: percentual inválido",
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
      // Despesas is a tab of the Resultado: the page behind it reads the goals and the summary too, and an unanswered
      // read would put the whole shell "offline" and turn off the button of the form
      "goal/list": { goals: [] },
      "report/periodSummary": {},
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
    // the month picker, the category filter, the tabs, the total and a row, under the form of a new expense with its errors
    name: "Despesas no shell: lista e erros do formulário",
    open: (page: Page) =>
      openExpenses(page, async () => {
        await page
          .getByRole("button", { exact: true, name: "Nova despesa" })
          .click();
        await page.getByRole("button", { name: "Registrar despesa" }).click();
        await expect(page.locator("#expense-description-error")).toBeVisible();
      }),
  },
  {
    // the Recorrentes part: the checkbox, a rule row and the form of a new rule
    name: "Despesas no shell: recorrentes",
    open: (page: Page) =>
      openExpenses(page, async () => {
        await page.getByRole("tab", { name: "Recorrentes" }).click();
        await page
          .getByRole("button", { name: "Nova despesa recorrente" })
          .click();
        await expect(
          page.getByLabel("Valor de cada ocorrência (R$)")
        ).toBeVisible();
      }),
  },
  {
    // the Categorias part: the checkbox, the categories by group and the form of a new category
    name: "Despesas no shell: categorias",
    open: (page: Page) =>
      openExpenses(page, async () => {
        await page.getByRole("tab", { name: "Categorias" }).click();
        await page
          .getByRole("button", { exact: true, name: "Nova categoria" })
          .click();
        await expect(page.getByLabel("Nome da categoria")).toBeVisible();
      }),
  },
];

const GOALS_TAB = /^Metas/;

/** The real route `/dashboard`, the period and the goals answered here, then a state to mount. */
const openResult = (
  page: Page,
  then: (page: Page) => Promise<void> = async () => undefined
) =>
  openInShell(
    page,
    "/dashboard",
    async () => {
      await expect(
        page.getByText("Estimativa incompleta").first()
      ).toBeVisible();
      await then(page);
    },
    resultAnswers
  );

const RESULT_SCREENS = [
  {
    // the periods, the warning, the badges, the cards, the chart of the sales, the chain and its parts bar
    name: "Resultado e Metas no shell: mês incompleto",
    open: (page: Page) => openResult(page),
  },
  {
    // the Metas tab: the cards of the goals
    name: "Resultado e Metas no shell: metas",
    open: (page: Page) =>
      openResult(page, async () => {
        await page.getByRole("tab", { name: GOALS_TAB }).click();
        await expect(page.getByText("Outubro forte").first()).toBeVisible();
      }),
  },
  {
    // the form of a new goal with its error: select, date fields and the amount with its "R$"
    name: "Resultado e Metas no shell: nova meta com erro",
    open: (page: Page) =>
      openResult(page, async () => {
        await page.getByRole("tab", { name: GOALS_TAB }).click();
        await page.getByRole("button", { name: "Nova meta" }).click();
        await page.getByRole("button", { name: "Criar meta" }).click();
        await expect(page.locator("#goal-create-target-error")).toBeVisible();
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
  ...MEDIA_SCREENS,
  ...LOT2_SCREENS,
  HISTORY,
  ...SALE_DETAIL_SCREENS,
  ...PAYMENT_SCREENS,
  {
    // with the figures read: the cards, the goal, the ranking and the chart of the charts chunk
    name: "Início no shell",
    open: (page: Page) =>
      openInShell(
        page,
        "/",
        async () => {
          await expect(
            page.getByRole("heading", { level: 1, name: "Início" })
          ).toBeVisible();
          await expect(
            page
              .getByRole("region", { name: "Vendas por dia" })
              .getByRole("img")
          ).toBeVisible();
        },
        {},
        serveHome
      ),
  },
  {
    name: "Venda no shell",
    open: (page: Page) =>
      openInShell(page, "/sales", () =>
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
  ...RESULT_SCREENS,
  {
    // the list read from the (answered) server, the runtime not ready: the rows, the line that says why the buttons are off
    name: "Aparelhos no shell",
    open: (page: Page) =>
      openInShell(
        page,
        "/devices",
        async () => {
          await expect(
            page.getByRole("heading", { level: 2, name: "Aparelhos" })
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
  test(`${screen.name}: toda regra da página está nas camadas do Tailwind`, async ({
    page,
  }) => {
    await screen.open(page);
    const rules = await rulesOutsideTailwindLayers(page);
    expect(rules.styleRules).toBeGreaterThan(STYLE_RULES_FLOOR);
    expect(rules.outside).toEqual([]);
  });
}

test.describe("controle: a verificação pega a regra fora das camadas do Tailwind", () => {
  // each sheet is a fault in the shape it would come; `found` is the line the check must print for it
  const FAULTS = [
    // the real fault of "Trocar senha", in the layer of the old sheets
    {
      css: "@layer legacy { .app-shell-root input { border: 1px solid rgb(255 0 0); } }",
      found: "@layer legacy: .app-shell-root input",
      name: "uma camada que não é do Tailwind (a antiga legacy)",
    },
    {
      css: "button { text-transform: uppercase; }",
      found: "sem camada: button",
      name: "uma regra sem camada",
    },
    {
      css: "@media (min-width: 1px) { :focus-visible { outline: 3px solid rgb(255 0 0); } }",
      found: "sem camada: :focus-visible",
      name: "sem camada dentro de @media",
    },
    {
      css: "@layer { input::placeholder { color: rgb(255 0 0); } }",
      found: "@layer anônima: input::placeholder",
      name: "uma camada anônima",
    },
    // a token rule with one property that is not a token is no longer only tokens
    {
      css: ":root { --sonda: 1px; color: rgb(255 0 0); }",
      found: "sem camada: :root",
      name: "regra de tokens com uma propriedade comum",
    },
    // tokens outside a layer on any other selector beat the theme
    {
      css: "* { --radius: 0; }",
      found: "sem camada: *",
      name: "tokens fora de :root e .dark",
    },
    {
      css: ".app-shell-root { & select { box-sizing: content-box; } }",
      found: "sem camada: & select",
      name: "regra aninhada sem camada",
    },
  ];
  for (const fault of FAULTS) {
    test(fault.name, async ({ page }) => {
      await CHANGE_PASSWORD.open(page);
      await addSheet(page, fault.css);
      const { outside } = await rulesOutsideTailwindLayers(page);
      expect(outside).toContain(fault.found);
    });
  }

  test("Produtos: a mesma falha é vista na tela de Produtos", async ({
    page,
  }) => {
    await PRODUCTS_LIST.open(page);
    await addSheet(
      page,
      "@layer legacy { .app-shell-root input { text-transform: uppercase; } }"
    );
    const { outside } = await rulesOutsideTailwindLayers(page);
    expect(outside).toEqual(["@layer legacy: .app-shell-root input"]);
  });

  test("uma regra nas camadas do Tailwind, mesmo aninhada, não reprova", async ({
    page,
  }) => {
    await CHANGE_PASSWORD.open(page);
    await addSheet(
      page,
      "@layer components { .sonda { color: red; } @layer interna { .sonda-2 { color: red; } } } " +
        "@layer utilities { @media (min-width: 1px) { .sonda-3 { color: red; } } } " +
        "@font-face { font-family: sonda; src: local(Arial); } @keyframes sonda { to { opacity: 0; } } " +
        ".dark { --sonda: 1px; color-scheme: dark; }"
    );
    expect((await rulesOutsideTailwindLayers(page)).outside).toEqual([]);
  });
});
