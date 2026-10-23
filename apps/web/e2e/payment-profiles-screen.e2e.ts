/// <reference lib="dom" />
import type { Page, Route } from "@playwright/test";
import { expect, test } from "@playwright/test";
import {
  productionPolicy,
  serveUnderProductionCsp,
  watchCspViolations,
} from "./csp-fixture";
import { serveHealth, serveLabWorker, WORKER_MARK } from "./worker-mark";

/**
 * The payment profiles screen on the components of src/ui (v5.1):
 * - in the lab of the offline screens: every control opens and changes state under the production
 *   Content-Security-Policy with zero violations, in the light and in the dark theme, and at 320 px nothing goes
 *   past the window;
 * - in the real route, with the API answered by the test: a list that could not be read (never shown as empty),
 *   the name that is required, the focus after adding and removing a rule, a profile created, archived and
 *   restored with the result said and focused, and an old refusal taken away when the person fixes the form (U-56).
 */
const DARK = /\bdark\b/;
const NOT_DARK = /^(?!.*\bdark\b).*$/;
const THEMES = [
  { dark: false, name: "claro", stored: "claro" },
  { dark: true, name: "escuro", stored: "escuro" },
] as const;

const ORGANIZATION = {
  id: "0199c2d0-0000-7000-8000-00000000a001",
  name: "Loja do teste",
  role: "owner",
  timezone: "America/Sao_Paulo",
};
const rpc = (json: unknown, status = 200) => ({
  body: JSON.stringify({ json, meta: [] }),
  contentType: "application/json",
  headers: { ...WORKER_MARK },
  status,
});
const unavailable = rpc(
  {
    code: "SERVICE_UNAVAILABLE",
    data: undefined,
    defined: false,
    message: "Unavailable",
    status: 503,
  },
  503
);
const badRequest = rpc(
  {
    code: "BAD_REQUEST",
    data: undefined,
    defined: true,
    message: "BAD_REQUEST",
    status: 400,
  },
  400
);

const fee = (mode: string, percentage: string | null) => ({
  fixedAmount: null,
  mode,
  percentage,
});
const profile = (n: number, name: string, status = "active") => ({
  archivedAt: status === "archived" ? "2026-10-02T12:00:00.000Z" : null,
  createdAt: "2026-10-01T12:00:00.000Z",
  id: `0199c2d0-0000-7000-8000-0000000000c${n}`,
  name,
  organizationId: ORGANIZATION.id,
  rules: [
    {
      anticipationFee: fee("unknown", null),
      expectedSettlementDays: 30,
      id: `rule-${n}`,
      installmentPlan: "merchant",
      installments: 3,
      method: "credit_card",
      processingFee: fee("percentage", "3.000000"),
    },
  ],
  status,
  updatedAt: "2026-10-01T12:00:00.000Z",
  version: 1,
});
const MACHINE = profile(1, "Maquininha da loja");
const OLD_LINK = profile(2, "Link antigo", "archived");

/** The title of the screen and the list: the two ends of every state below. */
const title = (page: Page) =>
  page.getByRole("heading", {
    exact: true,
    level: 1,
    name: "Perfis de pagamento",
  });

// ---- the lab: the same screen without the shell ---------------------------------------------------------------

async function openLab(page: Page, stored = "claro") {
  await page.addInitScript((theme) => {
    window.localStorage.setItem("polaris-tema", theme);
  }, stored);
  await page.route("**/rpc/paymentProfile/list", (route) =>
    route.fulfill(rpc({ profiles: [MACHINE, OLD_LINK] }))
  );
  await serveLabWorker(page);
  await page.goto("/offline-screens-lab?screen=payment-profiles");
  await page.getByLabel("Usuário").fill(`user-${crypto.randomUUID()}`);
  await page.getByRole("button", { exact: true, name: "Iniciar" }).click();
  await expect(page.getByTestId("message")).toContainText(
    "Iniciar: ok (ready)",
    { timeout: 20_000 }
  );
  await expect(title(page)).toBeVisible();
  await expect(page.getByText("Maquininha da loja")).toBeVisible();
}

async function chooseOption(
  page: Page,
  trigger: ReturnType<Page["locator"]>,
  option: string
) {
  await trigger.click();
  await page.getByRole("option", { exact: true, name: option }).click();
  await expect(page.getByRole("listbox")).toHaveCount(0);
}

async function useEveryControl(page: Page) {
  // the list: the archived profiles are shown on request, with their own button
  await expect(page.getByText("Link antigo")).toHaveCount(0);
  await page.getByRole("checkbox", { name: "Incluir arquivados" }).check();
  await expect(page.getByText("Link antigo")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Restaurar perfil Link antigo" })
  ).toBeVisible();

  // the edit of a profile: the form comes filled, with the cursor in the name
  await page
    .getByRole("button", { name: "Editar perfil Maquininha da loja" })
    .click();
  await expect(page.getByLabel("Nome do perfil")).toHaveValue(
    "Maquininha da loja"
  );
  await expect(page.getByLabel("Nome do perfil")).toBeFocused();
  await expect(page.getByLabel("Número de parcelas")).toHaveValue("3");

  // the choices: method, the person responsible for the installments and both fees
  const method = page.getByRole("combobox", { exact: true, name: "Método" });
  await chooseOption(page, method, "Pix");
  // a Pix rule has no installments
  await expect(page.getByLabel("Número de parcelas")).toHaveCount(0);
  await chooseOption(page, method, "Cartão de crédito");
  await chooseOption(
    page,
    page.getByRole("combobox", { name: "Responsável pelo parcelamento" }),
    "Emissor"
  );
  const mode = page.getByRole("combobox", { name: "Como a taxa é informada" });
  await chooseOption(page, mode.nth(1), "Fixo e percentual");
  await page.getByLabel("Valor fixo por pagamento").fill("0,50");
  await expect(page.getByLabel("Valor fixo por pagamento")).toHaveValue("0,50");

  // a second rule: the cursor goes to its method; removing it takes the cursor to "Adicionar regra"
  await page.getByRole("button", { name: "Adicionar regra" }).click();
  await expect(
    page.getByRole("combobox", { exact: true, name: "Método" }).nth(1)
  ).toBeFocused();
  await page.getByRole("button", { name: "Remover regra 2" }).click();
  await expect(
    page.getByRole("button", { name: "Adicionar regra" })
  ).toBeFocused();

  // cancelling the edit gives the focus back to the button of the profile
  await page.getByRole("button", { name: "Cancelar edição" }).click();
  await expect(
    page.getByRole("button", { name: "Editar perfil Maquininha da loja" })
  ).toBeFocused();
}

/**
 * The two projects of the config differ by the pointer and the viewport only, and the CI job that runs them has a
 * limit of 30 minutes: what is about the policy of the page or sets its own width runs once, on the desktop one.
 */
const onlyDesktop = (projectName: string) =>
  test.skip(
    projectName.includes("mobile"),
    "same page, set by the test itself"
  );

for (const theme of THEMES) {
  test(`tema ${theme.name}: Perfis de pagamento abre e cada controle muda de estado sob a CSP de produção sem nenhuma violação`, async ({
    page,
  }, testInfo) => {
    onlyDesktop(testInfo.project.name);
    expect(productionPolicy).toContain("style-src 'self'");
    expect(productionPolicy).not.toContain("unsafe-inline");
    await serveUnderProductionCsp(page);
    const csp = await watchCspViolations(page);
    await openLab(page, theme.stored);
    await expect(page.locator("html")).toHaveClass(
      theme.dark ? DARK : NOT_DARK
    );
    await useEveryControl(page);
    expect(csp.violations()).toEqual([]);
  });
}

/** No box of the screen ends beyond the right edge of the window (the page may hide it, so boxes are measured). */
async function expectNoSidewaysScroll(page: Page) {
  const found = await page.evaluate(() => {
    const root = [...document.querySelectorAll("h1")]
      .find((heading) => heading.textContent === "Perfis de pagamento")
      ?.closest("[data-ui]");
    const limit = window.innerWidth + 0.5;
    const boxes = [...(root?.querySelectorAll("*") ?? [])].map((element) => ({
      right: element.getBoundingClientRect().right,
      text: (element.textContent ?? "").trim().slice(0, 40),
    }));
    return {
      measured: boxes.length,
      past: boxes.filter((box) => box.right > limit),
    };
  });
  // nothing passes vacuously: the screen is there and was measured
  expect(found.measured).toBeGreaterThan(30);
  expect(found.past).toEqual([]);
}

test("a 320 px nada transborda: a lista, a edição com as duas taxas e os erros nos campos", async ({
  page,
}, testInfo) => {
  onlyDesktop(testInfo.project.name);
  await page.setViewportSize({ height: 740, width: 320 });
  await openLab(page);
  await page.getByRole("checkbox", { name: "Incluir arquivados" }).check();
  await expectNoSidewaysScroll(page);

  await page
    .getByRole("button", { name: "Editar perfil Maquininha da loja" })
    .click();
  const mode = page.getByRole("combobox", { name: "Como a taxa é informada" });
  await chooseOption(page, mode.first(), "Fixo e percentual");
  await chooseOption(page, mode.nth(1), "Fixo e percentual");
  await page.getByLabel("Nome do perfil").fill("");
  await page
    .getByLabel("Percentual efetivo sobre o total devido")
    .first()
    .fill("150");
  await page.getByRole("button", { name: "Salvar alterações" }).click();
  await expect(page.getByText("Informe o nome do perfil.")).toBeVisible();
  await expect(
    page.getByText("Informe o valor fixo, por exemplo 0,50.").first()
  ).toBeVisible();
  await expectNoSidewaysScroll(page);
});

// ---- the real route, with the API answered here ---------------------------------------------------------------

interface ServerOptions {
  /** One answer per call of `paymentProfile/list`, in order; the last one repeats. */
  lists: ReadonlyArray<(route: Route) => Promise<void>>;
  others?: Record<string, (route: Route) => Promise<void>>;
}

async function openServerScreen(page: Page, { lists, others }: ServerOptions) {
  let calls = 0;
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
    if (procedure === "paymentProfile/list") {
      const answer = lists[Math.min(calls, lists.length - 1)];
      calls += 1;
      return answer ? answer(route) : route.abort("internetdisconnected");
    }
    const handler = others?.[procedure];
    return handler ? handler(route) : route.abort("internetdisconnected");
  });
  await page.goto("/payment-profiles");
  await expect(title(page)).toBeVisible();
}

const answer = (profiles: unknown[]) => (route: Route) =>
  route.fulfill(rpc({ profiles }));

test("a lista que não carrega diz o motivo, oferece 'Tentar novamente' e nunca aparece como vazia", async ({
  page,
}) => {
  await openServerScreen(page, {
    lists: [(route) => route.fulfill(unavailable), answer([MACHINE])],
  });
  const alert = page.getByRole("alert");
  await expect(alert).toBeVisible();
  // an error is not an empty list
  await expect(page.getByText("Nenhum perfil cadastrado")).toHaveCount(0);
  await alert.getByRole("button", { name: "Tentar novamente" }).click();
  await expect(page.getByText("Maquininha da loja")).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("sem perfil a tela diz que nenhum foi cadastrado; só com arquivados diz que nenhum está ativo", async ({
  page,
}) => {
  await openServerScreen(page, { lists: [answer([])] });
  await expect(page.getByText("Nenhum perfil cadastrado")).toBeVisible();

  await page.unroute("**/rpc/**");
  await openServerScreen(page, { lists: [answer([OLD_LINK])] });
  await expect(page.getByText("Nenhum perfil ativo")).toBeVisible();
  await page.getByRole("checkbox", { name: "Incluir arquivados" }).check();
  await expect(page.getByText("Link antigo")).toBeVisible();
});

test("nome vazio é dito no campo, com o cursor nele, e nada vai ao servidor", async ({
  page,
}) => {
  let creates = 0;
  await openServerScreen(page, {
    lists: [answer([])],
    others: {
      "paymentProfile/create": (route) => {
        creates += 1;
        return route.fulfill(rpc(MACHINE));
      },
    },
  });
  await page.getByRole("button", { name: "Criar perfil" }).click();
  const name = page.getByLabel("Nome do perfil");
  await expect(page.getByText("Informe o nome do perfil.")).toBeVisible();
  await expect(name).toBeFocused();
  await expect(name).toHaveAttribute("aria-invalid", "true");
  expect(creates).toBe(0);
});

test("o crédito pede parcelas inteiras, o prazo só aceita dias inteiros e o valor fixo não fica em branco", async ({
  page,
}) => {
  await openServerScreen(page, { lists: [answer([])] });
  await page.getByLabel("Nome do perfil").fill("Maquininha");
  await chooseOption(
    page,
    page.getByRole("combobox", { exact: true, name: "Método" }),
    "Cartão de crédito"
  );
  await page.getByLabel("Número de parcelas").fill("0");
  await page.getByLabel("Prazo esperado de recebimento (dias)").fill("1,5");
  await chooseOption(
    page,
    page.getByRole("combobox", { name: "Como a taxa é informada" }).first(),
    "Valor fixo"
  );
  await page.getByRole("button", { name: "Criar perfil" }).click();
  await expect(
    page.getByText("Informe o número de parcelas: 1 ou mais, sem vírgula.")
  ).toBeVisible();
  await expect(
    page.getByText(
      "Informe os dias de prazo: 0 ou mais, sem vírgula. Ou deixe em branco."
    )
  ).toBeVisible();
  await expect(
    page.getByText("Informe o valor fixo, por exemplo 0,50.")
  ).toBeVisible();
  // the first problem of the form takes the cursor
  await expect(page.getByLabel("Número de parcelas")).toBeFocused();
});

test("um perfil criado é dito no alto, com o foco, e a lista não volta a 'Carregando'", async ({
  page,
}) => {
  let created = false;
  await openServerScreen(page, {
    lists: [
      (route) => route.fulfill(rpc({ profiles: created ? [MACHINE] : [] })),
    ],
    others: {
      "paymentProfile/create": (route) => {
        created = true;
        return route.fulfill(rpc(MACHINE));
      },
    },
  });
  await page.getByLabel("Nome do perfil").fill("Maquininha da loja");
  await page.getByRole("button", { name: "Criar perfil" }).click();
  const notice = page.getByText("Perfil “Maquininha da loja” criado.");
  await expect(notice).toBeVisible();
  await expect(
    notice.locator("xpath=ancestor::div[@tabindex='-1']")
  ).toBeFocused();
  await expect(page.getByText("Maquininha da loja").last()).toBeVisible();
  await expect(page.getByLabel("Nome do perfil")).toHaveValue("");
});

test("arquivar e restaurar dizem o resultado e a lista acompanha", async ({
  page,
}) => {
  let archived = false;
  await openServerScreen(page, {
    lists: [
      (route) =>
        route.fulfill(
          rpc({
            profiles: [archived ? { ...MACHINE, status: "archived" } : MACHINE],
          })
        ),
    ],
    others: {
      "paymentProfile/archive": (route) => {
        archived = true;
        return route.fulfill(rpc({ ...MACHINE, status: "archived" }));
      },
    },
  });
  await page
    .getByRole("button", { name: "Arquivar perfil Maquininha da loja" })
    .click();
  await expect(
    page.getByText("Perfil “Maquininha da loja” arquivado.")
  ).toBeVisible();
  await expect(page.getByText("Nenhum perfil ativo")).toBeVisible();
  await page.getByRole("checkbox", { name: "Incluir arquivados" }).check();
  await expect(
    page.getByRole("button", { name: "Restaurar perfil Maquininha da loja" })
  ).toBeVisible();
});

test("a recusa do servidor sai da tela quando a pessoa mexe no formulário (U-56)", async ({
  page,
}) => {
  await openServerScreen(page, {
    lists: [answer([])],
    others: { "paymentProfile/create": (route) => route.fulfill(badRequest) },
  });
  await page.getByLabel("Nome do perfil").fill("Maquininha");
  await page.getByRole("button", { name: "Criar perfil" }).click();
  const refused = page.getByRole("alert").filter({
    hasText: "Revise o método, as parcelas, o prazo e os valores das taxas.",
  });
  await expect(refused).toBeVisible();
  await page.getByLabel("Nome do perfil").fill("Maquininha 2");
  await expect(refused).toHaveCount(0);
});

test("duas regras para o mesmo método são recusadas antes de enviar", async ({
  page,
}) => {
  let creates = 0;
  await openServerScreen(page, {
    lists: [answer([])],
    others: {
      "paymentProfile/create": (route) => {
        creates += 1;
        return route.fulfill(rpc(MACHINE));
      },
    },
  });
  await page.getByLabel("Nome do perfil").fill("Maquininha");
  await page.getByRole("button", { name: "Adicionar regra" }).click();
  await page.getByRole("button", { name: "Criar perfil" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "Remova regras repetidas" })
  ).toBeVisible();
  expect(creates).toBe(0);
});

test("os campos da tela não herdam a borda nem a altura do CSS antigo do shell (.ui-root input)", async ({
  page,
}) => {
  await openServerScreen(page, { lists: [answer([])] });
  const style = await page.getByLabel("Nome do perfil").evaluate((node) => {
    const computed = getComputedStyle(node);
    return { border: computed.borderTopWidth, minHeight: computed.minHeight };
  });
  expect(style).toEqual({ border: "0px", minHeight: "auto" });
});

test("o valor fixo aparece com vírgula na lista e no campo, e vai ao servidor com ponto; o prazo de 1 dia fica no singular", async ({
  page,
}) => {
  const pix = {
    ...MACHINE,
    rules: [
      {
        anticipationFee: fee("none", null),
        expectedSettlementDays: 1,
        id: "rule-pix",
        installmentPlan: null,
        installments: null,
        method: "pix",
        processingFee: { fixedAmount: "0.50", mode: "fixed", percentage: null },
      },
      {
        anticipationFee: fee("none", null),
        expectedSettlementDays: null,
        id: "rule-cash",
        installmentPlan: null,
        installments: null,
        method: "cash",
        processingFee: fee("none", null),
      },
    ],
  };
  let sent: {
    json?: { rules?: { processingFee?: { fixedAmount?: string } }[] };
  } = {};
  await openServerScreen(page, {
    lists: [answer([pix])],
    others: {
      "paymentProfile/update": (route) => {
        sent = route.request().postDataJSON();
        return route.fulfill(rpc(pix));
      },
    },
  });
  const row = page.locator("li[data-profile-id]");
  await expect(row).toContainText("R$ 0,50");
  await expect(row).not.toContainText("0.50");
  await expect(row).toContainText("1 dia");
  await expect(row).not.toContainText("1 dias");
  // the rule with no settlement said so
  await expect(row).toContainText("não informado");

  await page
    .getByRole("button", { name: "Editar perfil Maquininha da loja" })
    .click();
  await expect(page.getByLabel("Valor fixo por pagamento")).toHaveValue("0,50");
  await page.getByRole("button", { name: "Salvar alterações" }).click();
  await expect
    .poll(() => sent.json?.rules?.[0]?.processingFee?.fixedAmount)
    .toBe("0.50");
});
