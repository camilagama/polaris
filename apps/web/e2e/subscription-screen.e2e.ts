/// <reference lib="dom" />
import type { Page, Route } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { serveHealth, WORKER_MARK } from "./worker-mark";

/**
 * The Assinatura (corte assinatura-e-cancelar, AC-8 to AC-19 and AC-35; design t268 v2, § 11) in the real route,
 * with the API answered by the test: each state of `billing.readPlan`, the offer with the catalog's prices and the
 * server's methods, the card's checkout (one call for a double click), the return of the card's page read again
 * every 5 s, Pix Automático with its code and its page and no "7 dias", each refusal of the checkout with its own
 * text, no plan of before offline, the place in the menu (2 taps on the phone) and the notice of grace at the top.
 */
const ORGANIZATION = {
  id: "0199c2d0-0000-7000-8000-00000000a001",
  name: "Loja do teste",
  role: "owner",
  timezone: "America/Sao_Paulo",
};
const SESSION_USER = {
  email: "dona@exemplo.test",
  id: "u",
  name: "Ana Dona",
};
/** The provider's page of the card: the test answers it, so nothing leaves the machine. */
const CARD_PAGE = "https://sandbox.asaas.com/c/checkout-e2e";
const PIX_PAGE = "https://app.woovi-sandbox.com/pay/e2e";
const PIX_CODE =
  "00020126580014br.gov.bcb.pix0136a1b2c3d4-0000-4000-8000-0000000000075204000053039865802BR5909POLARIS6009SANTAREM62070503***6304A1B2";
/** The names the tests look for (regular expressions at the top level). */
const MONTHLY = /Mensal/;
const CARD = /Cartão de crédito/;
const ANNUAL = /Anual/;
const NO_CARD_PROMISE = /sem cartão/i;
const PIX = /Pix Automático/;
const PHONE = /telefone/i;
const FREE_WORD = /grátis/;
const SUBSCRIBE_ACTION = /Assinar|Começar/;
const REFUND_WORD = /reembolso/i;
/** 23/10/2026 at noon in São Paulo: the first charge of a trial started now is on 30/10/2026. */
const NOW = new Date("2026-10-23T15:00:00.000Z");

const rpc = (json: unknown, status = 200) => ({
  body: JSON.stringify({ json, meta: [] }),
  contentType: "application/json",
  headers: { ...WORKER_MARK },
  status,
});
const refusal = (code: string, status: number, data: unknown) =>
  rpc({ code, data, defined: false, message: code, status }, status);

type Plan = Record<string, unknown>;

/** A Free store with the trial available, as the server reads it; each test changes what it needs. */
const plan = (overrides: Plan = {}): Plan => ({
  accessEndsAt: null,
  cycleMonths: null,
  kept: { historyMonths: 3, products: 18, sales: 47 },
  limits: { goals: 1, images: 50, variants: 50 },
  method: null,
  nextCharge: null,
  offer: {
    methods: ["card", "pix_automatic"],
    prices: [
      { amount: "249.00", cycleMonths: 12 },
      { amount: "24.90", cycleMonths: 1 },
    ],
  },
  recovery: null,
  refund: null,
  refundPending: false,
  refundWindowEndedOn: null,
  renewalCancelled: false,
  resubscribeFrom: null,
  state: "free",
  trialAvailable: true,
  usage: { goals: 1, images: 12, variants: 38 },
  ...overrides,
});
const ACTIVE = plan({
  accessEndsAt: "2026-11-24T03:00:00.000Z",
  cycleMonths: 1,
  // the Pro's limits, as the catalog gives them (not the Free's, which would put 2 of 1 on a Pro store)
  limits: { goals: 3, images: 5000, variants: 2000 },
  method: "card",
  nextCharge: { amount: "24.90", on: "2026-11-23" },
  state: "active",
  usage: { goals: 2, images: 12, variants: 38 },
});
const GRACE = plan({
  accessEndsAt: "2026-10-31T03:00:00.000Z",
  cycleMonths: 1,
  method: "card",
  state: "grace",
});

interface ScreenOptions {
  billingSelfService?: boolean;
  /** What `billing/startCheckout` answers, in order; the last one repeats. */
  checkouts?: ReadonlyArray<(route: Route) => Promise<void>>;
  path?: string;
  /** What `billing/readPlan` answers, in order; the last one repeats. */
  plans?: ReadonlyArray<Plan | ((route: Route) => Promise<void>)>;
  role?: string;
}

interface Calls {
  checkouts: Record<string, unknown>[];
  reads: number;
}

async function openScreen(
  page: Page,
  {
    billingSelfService = true,
    checkouts = [],
    path = "/configuracoes?aba=assinatura",
    plans = [plan()],
    role = "owner",
  }: ScreenOptions = {}
): Promise<Calls> {
  const calls: Calls = { checkouts: [], reads: 0 };
  await page.route("**/api/auth/get-session", (route) =>
    route.fulfill({
      body: JSON.stringify({ session: { id: "s" }, user: SESSION_USER }),
      contentType: "application/json",
      headers: { ...WORKER_MARK },
    })
  );
  await serveHealth(page);
  await page.route("https://sandbox.asaas.com/**", (route) =>
    route.fulfill({
      body: "<!doctype html><title>Asaas</title><p>Página de pagamento</p>",
      contentType: "text/html",
    })
  );
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
    if (procedure === "billing/readPlan") {
      const answer = plans[Math.min(calls.reads, plans.length - 1)];
      calls.reads += 1;
      if (typeof answer === "function") {
        return answer(route);
      }
      return route.fulfill(rpc(answer));
    }
    if (procedure === "billing/startCheckout") {
      const { json } = route.request().postDataJSON() as {
        json: Record<string, unknown>;
      };
      calls.checkouts.push(json);
      const answer =
        checkouts[Math.min(calls.checkouts.length - 1, checkouts.length - 1)];
      return answer ? answer(route) : route.abort("internetdisconnected");
    }
    return route.abort("internetdisconnected");
  });
  await page.goto(path);
  return calls;
}

/** The Assinatura is a tab of Configurações (map of navigation, § 1): its title is under the h1 of the screen. */
const title = (page: Page) =>
  page.getByRole("heading", { exact: true, level: 2, name: "Assinatura" });
const planTitle = (page: Page) => page.locator("#subscription-plan-title");
const terms = (page: Page) => page.getByTestId("subscription-terms");

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(NOW);
});

test("Free com o teste: plano, uso, oferta com o mensal marcado e o anual em destaque, e o preço antes do botão (AS-9, AS-11, AS-12, AS-14)", async ({
  page,
}) => {
  await openScreen(page);
  await expect(title(page)).toBeVisible();
  await expect(planTitle(page)).toHaveText("Plano Free");
  await expect(page.getByText("Você usa 38 de 50 variantes.")).toBeVisible();
  await expect(
    page.getByRole("progressbar", { name: "Variantes: 38 de 50" })
  ).toBeVisible();
  await expect(
    page.getByRole("progressbar", { name: "Metas em andamento: 1 de 1" })
  ).toBeVisible();
  // AS-24, D1: the store's numbers, with "e" before the last
  await expect(
    page.getByText(
      "O que a sua loja já guardou: 47 vendas, 18 produtos e 3 meses de histórico. Seus dados não são apagados."
    )
  ).toBeVisible();

  const cycle = page.getByRole("radiogroup", { name: "Ciclo" });
  await expect(cycle.getByRole("radio", { name: MONTHLY })).toBeChecked();
  await expect(cycle).toContainText("R$ 24,90 por mês");
  await expect(cycle).toContainText("2 meses grátis");
  await expect(cycle).toContainText("R$ 249,00 por ano · R$ 20,75 por mês");
  const method = page.getByRole("radiogroup", { name: "Como pagar" });
  await expect(method.getByRole("radio", { name: CARD })).toBeChecked();
  await expect(method).toContainText(
    "Você vai pagar na página segura do Asaas. O Polaris não vê o número do cartão."
  );
  await expect(terms(page)).toContainText(
    "7 dias grátis. A primeira cobrança, de R$ 24,90, é em 30/10/2026. Cancele antes e nada é cobrado."
  );
  await expect(
    page.getByRole("button", { name: "Começar os 7 dias grátis" })
  ).toBeVisible();
  // the annual price is the total, before any page
  await cycle.getByRole("radio", { name: ANNUAL }).click();
  await expect(terms(page)).toContainText("de R$ 249,00, é em 30/10/2026");
  // never "sem cartão" next to the Pro
  await expect(page.locator("main")).not.toContainText(NO_CARD_PROMISE);
  // the deadline and the legal line, each on its own line
  await expect(page.locator("main footer p")).toHaveText([
    "Você pode desistir em até 7 dias depois da primeira cobrança e receber o valor de volta.",
    "Polaris, um produto de Agência Summit, CNPJ 35.584.467/0001-00.",
  ]);
  // the Terms and the Privacy Policy are the shell's, once on the screen
  await expect(page.locator("main footer").getByRole("link")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Termos de Uso" })).toHaveCount(
    1
  );
});

test("Pix Automático: 'Começar o teste grátis' sem número de dias, nome e e-mail da conta, CPF com teclado numérico e sem telefone (AS-12 emenda, AS-13)", async ({
  page,
}) => {
  await openScreen(page);
  await page
    .getByRole("radiogroup", { name: "Como pagar" })
    .getByRole("radio", { name: PIX })
    .click();
  const start = page.getByRole("button", { name: "Começar o teste grátis" });
  await expect(start).toBeVisible();
  await expect(terms(page)).not.toContainText("7 dias");
  await expect(start).not.toContainText("7 dias");
  await expect(terms(page)).toContainText(
    "Teste grátis. A primeira cobrança, de R$ 24,90, é em 30/10/2026."
  );
  await expect(page.getByLabel("Nome", { exact: true })).toHaveValue(
    "Ana Dona"
  );
  await expect(page.getByLabel("E-mail")).toHaveValue("dona@exemplo.test");
  await expect(page.getByLabel("CPF ou CNPJ")).toHaveAttribute(
    "inputmode",
    "numeric"
  );
  await expect(page.getByLabel(PHONE)).toHaveCount(0);
  await expect(
    page.getByText(
      "Esses dados vão para o serviço de pagamento do Pix só para criar a cobrança."
    )
  ).toBeVisible();
});

test("sem o teste disponível, 'Assinar o Pro' e 'Seu teste grátis já foi usado.' (AS-12)", async ({
  page,
}) => {
  await openScreen(page, { plans: [plan({ trialAvailable: false })] });
  await expect(terms(page)).toContainText(
    "Seu teste grátis já foi usado. A primeira cobrança, de R$ 24,90, é hoje."
  );
  await expect(
    page.getByRole("button", { name: "Assinar o Pro" })
  ).toBeVisible();
  await expect(page.getByRole("button", { name: FREE_WORD })).toHaveCount(0);
});

test("cada estado tem título e linha de apoio próprios (AS-9)", async ({
  page,
}) => {
  const cases: [Plan, string, string][] = [
    [
      plan({
        state: "free_over_limit",
        usage: { goals: 1, images: 12, variants: 62 },
      }),
      "Plano Free",
      "Sua loja tem mais variantes do que o Free permite. Seus dados estão guardados.",
    ],
    [
      plan({ method: "card", state: "trial_setup" }),
      "Falta autorizar o pagamento",
      "O teste começa quando o pagamento ficar pronto.",
    ],
    [
      plan({
        accessEndsAt: "2026-10-31T03:00:00.000Z",
        cycleMonths: 1,
        method: "card",
        nextCharge: { amount: "24.90", on: "2026-10-30" },
        state: "trialing",
      }),
      "Pro, em teste",
      "A primeira cobrança é em 30/10/2026. Cancele antes e nada é cobrado.",
    ],
    [ACTIVE, "Plano Pro", "Próxima cobrança em 23/11/2026, R$ 24,90."],
    [
      {
        ...ACTIVE,
        nextCharge: null,
        renewalCancelled: true,
        resubscribeFrom: "2026-11-24T03:00:00.000Z",
      },
      "Pro até 23/11/2026",
      "Depois dessa data a loja volta ao Free. Seus dados ficam.",
    ],
    [
      GRACE,
      "Pagamento não confirmado",
      "Seu Pro vai até 30/10/2026. Depois a loja volta ao Free e seus dados ficam.",
    ],
  ];
  for (const [answer, heading, support] of cases) {
    // biome-ignore lint/performance/noAwaitInLoops: one case after the other, on the same page
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await openScreen(page, { plans: [answer] });
    await expect(planTitle(page)).toHaveText(heading);
    await expect(page.getByText(support, { exact: true })).toBeVisible();
  }
  // the cancelled renewal offers no "Assinar" before its end (AS-27)
  await expect(
    page.getByRole("button", { name: SUBSCRIBE_ACTION })
  ).toHaveCount(0);
});

test("Pro ativo e renovação cancelada: como paga, o ciclo, a próxima cobrança, e quando dá para assinar de novo (AS-27)", async ({
  page,
}) => {
  await openScreen(page, { plans: [ACTIVE] });
  await expect(page.getByText("Ativo", { exact: true })).toBeVisible();
  const payment = page.locator("dl");
  await expect(payment).toContainText("Como paga");
  await expect(payment).toContainText("Cartão de crédito");
  await expect(payment).toContainText("Mensal · R$ 24,90");
  await expect(payment).toContainText("23/11/2026 · R$ 24,90");
  await expect(page.getByRole("radiogroup")).toHaveCount(0);

  await page.unrouteAll({ behavior: "ignoreErrors" });
  await openScreen(page, {
    plans: [
      {
        ...ACTIVE,
        nextCharge: null,
        renewalCancelled: true,
        resubscribeFrom: "2026-11-24T03:00:00.000Z",
      },
    ],
  });
  await expect(page.getByText("Renovação cancelada")).toBeVisible();
  await expect(page.locator("dl")).toContainText("Nenhuma");
  await expect(
    page.getByText(
      "Dá para assinar de novo depois de 23/11/2026, quando este período termina."
    )
  ).toBeVisible();
});

test("uso acima do limite, também no Pro: selo e barra cheia; sem limite, só o número", async ({
  page,
}) => {
  await openScreen(page, {
    plans: [
      {
        ...ACTIVE,
        limits: { goals: 3, images: null, variants: 2000 },
        usage: { goals: 4, images: 700, variants: 38 },
      },
    ],
  });
  await expect(planTitle(page)).toHaveText("Plano Pro");
  await expect(
    page.getByRole("progressbar", {
      name: "Metas em andamento: 4 de 3, acima do limite",
    })
  ).toBeVisible();
  await expect(page.getByText("acima do limite")).toHaveCount(1);
  await expect(page.getByText("sem limite")).toHaveCount(0);
  await expect(page.getByRole("progressbar")).toHaveCount(2);
});

test("reembolso pedido e não concluído: dentro das 72 h, o texto do AS-42; depois, o suporte, sem tentar de novo (E-RP)", async ({
  page,
}) => {
  const pending = {
    ...ACTIVE,
    nextCharge: null,
    refundPending: true,
    renewalCancelled: true,
  };
  await openScreen(page, {
    plans: [
      {
        ...pending,
        refund: {
          amount: "24.90",
          until: "2026-10-31T02:59:59.000Z",
          via: "app",
        },
      },
    ],
  });
  await expect(page.getByText("Reembolso pendente")).toBeVisible();
  await expect(
    page.getByText("Cancelamos a renovação, mas o reembolso não foi concluído.")
  ).toBeVisible();
  await expect(
    page.getByText(
      "Nada será cobrado a mais. O prazo de desistência continua valendo até 30/10/2026, 23:59."
    )
  ).toBeVisible();

  await page.unrouteAll({ behavior: "ignoreErrors" });
  await openScreen(page, { plans: [{ ...pending, refund: null }] });
  await expect(page.getByText("Reembolso pendente")).toBeVisible();
  await expect(
    page.getByText(
      "Cancelamos a renovação. O reembolso está com o nosso suporte."
    )
  ).toBeVisible();
  await expect(
    page.getByText(
      "Nada será cobrado a mais. Você recebe um e-mail quando o reembolso for concluído."
    )
  ).toBeVisible();
  await expect(page.getByRole("button", { name: REFUND_WORD })).toHaveCount(0);
});

const FOOTER_SUPPLIER =
  "Polaris, um produto de Agência Summit, CNPJ 35.584.467/0001-00.";
const FOOTER_RULE =
  "Você pode desistir em até 7 dias depois da primeira cobrança e receber o valor de volta.";
const IN_WINDOW = {
  amount: "24.90",
  until: "2026-10-31T02:59:59.000Z",
  via: "app",
};
const WINDOW_ENDED = { ...ACTIVE, refundWindowEndedOn: "2026-10-17" };

for (const [label, value, text] of [
  ["Pro na janela", { ...ACTIVE, refund: IN_WINDOW }, FOOTER_RULE],
  [
    "Pix na janela, pelo suporte",
    {
      ...ACTIVE,
      method: "pix_automatic",
      refund: { ...IN_WINDOW, via: "suporte" },
    },
    FOOTER_RULE,
  ],
  [
    "Pro fora da janela",
    WINDOW_ENDED,
    "O reembolso integral vale nos primeiros 7 dias depois da primeira cobrança. Esse prazo terminou em 17/10/2026.",
  ],
  [
    "renovação cancelada com a janela vencida",
    {
      ...WINDOW_ENDED,
      nextCharge: null,
      renewalCancelled: true,
      resubscribeFrom: "2026-11-24T03:00:00.000Z",
    },
    "O reembolso integral vale nos primeiros 7 dias depois da primeira cobrança. Esse prazo terminou em 17/10/2026.",
  ],
  [
    "reembolso não concluído",
    {
      ...ACTIVE,
      nextCharge: null,
      refund: IN_WINDOW,
      refundPending: true,
      renewalCancelled: true,
    },
    null,
  ],
  ["carência", { ...GRACE, refundWindowEndedOn: "2026-10-17" }, null],
  ["Pro sem a data do servidor", ACTIVE, null],
] as const) {
  test(`rodapé, ${label}: a frase dos 7 dias só onde é verdadeira, o fornecedor e os Termos sempre (AS-14 Emenda 2, AS-30)`, async ({
    page,
  }) => {
    await openScreen(page, { plans: [value] });
    const footer = page.locator("main footer");
    await expect(footer.locator("p")).toHaveText(
      text === null ? [FOOTER_SUPPLIER] : [text, FOOTER_SUPPLIER]
    );
    if (text !== FOOTER_RULE) {
      await expect(page.locator("main")).not.toContainText(
        "Você pode desistir"
      );
    }
    // the Terms and the Privacy Policy stay the shell's in every state
    await expect(page.getByRole("link", { name: "Termos de Uso" })).toHaveCount(
      1
    );
    await expect(
      page.getByRole("link", { name: "Política de Privacidade" })
    ).toHaveCount(1);
  });
}

test("cartão: um clique duplo abre um checkout só, o botão espera desligado e leva à página do provedor (AS-15, AS-18)", async ({
  page,
}) => {
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const calls = await openScreen(page, {
    checkouts: [
      async (route) => {
        await held;
        await route.fulfill(
          rpc({ handoff: { kind: "redirect", url: CARD_PAGE } })
        );
      },
    ],
  });
  const start = page.getByRole("button", { name: "Começar os 7 dias grátis" });
  await start.dblclick();
  await expect(page.getByRole("button", { name: "Abrindo…" })).toBeDisabled();
  await expect.poll(() => calls.checkouts.length).toBe(1);
  expect(calls.checkouts[0]).toEqual({
    cycleMonths: 1,
    method: "card",
    organizationId: ORGANIZATION.id,
    trial: true,
  });
  release();
  await page.waitForURL(CARD_PAGE);
  expect(calls.checkouts).toHaveLength(1);
});

test("volta do cartão: 'Confirmando o pagamento…', relê a cada 5 s e mostra o teste quando o fato chega (AS-15)", async ({
  page,
}) => {
  const calls = await openScreen(page, {
    path: "/subscription?retorno=concluida",
    plans: [
      plan({ method: "card", state: "trial_setup" }),
      plan({
        accessEndsAt: "2026-10-31T03:00:00.000Z",
        cycleMonths: 1,
        method: "card",
        nextCharge: { amount: "24.90", on: "2026-10-30" },
        state: "trialing",
      }),
    ],
  });
  await expect(page.getByText("Confirmando o pagamento…")).toBeVisible();
  await expect(page.getByRole("radiogroup")).toHaveCount(0);
  // the confirmation comes above the plan's card, which keeps its title; no "Atualizar" while it reads by itself
  const confirming = await page
    .getByText("Confirmando o pagamento…")
    .boundingBox();
  const planCard = await planTitle(page).boundingBox();
  expect(confirming?.y).toBeLessThan(planCard?.y ?? 0);
  await expect(planTitle(page)).toHaveText("Falta autorizar o pagamento");
  await expect(page.getByRole("button", { name: "Atualizar" })).toHaveCount(0);
  await expect(planTitle(page)).toHaveText("Pro, em teste", {
    timeout: 12_000,
  });
  expect(calls.reads).toBe(2);
  await expect(page.getByText("Confirmando o pagamento…")).toHaveCount(0);
});

test("o fato que não chega em 2 minutos: a releitura para e a tela oferece 'Atualizar' (T-1)", async ({
  page,
}) => {
  await page.clock.install({ time: NOW });
  const calls = await openScreen(page, {
    path: "/subscription?retorno=concluida",
    plans: [plan({ method: "card", state: "trial_setup" })],
  });
  await expect(page.getByText("Confirmando o pagamento…")).toBeVisible();
  await page.clock.runFor(125_000);
  await expect(
    page.getByText(
      "Ainda não recebemos a confirmação. Ela pode demorar alguns minutos."
    )
  ).toBeVisible();
  const { reads } = calls;
  // read again while it waited (the fake clock runs the timers faster than the answers come)
  expect(reads).toBeGreaterThan(1);
  await page.clock.runFor(30_000);
  expect(calls.reads).toBe(reads);
  await page.getByRole("button", { name: "Atualizar" }).click();
  await expect.poll(() => calls.reads).toBe(reads + 1);
});

test("a volta 'concluida' numa loja que segue Free: depois dos 2 minutos a oferta volta (aba antiga ou favorito)", async ({
  page,
}) => {
  await page.clock.install({ time: NOW });
  const calls = await openScreen(page, {
    path: "/subscription?retorno=concluida",
  });
  await expect(page.getByText("Confirmando o pagamento…")).toBeVisible();
  await expect(page.getByRole("radiogroup")).toHaveCount(0);
  await page.clock.runFor(125_000);
  await expect(
    page.getByRole("button", { name: "Começar os 7 dias grátis" })
  ).toBeVisible();
  await expect(page.getByText("Confirmando o pagamento…")).toHaveCount(0);
  // the offer is not alone: the person may have paid, and is told not to pay twice
  const unconfirmed = page.getByText(
    "Ainda não recebemos a confirmação do pagamento. Se você concluiu na página do Asaas, não assine de novo: avisamos por e-mail quando confirmar. Se desistiu lá, pode começar de novo aqui."
  );
  await expect(unconfirmed).toBeVisible();
  const notice = await unconfirmed.boundingBox();
  const offer = await page
    .getByRole("radiogroup", { name: "Ciclo" })
    .boundingBox();
  expect(notice?.y).toBeLessThan(offer?.y ?? 0);
  const { reads } = calls;
  await page.clock.runFor(30_000);
  expect(calls.reads).toBe(reads);
});

test("depois do aviso da volta sem o fato, 'Escolher outra forma' depois do Pix devolve a oferta (não a confirmação)", async ({
  page,
}) => {
  await page.clock.install({ time: NOW });
  await openScreen(page, {
    checkouts: [
      (route) =>
        route.fulfill(
          rpc({
            handoff: {
              emv: PIX_CODE,
              kind: "pix_authorization",
              url: PIX_PAGE,
            },
          })
        ),
    ],
    path: "/subscription?retorno=concluida",
    plans: [plan()],
  });
  await expect(page.getByText("Confirmando o pagamento…")).toBeVisible();
  await page.clock.runFor(125_000);
  await page
    .getByRole("radiogroup", { name: "Como pagar" })
    .getByRole("radio", { name: PIX })
    .click();
  await page.getByLabel("CPF ou CNPJ").fill("529.982.247-25");
  await page.getByRole("button", { name: "Começar o teste grátis" }).click();
  await expect(page.getByLabel("Código Pix (copia e cola)")).toBeVisible();
  await page
    .getByRole("button", { name: "Escolher outra forma de pagamento" })
    .click();
  await expect(page.getByRole("radiogroup", { name: "Ciclo" })).toBeVisible();
  await expect(page.getByText("Confirmando o pagamento…")).toHaveCount(0);
});

test("volta do cartão cancelada ou expirada: nada foi cobrado e o teste continua disponível (AS-15, RN:6)", async ({
  page,
}) => {
  for (const back of ["cancelada", "expirada"]) {
    // biome-ignore lint/performance/noAwaitInLoops: one case after the other, on the same page
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await openScreen(page, { path: `/subscription?retorno=${back}` });
    await expect(
      page.getByText(
        "O pagamento não foi feito e nada foi cobrado. Seu teste grátis continua disponível."
      )
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Começar os 7 dias grátis" })
    ).toBeVisible();
  }
});

test("a volta antiga na raiz (/?assinatura=) leva à Assinatura com o mesmo retorno", async ({
  page,
}) => {
  await openScreen(page, { path: "/?assinatura=concluida" });
  await page.waitForURL("**/configuracoes?aba=assinatura&retorno=concluida");
  await expect(title(page)).toBeVisible();
});

test("Pix: documento inválido não sai; válido manda só os dígitos, mostra o código, a página e passa ao teste quando o banco aprova (AS-16)", async ({
  page,
}) => {
  const calls = await openScreen(page, {
    checkouts: [
      (route) =>
        route.fulfill(
          rpc({
            handoff: {
              emv: PIX_CODE,
              kind: "pix_authorization",
              url: PIX_PAGE,
            },
          })
        ),
    ],
    plans: [
      plan(),
      plan({ method: "pix_automatic", state: "trial_setup" }),
      plan({ method: "pix_automatic", state: "trial_setup" }),
      plan({
        accessEndsAt: "2026-10-31T03:00:00.000Z",
        cycleMonths: 1,
        method: "pix_automatic",
        nextCharge: { amount: "24.90", on: "2026-10-30" },
        state: "trialing",
      }),
    ],
  });
  await page
    .getByRole("radiogroup", { name: "Como pagar" })
    .getByRole("radio", { name: PIX })
    .click();
  await page.getByLabel("CPF ou CNPJ").fill("111.111.111-11");
  await page.getByRole("button", { name: "Começar o teste grátis" }).click();
  await expect(page.getByText("Informe um CPF ou CNPJ válido.")).toBeVisible();
  await expect(page.getByLabel("CPF ou CNPJ")).toBeFocused();
  // the error right under the field, the help after it
  const taxError = await page
    .getByText("Informe um CPF ou CNPJ válido.")
    .boundingBox();
  const taxHelp = await page
    .getByText("O banco pede o documento")
    .boundingBox();
  expect(taxError?.y).toBeLessThan(taxHelp?.y ?? 0);
  expect(calls.checkouts).toHaveLength(0);

  await page.getByLabel("CPF ou CNPJ").fill("529.982.247-25");
  await page.getByRole("button", { name: "Começar o teste grátis" }).click();
  await expect.poll(() => calls.checkouts.length).toBe(1);
  expect(calls.checkouts[0]).toEqual({
    cycleMonths: 1,
    method: "pix_automatic",
    organizationId: ORGANIZATION.id,
    payer: {
      email: "dona@exemplo.test",
      name: "Ana Dona",
      taxId: "52998224725",
    },
    trial: true,
  });
  await expect(
    page.getByText("Aguardando a aprovação no app do banco")
  ).toBeVisible();
  await expect(page.getByLabel("Código Pix (copia e cola)")).toHaveValue(
    PIX_CODE
  );
  await expect(
    page.getByRole("link", { name: "Abrir a página de pagamento" })
  ).toHaveAttribute("href", PIX_PAGE);
  await expect(
    page.getByText("gerar o código não inicia o teste")
  ).toBeVisible();
  await expect(planTitle(page)).toHaveText("Pro, em teste", {
    timeout: 20_000,
  });
  await expect(page.getByLabel("Código Pix (copia e cola)")).toHaveCount(0);
});

test("cada recusa do checkout tem texto próprio, e 'Atualizar' quando o plano pode ter mudado (AS-17)", async ({
  page,
}) => {
  const reasons: [string, number, Record<string, unknown>, string][] = [
    [
      "CONFLICT",
      409,
      { reason: "already_subscribed" },
      "Sua loja já tem o Pro.",
    ],
    [
      "CONFLICT",
      409,
      { reason: "checkout_in_progress" },
      "Outro pedido de assinatura com esse documento está em andamento.",
    ],
    [
      "CONFLICT",
      409,
      { reason: "checkout_pending_confirmation" },
      "Seu pagamento anterior ainda está sendo confirmado.",
    ],
    [
      "BAD_REQUEST",
      400,
      { reason: "cycle_not_offered" },
      "Esse ciclo não está mais disponível.",
    ],
    [
      "CONFLICT",
      409,
      { reason: "payer_not_accepted" },
      "Confira o nome, o CPF ou CNPJ e o e-mail",
    ],
    [
      "CONFLICT",
      409,
      { reason: "renewal_cancelled_until", until: "2026-11-24T03:00:00.000Z" },
      "Você cancelou a renovação. Dá para assinar de novo depois de 23/11/2026.",
    ],
    [
      "CONFLICT",
      409,
      { reason: "trial_already_used" },
      "Seu teste grátis já foi usado. Atualize para assinar sem o teste.",
    ],
    [
      "CONFLICT",
      409,
      { reason: "trial_in_progress" },
      "Seu teste grátis já está em andamento em outra loja.",
    ],
    [
      "SERVICE_UNAVAILABLE",
      503,
      { reason: "billing_provider_unavailable" },
      "O serviço de pagamento não respondeu. Nada foi cobrado.",
    ],
    [
      "SERVICE_UNAVAILABLE",
      503,
      { reason: "billing_not_configured" },
      "A assinatura pelo app não está disponível agora. Nada foi cobrado. Tente mais tarde.",
    ],
    [
      "CONFLICT",
      409,
      { reason: "command_in_progress" },
      "Já tem um pedido desta loja em andamento. Espere alguns segundos e tente de novo.",
    ],
    [
      "CONFLICT",
      409,
      { reason: "billing_command_rate_limited" },
      "Muitas tentativas seguidas. Espere um minuto e tente de novo.",
    ],
  ];
  let index = 0;
  await openScreen(page, {
    checkouts: [
      (route) => {
        const answer = reasons[index];
        return answer
          ? route.fulfill(refusal(answer[0], answer[1], answer[2]))
          : route.abort("internetdisconnected");
      },
    ],
  });
  const start = page.getByRole("button", { name: "Começar os 7 dias grátis" });
  const seen = new Set<string>();
  for (const [, , data, text] of reasons) {
    // biome-ignore lint/performance/noAwaitInLoops: one case after the other, on the same page
    await start.click();
    const alert = page.getByRole("alert");
    await expect(alert).toContainText(text);
    seen.add((await alert.textContent()) ?? "");
    const reread = [
      "already_subscribed",
      "checkout_pending_confirmation",
      "cycle_not_offered",
      "renewal_cancelled_until",
      "trial_already_used",
      "trial_in_progress",
    ].includes(String(data.reason));
    await expect(alert.getByRole("button", { name: "Atualizar" })).toHaveCount(
      reread ? 1 : 0
    );
    index += 1;
  }
  expect(seen.size).toBe(reasons.length);
});

test("sem conexão a tela diz 'Sem internet' e não mostra o plano de antes; com a volta, lê de novo (AS-8)", async ({
  page,
}) => {
  const calls = await openScreen(page, { plans: [ACTIVE] });
  await expect(planTitle(page)).toHaveText("Plano Pro");
  await page.context().setOffline(true);
  await expect(page.getByText("Sem internet.")).toBeVisible();
  // hidden, not taken away (what was typed in the offer stays): nothing of the plan is seen nor read
  await expect(planTitle(page)).toBeHidden();
  await expect(
    page.getByText("Próxima cobrança em 23/11/2026, R$ 24,90.")
  ).toBeHidden();
  const before = calls.reads;
  await page.context().setOffline(false);
  await expect(planTitle(page)).toHaveText("Plano Pro");
  await expect.poll(() => calls.reads).toBeGreaterThan(before);

  // in grace, the notice at the top goes with the plan: nothing of before on the Assinatura
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await openScreen(page, { plans: [GRACE] });
  await expect(page.locator("[data-grace-notice]")).toBeVisible();
  await page.context().setOffline(true);
  await expect(page.getByText("Sem internet.")).toBeVisible();
  await expect(page.locator("[data-grace-notice]")).toHaveCount(0);
  await expect(planTitle(page)).toBeHidden();
});

test("sem conexão, o que foi digitado na oferta fica; com a volta, está lá", async ({
  page,
}) => {
  await openScreen(page);
  await page
    .getByRole("radiogroup", { name: "Como pagar" })
    .getByRole("radio", { name: PIX })
    .click();
  await page.getByLabel("CPF ou CNPJ").fill("529.982.247-25");
  await page.context().setOffline(true);
  await expect(page.getByText("Sem internet.")).toBeVisible();
  await expect(
    page.getByText(
      "Esta tela precisa de conexão. O que você digitou fica aqui enquanto esta página estiver aberta."
    )
  ).toBeVisible();
  await expect(page.getByLabel("CPF ou CNPJ")).toBeHidden();
  await page.context().setOffline(false);
  await expect(page.getByLabel("CPF ou CNPJ")).toHaveValue("529.982.247-25");
});

test("a leitura que falha diz o motivo e oferece 'Tentar novamente'; sem a capacidade, nem pede", async ({
  page,
}) => {
  const calls = await openScreen(page, {
    plans: [
      (route) =>
        route.fulfill(refusal("INTERNAL_SERVER_ERROR", 500, undefined)),
      plan(),
    ],
  });
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("Não foi possível carregar a assinatura.");
  await expect(alert).toContainText(
    "O servidor não respondeu. Nada mudou no seu plano."
  );
  await alert.getByRole("button", { name: "Tentar novamente" }).click();
  await expect(planTitle(page)).toHaveText("Plano Free");
  expect(calls.reads).toBe(2);

  await page.unrouteAll({ behavior: "ignoreErrors" });
  const other = await openScreen(page, { role: "cashier" });
  await expect(
    page.getByText("Só o dono da loja pode ver e mudar a assinatura.")
  ).toBeVisible();
  await expect(page.getByRole("button")).not.toContainText(["Começar"]);
  expect(other.reads).toBe(0);
});

test("menu: 'Assinatura' é aba de Configurações, no desktop e no celular; some sem a flag e para quem não é dono (AS-10, AS-19)", async ({
  page,
}) => {
  await page.setViewportSize({ height: 800, width: 1280 });
  await openScreen(page, { path: "/subscription", plans: [plan()] });
  const nav = page.getByRole("navigation", { name: "Principal" });
  // the old address opens the tab; the menu marks Configurações (map of navigation, § 1 and § 6)
  await page.waitForURL("**/configuracoes?aba=assinatura");
  await expect(
    nav.getByRole("link", { exact: true, name: "Configurações" })
  ).toHaveAttribute("aria-current", "page");
  await expect(nav.getByRole("link", { name: "Assinatura" })).toHaveCount(0);
  const tabs = page.getByRole("tablist", { name: "Configurações" });
  await expect(
    tabs.getByRole("tab", { exact: true, name: "Assinatura" })
  ).toHaveAttribute("aria-selected", "true");
  await expect(title(page)).toBeVisible();

  await page.setViewportSize({ height: 740, width: 360 });
  await page.goto("/");
  // "Mais", then Configurações, then the tab
  await page.getByRole("button", { name: "Mais" }).click();
  await page.getByRole("link", { name: "Configurações" }).click();
  await page.waitForURL("**/configuracoes");
  await tabs.getByRole("tab", { exact: true, name: "Assinatura" }).click();
  await expect(title(page)).toBeVisible();

  for (const options of [
    { billingSelfService: false },
    { role: "cashier" },
  ] satisfies ScreenOptions[]) {
    // biome-ignore lint/performance/noAwaitInLoops: one case after the other, on the same page
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await page.setViewportSize({ height: 800, width: 1280 });
    await openScreen(page, { ...options, path: "/configuracoes" });
    await expect(
      tabs.getByRole("tab", { exact: true, name: "Catálogo público" })
    ).toBeVisible();
    await expect(
      tabs.getByRole("tab", { exact: true, name: "Assinatura" })
    ).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Assinatura" })).toHaveCount(0);
  }
});

test("carência: o aviso do topo em toda tela do dono, com os dias contados e o caminho à Assinatura (AS-35)", async ({
  page,
}) => {
  const days: [string, string][] = [
    ["2026-10-23T15:00:00.000Z", "(7 dias)"],
    ["2026-10-29T15:00:00.000Z", "(1 dia)"],
    ["2026-10-30T22:00:00.000Z", "(último dia)"],
  ];
  for (const [now, left] of days) {
    // biome-ignore lint/performance/noAwaitInLoops: one case after the other, on the same page
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await page.clock.setFixedTime(new Date(now));
    await page.evaluate(() => sessionStorage.clear()).catch(() => undefined);
    await openScreen(page, { path: "/expenses", plans: [GRACE] });
    const notice = page.locator("[data-grace-notice]");
    await expect(notice).toContainText(
      "O último pagamento não foi confirmado."
    );
    await expect(notice).toContainText(
      `Seu Pro vai até 30/10/2026 ${left}; depois a loja volta ao Free e seus dados ficam.`
    );
    await expect(
      notice.getByRole("link", { name: "Abrir Assinatura" })
    ).toHaveAttribute("href", "/configuracoes?aba=assinatura");
  }
  // day 8: the server says Free, and there is no notice
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await page.evaluate(() => sessionStorage.clear());
  await openScreen(page, { path: "/expenses", plans: [plan()] });
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.locator("[data-grace-notice]")).toHaveCount(0);

  // on the Assinatura itself, the notice has no link to itself
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await page.evaluate(() => sessionStorage.clear());
  await page.clock.setFixedTime(NOW);
  await openScreen(page, { plans: [GRACE] });
  await expect(page.locator("[data-grace-notice]")).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Abrir Assinatura" })
  ).toHaveCount(0);
});

test("carência: a leitura que falha é tentada de novo cada vez mais devagar, não a cada minuto", async ({
  page,
}) => {
  await page.clock.install({ time: NOW });
  const calls = await openScreen(page, {
    path: "/expenses",
    plans: [
      (route) => route.fulfill(refusal("INTERNAL_SERVER_ERROR", 500, {})),
    ],
  });
  await expect.poll(() => calls.reads).toBe(1);
  for (let minute = 0; minute < 12; minute += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: the minutes pass one after the other
    await page.clock.runFor(60_000);
  }
  // each wait doubles from the minute that started the read: reads at minutes 0, 1, 3 and 7 (one per minute would be 13)
  expect(calls.reads).toBe(4);
  await expect(page.locator("[data-grace-notice]")).toHaveCount(0);
});

test("o aviso de carência não aparece para quem não é dono nem com a flag desligada", async ({
  page,
}) => {
  for (const options of [
    { billingSelfService: false },
    { role: "cashier" },
  ] satisfies ScreenOptions[]) {
    // biome-ignore lint/performance/noAwaitInLoops: one case after the other, on the same page
    await page.unrouteAll({ behavior: "ignoreErrors" });
    const calls = await openScreen(page, {
      ...options,
      path: "/expenses",
      plans: [GRACE],
    });
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.locator("[data-grace-notice]")).toHaveCount(0);
    expect(calls.reads).toBe(0);
  }
});
