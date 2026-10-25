/// <reference lib="dom" />
import type { Page, Route } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { serveHealth, WORKER_MARK } from "./worker-mark";

/**
 * The owner's commands on the Assinatura (corte assinatura-e-cancelar, AC-21 to AC-34 and AC-42 to AC-44; design
 * t268 v2, § 4 and § 11) in the real route, with the API answered by the test: cancel the renewal (2 taps, the true
 * loss, what stays, the optional reason, the result), the refund by the app with the card, by support with Pix, the
 * refund not done (AS-42), the edges of the window on the clock, paying the charge that failed (exact host,
 * `noopener`) and each refusal of the commands with its own text.
 */
const ORGANIZATION = {
  id: "0199c2d0-0000-7000-8000-00000000a001",
  name: "Loja do teste",
  role: "owner",
  timezone: "America/Sao_Paulo",
};
const SESSION_USER = { email: "dona@exemplo.test", id: "u", name: "Ana Dona" };
/** Asaas's page of the charge that failed: the test answers it, so nothing leaves the machine. */
const OVERDUE_PAGE = "https://sandbox.asaas.com/i/e2e-overdue";
/** 23/10/2026 at noon in São Paulo. */
const NOW = new Date("2026-10-23T15:00:00.000Z");
/** The last second of a window whose first charge was on 23/10/2026: 23:59:59 of 30/10 in São Paulo. */
const UNTIL = "2026-10-31T02:59:59.999Z";
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CANCEL_BUTTON = { exact: true, name: "Cancelar a renovação" };
const REFUND_BUTTON = { exact: true, name: "Desistir e receber o reembolso" };
const CANCEL_PRO_BUTTON = { exact: true, name: "Cancelar o Pro" };
const KEEP_BUTTON = { exact: true, name: "Continuar no Pro" };
const PAY_BUTTON = { name: "Pagar a cobrança pendente" };
const ANY_REFUND_BUTTON = /reembolso/i;
const SUBSCRIBE_ACTION = /Assinar|Começar/;

const rpc = (json: unknown, status = 200) => ({
  body: JSON.stringify({ json, meta: [] }),
  contentType: "application/json",
  headers: { ...WORKER_MARK },
  status,
});
const refusal = (code: string, status: number, reason: string) =>
  rpc(
    { code, data: { reason }, defined: false, message: reason, status },
    status
  );

type Plan = Record<string, unknown>;

const ACTIVE: Plan = {
  accessEndsAt: "2026-11-24T03:00:00.000Z",
  cycleMonths: 1,
  kept: { historyMonths: 3, products: 18, sales: 47 },
  limits: { goals: 3, images: 5000, variants: 2000 },
  method: "card",
  nextCharge: { amount: "24.90", on: "2026-11-23" },
  offer: {
    methods: ["card", "pix_automatic"],
    prices: [
      { amount: "24.90", cycleMonths: 1 },
      { amount: "249.00", cycleMonths: 12 },
    ],
  },
  recovery: null,
  refund: null,
  refundPending: false,
  refundWindowEndedOn: null,
  renewalCancelled: false,
  resubscribeFrom: null,
  state: "active",
  trialAvailable: false,
  usage: { goals: 1, images: 12, variants: 38 },
};
const IN_WINDOW: Plan = {
  ...ACTIVE,
  refund: { amount: "24.90", until: UNTIL, via: "app" },
};
const CANCELLED: Plan = {
  ...ACTIVE,
  nextCharge: null,
  renewalCancelled: true,
  resubscribeFrom: "2026-11-24T03:00:00.000Z",
};
const FREE_AFTER_REFUND: Plan = {
  ...ACTIVE,
  accessEndsAt: null,
  cycleMonths: null,
  limits: { goals: 1, images: 50, variants: 50 },
  method: null,
  nextCharge: null,
  state: "free",
};
const GRACE: Plan = {
  ...ACTIVE,
  accessEndsAt: "2026-10-31T03:00:00.000Z",
  nextCharge: null,
  recovery: "provider_page",
  state: "grace",
};

type Answer = Plan | ((route: Route) => Promise<void>);
type Procedure = "cancelRenewal" | "openOverduePayment" | "requestRefund";

interface ScreenOptions {
  /** What each command answers, in order; the last one repeats. */
  commands?: Partial<Record<Procedure, readonly Answer[]>>;
  /** What `billing/readPlan` answers, in order; the last one repeats. */
  plans?: readonly Plan[];
}

interface Calls {
  bodies: Record<Procedure, Record<string, unknown>[]>;
  reads: number;
}

async function openScreen(
  page: Page,
  { commands = {}, plans = [ACTIVE] }: ScreenOptions = {}
): Promise<Calls> {
  const calls: Calls = {
    bodies: { cancelRenewal: [], openOverduePayment: [], requestRefund: [] },
    reads: 0,
  };
  await page.route("**/api/auth/get-session", (route) =>
    route.fulfill({
      body: JSON.stringify({ session: { id: "s" }, user: SESSION_USER }),
      contentType: "application/json",
      headers: { ...WORKER_MARK },
    })
  );
  await serveHealth(page);
  await page.context().route("https://sandbox.asaas.com/**", (route) =>
    route.fulfill({
      body: "<!doctype html><title>Asaas</title><p>Fatura</p>",
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
        rpc({ billingSelfService: true, organizations: [ORGANIZATION] })
      );
    }
    if (procedure === "billing/readPlan") {
      const answer = plans[Math.min(calls.reads, plans.length - 1)];
      calls.reads += 1;
      return route.fulfill(rpc(answer));
    }
    const name = procedure.replace("billing/", "") as Procedure;
    const answers = commands[name];
    if (answers) {
      const { json } = route.request().postDataJSON() as {
        json: Record<string, unknown>;
      };
      calls.bodies[name].push(json);
      const answer =
        answers[Math.min(calls.bodies[name].length - 1, answers.length - 1)];
      return typeof answer === "function"
        ? answer(route)
        : route.fulfill(rpc(answer));
    }
    return route.abort("internetdisconnected");
  });
  await page.goto("/subscription");
  return calls;
}

/** The body of the n-th call of a command (the test fails when there was none). */
function nth(bodies: Record<string, unknown>[], index: number) {
  const body = bodies[index];
  if (body === undefined) {
    throw new Error(`no call ${index}`);
  }
  return body;
}

const planTitle = (page: Page) => page.locator("#subscription-plan-title");

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(NOW);
});

test("cancelar a renovação: 2 toques, a perda verdadeira, o que fica, o motivo opcional e o resultado (AS-21 a AS-24, AS-27, AS-29)", async ({
  page,
}) => {
  const calls = await openScreen(page, {
    commands: {
      cancelRenewal: [
        { accessEndsAt: "2026-11-24T03:00:00.000Z", result: "cancelled" },
      ],
    },
    plans: [ACTIVE, CANCELLED],
  });
  await expect(planTitle(page)).toHaveText("Plano Pro");
  await expect(
    page.getByText("Seu Pro continua até o fim do que você já pagou.")
  ).toBeVisible();
  // tap 1
  await page.getByRole("button", CANCEL_BUTTON).click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("heading", { name: "Cancelar a renovação do Pro?" })
  ).toBeVisible();
  await expect(dialog).toContainText(
    "Seu Pro continua até 23/11/2026, o fim do que você já pagou. Depois dessa data a loja volta ao plano Free."
  );
  for (const line of [
    "O catálogo público sai do ar.",
    "A escrita sem internet desliga.",
    "Metas acima do limite do Free ficam pausadas. As mais antigas continuam.",
    "Variantes acima do limite do Free só recebem vendas e entradas nas que você escolher.",
    "Imagens acima do limite ficam guardadas. Só não entram novas.",
    "47 vendas, 18 produtos e 3 meses de histórico. Seus dados não são apagados.",
  ]) {
    // biome-ignore lint/performance/noAwaitInLoops: one line after the other, in the same dialog
    await expect(dialog.getByText(line, { exact: true })).toBeVisible();
  }
  const reason = dialog.getByLabel("Por que está cancelando? (opcional)");
  await expect(reason).toHaveAccessibleDescription(
    "Não escreva dados pessoais. O motivo fica guardado sem o nome da loja."
  );
  await expect(reason).toHaveAttribute("maxlength", "500");
  await reason.fill("  ficou caro  ");
  // the button that cancels is the main one; "Continuar no Pro" is there too, never in its place
  await expect(dialog.getByRole("button", KEEP_BUTTON)).toBeVisible();
  // tap 2
  await dialog.getByRole("button", CANCEL_BUTTON).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByText(
      "Renovação cancelada. Seu Pro continua até 23/11/2026 e nada mais é cobrado."
    )
  ).toBeVisible();
  await expect(planTitle(page)).toHaveText("Pro até 23/11/2026");
  await expect(
    page.getByText("Renovação cancelada", { exact: true })
  ).toBeVisible();
  await expect(page.getByRole("button", CANCEL_BUTTON)).toHaveCount(0);
  // no "Assinar" before the end (AS-27)
  await expect(
    page.getByRole("button", { name: SUBSCRIBE_ACTION })
  ).toHaveCount(0);
  expect(calls.bodies.cancelRenewal).toHaveLength(1);
  const body = nth(calls.bodies.cancelRenewal, 0);
  expect(body.organizationId).toBe(ORGANIZATION.id);
  expect(body.reason).toBe("ficou caro");
  expect(String(body.requestId)).toMatch(UUID);
});

test("cancelar: 'Continuar no Pro' fecha sem pedir nada, e o motivo vazio não vai", async ({
  page,
}) => {
  const calls = await openScreen(page, {
    commands: {
      cancelRenewal: [
        {
          accessEndsAt: "2026-11-24T03:00:00.000Z",
          result: "already_cancelled",
        },
      ],
    },
    plans: [ACTIVE, CANCELLED],
  });
  await page.getByRole("button", CANCEL_BUTTON).click();
  await page.getByRole("dialog").getByRole("button", KEEP_BUTTON).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(calls.bodies.cancelRenewal).toHaveLength(0);

  await page.getByRole("button", CANCEL_BUTTON).click();
  await page.getByRole("dialog").getByRole("button", CANCEL_BUTTON).click();
  await expect(
    page.getByText(
      "A renovação já estava cancelada. Seu Pro continua até 23/11/2026 e nada mais é cobrado."
    )
  ).toBeVisible();
  expect(calls.bodies.cancelRenewal).toHaveLength(1);
  expect(nth(calls.bodies.cancelRenewal, 0)).not.toHaveProperty("reason");
});

test("cancelar no teste: vai até o fim, nada é cobrado e não há outro teste (AS-25)", async ({
  page,
}) => {
  await openScreen(page, {
    plans: [
      {
        ...ACTIVE,
        accessEndsAt: "2026-10-31T03:00:00.000Z",
        nextCharge: { amount: "24.90", on: "2026-10-30" },
        state: "trialing",
      },
    ],
  });
  await expect(
    page.getByText(
      "O teste vai até o fim e nada é cobrado. Você não terá outro teste grátis."
    )
  ).toBeVisible();
  await page.getByRole("button", CANCEL_BUTTON).click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("heading", { name: "Cancelar o Pro em teste?" })
  ).toBeVisible();
  await expect(dialog).toContainText(
    "O teste vai até o fim e nada é cobrado. Você não terá outro teste grátis. Depois a loja volta ao plano Free."
  );
  // the title asks to cancel the Pro: the button says the same
  await expect(dialog.getByRole("button", CANCEL_PRO_BUTTON)).toBeVisible();
  await expect(dialog.getByRole("button", CANCEL_BUTTON)).toHaveCount(0);
});

test("cancelar com o provedor fora: o texto do AS-26, nada muda, e repetir manda o mesmo pedido; clique duplo, um pedido só", async ({
  page,
}) => {
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const calls = await openScreen(page, {
    commands: {
      cancelRenewal: [
        (route) =>
          route.fulfill(
            refusal("SERVICE_UNAVAILABLE", 503, "billing_provider_unavailable")
          ),
        async (route) => {
          await held;
          await route.fulfill(
            rpc({
              accessEndsAt: "2026-11-24T03:00:00.000Z",
              result: "cancelled",
            })
          );
        },
      ],
    },
    plans: [ACTIVE, CANCELLED],
  });
  await page.getByRole("button", CANCEL_BUTTON).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", CANCEL_BUTTON).click();
  await expect(dialog.getByRole("alert")).toHaveText(
    "Não conseguimos cancelar agora. Nada foi cancelado e nada foi cobrado a mais. Tente de novo."
  );
  // the notice takes the focus, so it comes into view inside the dialog at 360 px
  await expect(dialog.getByRole("alert")).toBeFocused();
  await expect(planTitle(page)).toHaveText("Plano Pro");
  // the same gesture again: the button waits off, and a double click sends one request
  await dialog.getByRole("button", CANCEL_BUTTON).dblclick();
  await expect(
    dialog.getByRole("button", { name: "Cancelando…" })
  ).toHaveAttribute("aria-disabled", "true");
  release();
  await expect(planTitle(page)).toHaveText("Pro até 23/11/2026");
  expect(calls.bodies.cancelRenewal).toHaveLength(2);
  expect(nth(calls.bodies.cancelRenewal, 1).requestId).toBe(
    nth(calls.bodies.cancelRenewal, 0).requestId
  );
});

test("cada recusa dos comandos tem texto próprio: trava, limite, confirmação perdida e o plano que mudou (AS-17)", async ({
  page,
}) => {
  const calls = await openScreen(page, {
    commands: {
      cancelRenewal: [
        (route) =>
          route.fulfill(refusal("CONFLICT", 409, "command_in_progress")),
        (route) =>
          route.fulfill(
            refusal("CONFLICT", 409, "billing_command_rate_limited")
          ),
        (route) =>
          route.fulfill(
            refusal("SERVICE_UNAVAILABLE", 503, "billing_audit_unavailable")
          ),
        (route) => route.fulfill(refusal("CONFLICT", 409, "nothing_to_cancel")),
      ],
    },
    plans: [ACTIVE, CANCELLED],
  });
  await page.getByRole("button", CANCEL_BUTTON).click();
  const dialog = page.getByRole("dialog");
  const alert = dialog.getByRole("alert");
  await dialog.getByRole("button", CANCEL_BUTTON).click();
  await expect(alert).toHaveText(
    "Já tem um pedido em andamento. Espere alguns segundos e tente de novo."
  );
  await dialog.getByRole("button", CANCEL_BUTTON).click();
  await expect(alert).toHaveText(
    "Muitas tentativas seguidas. Espere um pouco e tente de novo."
  );
  await dialog.getByRole("button", CANCEL_BUTTON).click();
  await expect(alert).toHaveText(
    "Não conseguimos confirmar o pedido. Tente de novo: ele não é feito duas vezes."
  );
  await dialog.getByRole("button", CANCEL_BUTTON).click();
  await expect(alert).toContainText(
    "Não há renovação para cancelar. Atualize para ver o plano."
  );
  // the four tries are the same gesture: one request ID
  expect(
    new Set(calls.bodies.cancelRenewal.map((body) => body.requestId)).size
  ).toBe(1);
  await alert.getByRole("button", { name: "Atualizar" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(planTitle(page)).toHaveText("Pro até 23/11/2026");
});

test("desistir pelo app no dia 6: o botão, o aviso com o valor e o efeito, o pedido e a confirmação que chega depois (AS-30, AS-31, AS-34)", async ({
  page,
}) => {
  // with the card, the provider's fact comes by webhook: until then the plan reads as a refund not done
  const requested: Plan = {
    ...IN_WINDOW,
    nextCharge: null,
    refundPending: true,
    renewalCancelled: true,
  };
  const calls = await openScreen(page, {
    commands: {
      requestRefund: [
        { amount: "24.90", result: "refund_requested", until: UNTIL },
      ],
    },
    plans: [IN_WINDOW, requested, FREE_AFTER_REFUND],
  });
  await expect(
    page.getByText(
      "Vale até 30/10/2026, 23:59. Devolvemos R$ 24,90 e o Pro termina na hora."
    )
  ).toBeVisible();
  await page.getByRole("button", REFUND_BUTTON).click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("heading", {
      name: "Desistir do Pro e receber o reembolso?",
    })
  ).toBeVisible();
  await expect(dialog).toContainText(
    "Você recebe R$ 24,90 de volta e o Pro acaba agora. Seus dados ficam."
  );
  await expect(dialog).toContainText("O que muda no Free");
  await dialog.getByRole("button", REFUND_BUTTON).click();
  const outcome = page.getByText(
    "Pedimos o reembolso de R$ 24,90. Quando ele for confirmado, o Pro acaba e a loja volta ao Free. Seus dados ficam."
  );
  await expect(outcome).toBeVisible();
  await expect(outcome.locator("xpath=..")).toBeFocused();
  // the refund taken is not said as not done, and is not offered again
  await expect(page.locator("main")).not.toContainText(
    "o reembolso não foi concluído"
  );
  await expect(
    page.getByRole("button", { name: "Tentar o reembolso de novo" })
  ).toHaveCount(0);
  // read again every 5 s until the fact comes
  await expect(planTitle(page)).toHaveText("Plano Free", { timeout: 10_000 });
  await expect(
    page.getByText(
      "Reembolso confirmado: você recebe R$ 24,90 de volta e o Pro acabou. Seus dados ficam."
    )
  ).toBeVisible();
  // after a refund done, "Assinar" again, with no date to wait for (AS-27 amendment)
  await expect(
    page.getByRole("button", { name: "Assinar o Pro" })
  ).toBeVisible();
  await expect(page.getByText("Dá para assinar de novo")).toHaveCount(0);
  expect(calls.bodies.requestRefund).toHaveLength(1);
  expect(String(nth(calls.bodies.requestRefund, 0).requestId)).toMatch(UUID);
});

test("o diálogo do reembolso aberto quando a janela fecha fica, e diz a recusa do servidor (AS-33)", async ({
  page,
}) => {
  await page.clock.install({ time: new Date("2026-10-31T02:59:30.000Z") });
  await openScreen(page, {
    commands: {
      requestRefund: [
        (route) => route.fulfill(refusal("CONFLICT", 409, "nothing_to_refund")),
      ],
    },
    plans: [IN_WINDOW, { ...ACTIVE, refundWindowEndedOn: "2026-10-30" }],
  });
  await page.getByRole("button", REFUND_BUTTON).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await page.clock.fastForward("01:01");
  await expect(page.locator("main footer")).toContainText(
    "Esse prazo terminou em 30/10/2026."
  );
  await dialog.getByRole("button", REFUND_BUTTON).click();
  await expect(dialog.getByRole("alert")).toContainText(
    "Não há valor a reembolsar: o prazo de 7 dias terminou ou o reembolso já foi feito. Atualize para ver o plano."
  );
  // the refund dialog's notice takes the focus too
  await expect(dialog.getByRole("alert")).toBeFocused();
});

test("reembolso não concluído: o texto do AS-42, 'Tentar o reembolso de novo' com outro pedido, e nunca 'Nada foi cancelado'", async ({
  page,
}) => {
  const pending: Plan = {
    ...IN_WINDOW,
    nextCharge: null,
    refundPending: true,
    renewalCancelled: true,
  };
  const calls = await openScreen(page, {
    commands: {
      requestRefund: [
        { amount: "24.90", result: "refund_pending", until: UNTIL },
        { amount: "24.90", result: "refund_requested", until: UNTIL },
      ],
    },
    plans: [IN_WINDOW, pending, FREE_AFTER_REFUND],
  });
  await page.getByRole("button", REFUND_BUTTON).click();
  await page.getByRole("dialog").getByRole("button", REFUND_BUTTON).click();
  await expect(page.getByText("Reembolso pendente")).toBeVisible();
  await expect(
    page.getByText("Cancelamos a renovação, mas o reembolso não foi concluído.")
  ).toBeVisible();
  await expect(
    page.getByText(
      "Nada será cobrado a mais. O prazo de desistência continua valendo até 30/10/2026, 23:59."
    )
  ).toBeVisible();
  await expect(page.locator("main")).not.toContainText("Nada foi cancelado");
  // "Desistir" is offered again only as the retry of the notice
  await expect(page.getByRole("button", REFUND_BUTTON)).toHaveCount(0);
  await page
    .getByRole("button", { name: "Tentar o reembolso de novo" })
    .click();
  await page.getByRole("dialog").getByRole("button", REFUND_BUTTON).click();
  await expect(planTitle(page)).toHaveText("Plano Free");
  expect(calls.bodies.requestRefund).toHaveLength(2);
  expect(nth(calls.bodies.requestRefund, 1).requestId).not.toBe(
    nth(calls.bodies.requestRefund, 0).requestId
  );
});

test("Pix na janela: sem botão, o caminho do suporte com a data, o que vale e sem dado pessoal (AS-30, AS-44)", async ({
  page,
}) => {
  await openScreen(page, {
    plans: [
      {
        ...ACTIVE,
        method: "pix_automatic",
        refund: { amount: "24.90", until: UNTIL, via: "suporte" },
      },
    ],
  });
  await expect(
    page.getByText(
      "Para desistir e receber o reembolso de R$ 24,90, escreva para o suporte do Polaris (o endereço está no fim dos e-mails da sua assinatura) até 30/10/2026, 23:59 com o nome da loja. O pedido enviado até essa data vale, mesmo que a resposta chegue depois. Não mande CPF, CNPJ nem dados de pagamento."
    )
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: ANY_REFUND_BUTTON })
  ).toHaveCount(0);
  await expect(page.getByRole("button", CANCEL_BUTTON)).toBeVisible();
});

test("Pix: a recusa 'refund_via_support' de uma aba antiga diz o caminho e oferece 'Atualizar'", async ({
  page,
}) => {
  await openScreen(page, {
    commands: {
      requestRefund: [
        (route) =>
          route.fulfill(refusal("CONFLICT", 409, "refund_via_support")),
      ],
    },
    plans: [IN_WINDOW],
  });
  await page.getByRole("button", REFUND_BUTTON).click();
  const alert = page.getByRole("dialog").getByRole("alert");
  await page.getByRole("dialog").getByRole("button", REFUND_BUTTON).click();
  await expect(alert).toContainText(
    "O reembolso do Pix Automático é pedido ao suporte. Atualize para ver como pedir."
  );
  await expect(alert.getByRole("button", { name: "Atualizar" })).toBeVisible();
});

test("relógio nas bordas da janela: às 23:59:59 do 7º dia o botão está; às 00:00:00 do 8º sai e a tela relê o plano (AS-30)", async ({
  page,
}) => {
  await page.clock.install({ time: new Date("2026-10-31T02:59:00.000Z") });
  const calls = await openScreen(page, {
    plans: [IN_WINDOW, { ...ACTIVE, refundWindowEndedOn: "2026-10-30" }],
  });
  await expect(page.getByRole("button", REFUND_BUTTON)).toBeVisible();
  await page.clock.fastForward("00:59");
  // 23:59:59 of 30/10 in São Paulo: still the last second of the window
  await expect(page.getByRole("button", REFUND_BUTTON)).toBeVisible();
  await page.clock.fastForward("00:02");
  // 00:00:01 of 31/10: the server's `until` has passed, and the plan read again has no refund (no clock of the
  // client hides the button: the server's answer does)
  await expect(page.getByRole("button", REFUND_BUTTON)).toHaveCount(0);
  await expect.poll(() => calls.reads).toBeGreaterThanOrEqual(2);
  await expect(page.locator("main footer")).toContainText(
    "Esse prazo terminou em 30/10/2026."
  );
});

test("relógio no dia 8: o servidor fecha a janela, sem botão e com a data em que terminou (AS-30)", async ({
  page,
}) => {
  await page.clock.setFixedTime(new Date("2026-10-31T03:00:00.000Z"));
  await openScreen(page, {
    plans: [{ ...ACTIVE, refundWindowEndedOn: "2026-10-30" }],
  });
  await expect(planTitle(page)).toHaveText("Plano Pro");
  await expect(
    page.getByRole("button", { name: ANY_REFUND_BUTTON })
  ).toHaveCount(0);
  await expect(page.locator("main footer")).toContainText(
    "O reembolso integral vale nos primeiros 7 dias depois da primeira cobrança. Esse prazo terminou em 30/10/2026."
  );
});

test("pagar a cobrança pendente: o texto do AS-43 antes e na volta, a página do Asaas em outra aba com noopener", async ({
  page,
}) => {
  const calls = await openScreen(page, {
    commands: {
      openOverduePayment: [
        { handoff: { kind: "redirect", url: OVERDUE_PAGE } },
      ],
    },
    plans: [GRACE],
  });
  const text =
    "Isto paga a cobrança que falhou. A próxima renovação ainda tenta o cartão cadastrado. Para usar outro cartão, cancele a renovação e assine de novo depois de 30/10/2026.";
  await expect(page.getByText(text)).toBeVisible();
  const popup = page.waitForEvent("popup");
  await page.getByRole("button", PAY_BUTTON).click();
  const opened = await popup;
  await expect(opened).toHaveURL(OVERDUE_PAGE);
  // `noopener`: the provider's page has no way back to this one
  expect(await opened.evaluate(() => window.opener)).toBeNull();
  await opened.close();
  // on the way back the same text, and the link for a page the browser did not open
  await expect(page.getByText(text)).toBeVisible();
  await expect(
    page.getByRole("link", { name: "abra a página de pagamento" })
  ).toHaveAttribute("rel", "noopener noreferrer");
  expect(calls.bodies.openOverduePayment).toHaveLength(1);
  expect(String(nth(calls.bodies.openOverduePayment, 0).requestId)).toMatch(
    UUID
  );
});

test("pagar a cobrança pendente: um endereço fora dos hosts exatos do Asaas não abre; sem a página, sem botão (AS-43)", async ({
  page,
}) => {
  // every call of `window.open`, counted in the page: the popup event of the browser could come late
  await page.addInitScript(() => {
    const opened: unknown[] = [];
    (window as unknown as { opened: unknown[] }).opened = opened;
    const open = window.open.bind(window);
    window.open = (...args: Parameters<typeof window.open>) => {
      opened.push(args[0]);
      return open(...args);
    };
  });
  await openScreen(page, {
    commands: {
      openOverduePayment: [
        {
          handoff: { kind: "redirect", url: "https://asaas.com.evil.test/i/x" },
        },
        { handoff: { kind: "redirect", url: OVERDUE_PAGE } },
      ],
    },
    plans: [GRACE],
  });
  const opened = () =>
    page.evaluate(() => (window as unknown as { opened: unknown[] }).opened);
  await page.getByRole("button", PAY_BUTTON).click();
  await expect(page.getByRole("alert")).toHaveText(
    "Não conseguimos abrir a página de pagamento agora. Nada foi cobrado. Tente de novo em alguns minutos."
  );
  await expect(
    page.getByRole("link", { name: "abra a página de pagamento" })
  ).toHaveCount(0);
  expect(await opened()).toEqual([]);
  // the control: the same screen opens an address on the exact host
  await page.getByRole("button", PAY_BUTTON).click();
  await expect.poll(opened).toEqual([OVERDUE_PAGE]);

  await page.unrouteAll({ behavior: "ignoreErrors" });
  await openScreen(page, {
    plans: [{ ...GRACE, method: "pix_automatic", recovery: null }],
  });
  await expect(planTitle(page)).toHaveText("Pagamento não confirmado");
  await expect(page.getByRole("button", PAY_BUTTON)).toHaveCount(0);
  await expect(page.locator("main")).not.toContainText("nova tentativa");
  // in grace the renewal may be cancelled too (AS-28)
  await expect(page.getByRole("button", CANCEL_BUTTON)).toBeVisible();
});

test("carência com a renovação já cancelada: sem o botão de pagar, o cartão diz que a cobrança não será paga e até quando vai o Pro (AS-43)", async ({
  page,
}) => {
  await openScreen(page, {
    plans: [
      {
        ...GRACE,
        renewalCancelled: true,
        resubscribeFrom: "2026-10-31T03:00:00.000Z",
      },
    ],
  });
  await expect(page.getByRole("button", PAY_BUTTON)).toHaveCount(0);
  await expect(page.getByRole("button", CANCEL_BUTTON)).toHaveCount(0);
  await expect(
    page.getByText(
      "Renovação cancelada. A cobrança pendente não será paga. Seu Pro continua até 30/10/2026; depois a loja volta ao Free e seus dados ficam. Dá para assinar de novo depois de 30/10/2026."
    )
  ).toBeVisible();
});

test("pagar a cobrança pendente: depois da recusa que manda reler, o próximo pedido é um gesto novo (outro requestId)", async ({
  page,
}) => {
  const calls = await openScreen(page, {
    commands: {
      openOverduePayment: [
        (route) =>
          route.fulfill(refusal("CONFLICT", 409, "no_overdue_payment")),
        { handoff: { kind: "redirect", url: OVERDUE_PAGE } },
      ],
    },
    plans: [GRACE],
  });
  await page.getByRole("button", PAY_BUTTON).click();
  await expect(page.getByRole("alert")).toContainText(
    "Não há cobrança pendente para pagar aqui."
  );
  await page.getByRole("button", PAY_BUTTON).click();
  await expect.poll(() => calls.bodies.openOverduePayment.length).toBe(2);
  expect(nth(calls.bodies.openOverduePayment, 1).requestId).not.toBe(
    nth(calls.bodies.openOverduePayment, 0).requestId
  );
});

test("pagar a cobrança pendente: a recusa e o provedor fora têm texto próprio", async ({
  page,
}) => {
  await openScreen(page, {
    commands: {
      openOverduePayment: [
        (route) =>
          route.fulfill(
            refusal("SERVICE_UNAVAILABLE", 503, "billing_provider_unavailable")
          ),
        (route) =>
          route.fulfill(refusal("CONFLICT", 409, "no_overdue_payment")),
      ],
    },
    plans: [GRACE],
  });
  await page.getByRole("button", PAY_BUTTON).click();
  await expect(page.getByRole("alert")).toHaveText(
    "Não conseguimos abrir a página de pagamento agora. Nada foi cobrado. Tente de novo em alguns minutos."
  );
  await page.getByRole("button", PAY_BUTTON).click();
  await expect(page.getByRole("alert")).toContainText(
    "Não há cobrança pendente para pagar aqui. Atualize para ver o plano."
  );
});
