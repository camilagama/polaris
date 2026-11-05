import { describe, expect, it } from "vitest";
import {
  CANCEL_AUDIT,
  IN_PROGRESS,
  NOT_ACCEPTED,
  OUTCOME_NOT_RECORDED,
  PIX_OUTSIDE,
  REASON_HINT,
  REFUND_AUDIT,
  REFUND_LIMIT,
  REFUND_UNDO,
  RETRY_BUTTON,
  UNKNOWN_HINT,
  UNKNOWN_OUTCOME,
  WRITE_MAY_HAVE_HAPPENED,
} from "./refund-words";
import {
  allElements,
  buttons,
  byId,
  byTag,
  type FakeElement,
  visibleText,
} from "./test-dom";
import {
  type Answer,
  alertOf,
  type Call,
  flush,
  json,
  mount,
  OWNER,
  screenContext,
  summary,
} from "./test-page";
import type { RefundWindowView, SupportCaseSummary } from "./types";
import { NO_PERSONAL_DATA } from "./views/privacy-form";

/**
 * The billing of a support case (AC-P10.2 to AC-P10.6): the read is the trigger, the two
 * actions are separate and each is reviewed, the amount sent is the amount read and shown, the command ID is made when
 * the review opens and kept only while the outcome is unknown, and each answer of the server has a sentence of its own.
 */

const STORE = "org-pro-1";
const CASE_ID = "0199b0b0-0000-7000-8000-00000000000a";
const MONEY_IN_URL = /249|duplicidade|Bruno|org-pro/;
const MONEY_IN_TITLE = /249|duplicidade/;
const COMMAND_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const WITH_REFUND = [...OWNER.capabilities, "billing:refund"];

const supportCase = (): SupportCaseSummary => ({
  closedAt: null,
  id: CASE_ID,
  kind: "support",
  openedAt: "2026-10-28T13:05:00.000Z",
  organizationId: STORE,
  organizationName: "Loja do Bruno",
  reason: "Dono pediu reembolso por e-mail",
  status: "open",
});

function billing(overrides: Partial<RefundWindowView> = {}): RefundWindowView {
  return {
    firstChargeAmount: "249.00",
    firstChargeAt: "2026-10-24T18:30:00.000Z",
    method: "card",
    now: "2026-10-28T15:07:12.000Z",
    refundable: true,
    refundRequestedAt: null,
    refundsHere: true,
    renewal: {
      accessUntil: null,
      renewsOn: "2026-11-24",
      resubscribeFrom: null,
      status: "renewing",
    },
    request: null,
    state: "active",
    window: { open: true, until: "2026-11-02T02:59:59.000Z" },
    ...overrides,
  };
}

const cancelled = (): Partial<RefundWindowView> => ({
  renewal: {
    accessUntil: "2026-11-25T02:59:59.999Z",
    renewsOn: null,
    resubscribeFrom: "2026-11-25T02:59:59.999Z",
    status: "cancelled",
  },
});

const sectionOf = (root: FakeElement) =>
  allElements(root).find(
    (element) => element.getAttribute("aria-labelledby") === "reembolso-titulo"
  ) as FakeElement;

/** The store page with the case listed and the billing read; `answers` follow the read. */
async function read(
  view: RefundWindowView,
  answers: Answer[] = [],
  options: {
    capabilities?: string[];
    environment?: "production" | "staging";
  } = {}
) {
  const page = await mount(
    [
      json({
        next: null,
        organizations: [summary({ id: STORE, name: "Loja do Bruno" })],
      }),
      json({ error: "unavailable" }, 503),
      json({ cases: [supportCase()], next: null }),
      json(view),
      ...answers,
    ],
    json({
      ...OWNER,
      capabilities: options.capabilities ?? WITH_REFUND,
    }),
    undefined,
    screenContext({ environment: options.environment ?? "staging" })
  );
  await page.search("Loja");
  buttons(page.root, "Ver loja")[0]?.click();
  await flush();
  const section = sectionOf(page.root);
  buttons(section, "Ver casos abertos desta loja")[0]?.click();
  await flush();
  buttons(section, "Ler a cobrança")[0]?.click();
  await flush();
  const fact = (label: string) =>
    byTag(section, "dt").find((element) => element.textContent === label)
      ?.parent?.children[1]?.textContent;
  const commands = () =>
    page.calls.filter((call) => call.path.includes("/billing/"));
  const bodyOf = (call: Call | undefined) =>
    JSON.parse(String(call?.init.body)) as Record<string, unknown>;
  const type = (reason: string) => {
    const field = byId(section, "cobranca-motivo");
    field.value = reason;
    field.dispatch("input");
  };
  return { ...page, bodyOf, commands, fact, section, type };
}

const cancelResult = (result: string, status = 200, recorded = true) =>
  json(
    status === 200
      ? { outcomeRecorded: recorded, result }
      : { error: result, outcomeRecorded: recorded, result },
    status
  );

function openCancel(page: Awaited<ReturnType<typeof read>>) {
  buttons(page.section, "Cancelar a renovação")[0]?.click();
}

async function confirmCancel(page: Awaited<ReturnType<typeof read>>) {
  openCancel(page);
  page.type("O dono pediu o cancelamento por e-mail");
  buttons(page.section, "Confirmar o cancelamento da renovação")[0]?.click();
  await flush();
}

async function confirmRefund(
  page: Awaited<ReturnType<typeof read>>,
  label = "Reembolsar R$ 249,00"
) {
  buttons(page.section, label)[0]?.click();
  page.type("Cobrança em duplicidade");
  buttons(page.section, label)[1]?.click();
  await flush();
}

describe("the billing is read on a click, and the actions come after it (AC-P10.4)", () => {
  it("shows the facts of the renewal and offers the two actions, with the sentence that replaces the v1's", async () => {
    const page = await read(billing());
    expect(page.fact("Assinatura")).toBe("Pro ativo");
    expect(page.fact("Renovação (pelo registro da loja)")).toBe(
      "Viva: renova em 24/11/2026"
    );
    expect(page.fact("Valor da primeira cobrança deste vínculo")).toBe(
      "R$ 249,00"
    );
    expect(page.fact("Valor da cobrança")).toBeUndefined();
    expect(
      buttons(page.section, "Cancelar a renovação").length +
        buttons(page.section, "Reembolsar R$ 249,00").length
    ).toBe(2);
    expect(visibleText(page.section)).toContain(
      "Cancelar a renovação e reembolsar são ações separadas, cada uma com a sua confirmação."
    );
    expect(visibleText(page.section)).not.toContain(
      "Ela não devolve dinheiro."
    );
    expect(page.commands()).toEqual([]);
  });

  it("offers neither action before the read", async () => {
    const page = await mount(
      [
        json({
          next: null,
          organizations: [summary({ id: STORE, name: "Loja do Bruno" })],
        }),
        json({ error: "unavailable" }, 503),
        json({ cases: [supportCase()], next: null }),
      ],
      json({ ...OWNER, capabilities: WITH_REFUND })
    );
    await page.search("Loja");
    buttons(page.root, "Ver loja")[0]?.click();
    await flush();
    const section = sectionOf(page.root);
    buttons(section, "Ver casos abertos desta loja")[0]?.click();
    await flush();
    expect(buttons(section, "Cancelar a renovação")).toEqual([]);
    expect(
      byTag(section, "button").filter((button) =>
        button.textContent.startsWith("Reembolsar")
      )
    ).toEqual([]);
  });

  it("without an open case there is nothing to read and so no action", async () => {
    const page = await mount(
      [
        json({
          next: null,
          organizations: [summary({ id: STORE, name: "Loja do Bruno" })],
        }),
        json({ error: "unavailable" }, 503),
        json({ cases: [], next: null }),
      ],
      json({ ...OWNER, capabilities: WITH_REFUND })
    );
    await page.search("Loja");
    buttons(page.root, "Ver loja")[0]?.click();
    await flush();
    const section = sectionOf(page.root);
    buttons(section, "Ver casos abertos desta loja")[0]?.click();
    await flush();
    expect(buttons(section, "Ler a cobrança")).toEqual([]);
    expect(buttons(section, "Cancelar a renovação")).toEqual([]);
    expect(
      page.calls.filter((call) => call.path.includes("/billing/"))
    ).toEqual([]);
  });

  it("a case of another store is refused by the server: no facts and no action, and the refusal does not say why", async () => {
    const page = await mount(
      [
        json({
          next: null,
          organizations: [summary({ id: STORE, name: "Loja do Bruno" })],
        }),
        json({ error: "unavailable" }, 503),
        json({ cases: [supportCase()], next: null }),
        json({ error: "refund_window_read_refused" }, 403),
      ],
      json({ ...OWNER, capabilities: WITH_REFUND })
    );
    await page.search("Loja");
    buttons(page.root, "Ver loja")[0]?.click();
    await flush();
    const section = sectionOf(page.root);
    buttons(section, "Ver casos abertos desta loja")[0]?.click();
    await flush();
    buttons(section, "Ler a cobrança")[0]?.click();
    await flush();
    expect(alertOf(section)?.textContent).toBe(
      "Consulta recusada: confira se o caso está aberto e é desta loja."
    );
    expect(buttons(section, "Cancelar a renovação")).toEqual([]);
    expect(byTag(section, "dt")).toEqual([]);
  });

  it("without billing:refund only the cancellation is offered, and the page says the refund needs another permission", async () => {
    const page = await read(billing(), [], {
      capabilities: OWNER.capabilities,
    });
    expect(buttons(page.section, "Cancelar a renovação")).toHaveLength(1);
    expect(
      byTag(page.section, "button").some((button) =>
        button.textContent.startsWith("Reembolsar")
      )
    ).toBe(false);
    expect(visibleText(page.section)).toContain(
      "Reembolsar exige outra permissão."
    );
  });

  it("Pix with the refund off: no refund button, the sentence, and the cancellation stays", async () => {
    const page = await read(
      billing({ method: "pix_automatic", refundsHere: false })
    );
    expect(visibleText(page.section)).toContain(PIX_OUTSIDE);
    expect(
      byTag(page.section, "button").some((button) =>
        button.textContent.startsWith("Reembolsar")
      )
    ).toBe(false);
    expect(buttons(page.section, "Cancelar a renovação")).toHaveLength(1);
  });

  it("Pix with the refund on offers the refund like the card", async () => {
    const page = await read(
      billing({ method: "pix_automatic", refundsHere: true })
    );
    expect(buttons(page.section, "Reembolsar R$ 249,00")).toHaveLength(1);
    expect(visibleText(page.section)).not.toContain(PIX_OUTSIDE);
  });

  it("a renewal already cancelled offers only the refund, and says it is cancelled with the date the server gave", async () => {
    const page = await read(billing(cancelled()));
    expect(buttons(page.section, "Cancelar a renovação")).toEqual([]);
    expect(page.fact("Renovação (pelo registro da loja)")).toBe(
      "Cancelada: o acesso pago vai até 24/11/2026"
    );
    expect(visibleText(page.section)).toContain(
      "A renovação já está cancelada."
    );
    expect(buttons(page.section, "Reembolsar R$ 249,00")).toHaveLength(1);
  });

  it.each([
    ["no charge recorded", { firstChargeAmount: null, firstChargeAt: null }],
    ["a store back on Free", { state: "free" }],
    ["an amount the server would refuse", { firstChargeAmount: "1234.5" }],
  ])("%s: no refund button", async (_name, overrides) => {
    const page = await read(billing(overrides));
    expect(
      byTag(page.section, "button").some((button) =>
        button.textContent.startsWith("Reembolsar")
      )
    ).toBe(false);
    expect(visibleText(page.section)).toContain(
      "Nenhuma cobrança a reembolsar."
    );
  });
});

const caseForm = (section: FakeElement) =>
  byTag(section, "form").find((form) =>
    form.textContent.includes("Motivo do novo caso")
  ) as FakeElement;

describe("one reason field at a time (a confirmation hides the form of a new case)", () => {
  it("hides 'Motivo do novo caso' while the refund confirmation is open and shows it again on Voltar", async () => {
    const page = await read(billing());
    expect(caseForm(page.section).hasAttribute("hidden")).toBe(false);
    buttons(page.section, "Reembolsar R$ 249,00")[0]?.click();
    expect(caseForm(page.section).hasAttribute("hidden")).toBe(true);
    expect(visibleText(page.section)).not.toContain("Motivo do novo caso");
    expect(visibleText(page.section)).not.toContain("Abrir caso");
    expect(visibleText(page.section)).toContain("Motivo");
    buttons(page.section, "Voltar")[0]?.click();
    expect(caseForm(page.section).hasAttribute("hidden")).toBe(false);
    expect(visibleText(page.section)).toContain("Motivo do novo caso");
  });

  it("hides it for the cancel confirmation too, and shows it again once the answer is definite", async () => {
    const page = await read(billing(), [
      cancelResult("cancelled"),
      json(billing(cancelled())),
    ]);
    openCancel(page);
    expect(caseForm(page.section).hasAttribute("hidden")).toBe(true);
    page.type("O dono pediu o cancelamento por e-mail");
    buttons(page.section, "Confirmar o cancelamento da renovação")[0]?.click();
    await flush();
    expect(caseForm(page.section).hasAttribute("hidden")).toBe(false);
  });

  it("shows it again after a definite refusal, and keeps it hidden while the outcome is unknown", async () => {
    const page = await read(billing(), [
      cancelResult("provider_unavailable", 503),
    ]);
    await confirmRefund(page);
    expect(caseForm(page.section).hasAttribute("hidden")).toBe(true);
    const refused = await read(billing(), [
      cancelResult("nothing_to_refund"),
      json(billing()),
    ]);
    await confirmRefund(refused);
    expect(caseForm(refused.section).hasAttribute("hidden")).toBe(false);
  });

  it("keeps it hidden when the amount changed and the confirmation opens again", async () => {
    const page = await read(billing(), [
      cancelResult("amount_changed", 409),
      json(billing({ firstChargeAmount: "199.00" })),
    ]);
    await confirmRefund(page);
    expect(caseForm(page.section).hasAttribute("hidden")).toBe(true);
  });
});

describe("cancelling the renewal (AC-P10.2, AC-P10.3)", () => {
  it("reviews first: environment, store, case, effect with the date, what cannot be undone, the audit and the reason, with nothing sent", async () => {
    const page = await read(billing());
    openCancel(page);
    const text = visibleText(page.section);
    expect(text).toContain("Revise antes de cancelar a renovação");
    expect(text).toContain("STAGING: conta de teste do provedor");
    expect(text).toContain("Loja do Bruno");
    expect(text).toContain("Dono pediu reembolso por e-mail");
    expect(text).toContain(
      "A renovação será cancelada no provedor. O acesso já pago continua até o fim do período já pago. O cliente não é avisado por esta tela."
    );
    expect(text).toContain(
      "Não. O dono da loja pode assinar de novo pelo app a partir do fim do período já pago, quando o período pago termina."
    );
    expect(text).toContain(CANCEL_AUDIT);
    expect(text).toContain(REASON_HINT);
    expect(text).toContain(NO_PERSONAL_DATA);
    expect(page.commands()).toEqual([]);
  });

  it("says the date of the paid access from the server in the effect and in the undo line", async () => {
    const page = await read(
      billing({
        renewal: {
          accessUntil: "2026-11-25T02:59:59.999Z",
          renewsOn: null,
          resubscribeFrom: "2026-11-25T02:59:59.999Z",
          status: "renewing",
        },
      })
    );
    openCancel(page);
    const text = visibleText(page.section);
    expect(text).toContain("O acesso já pago continua até 24/11/2026.");
    expect(text).toContain(
      "Não. O dono da loja pode assinar de novo pelo app a partir de 24/11/2026, quando o período pago termina."
    );
  });

  it("counts the reason by code point and refuses an empty one without asking the server", async () => {
    const page = await read(billing());
    openCancel(page);
    page.type("😀😀");
    expect(byId(page.section, "cobranca-motivo-contador").textContent).toBe(
      "2 de 300 caracteres"
    );
    page.type("   ");
    buttons(page.section, "Confirmar o cancelamento da renovação")[0]?.click();
    await flush();
    expect(byId(page.section, "cobranca-motivo-erro").textContent).toBe(
      "Escreva o motivo."
    );
    expect(page.commands()).toEqual([]);
  });

  it("has no native maxlength: an emoji counts as one, so 300 go through and 301 are refused by the page", async () => {
    const page = await read(billing(), [
      cancelResult("cancelled"),
      json(billing(cancelled())),
    ]);
    openCancel(page);
    expect(
      byId(page.section, "cobranca-motivo").getAttribute("maxlength")
    ).toBeNull();
    page.type(`${"😀".repeat(299)}é`);
    expect(byId(page.section, "cobranca-motivo-contador").textContent).toBe(
      "300 de 300 caracteres"
    );
    page.type("😀".repeat(301));
    buttons(page.section, "Confirmar o cancelamento da renovação")[0]?.click();
    await flush();
    expect(byId(page.section, "cobranca-motivo-erro").textContent).toBe(
      "O motivo aceita até 300 caracteres."
    );
    expect(page.commands()).toEqual([]);
    page.type(`${"😀".repeat(299)}é`);
    buttons(page.section, "Confirmar o cancelamento da renovação")[0]?.click();
    await flush();
    expect(page.bodyOf(page.commands()[0]).reason).toBe(`${"😀".repeat(299)}é`);
  });

  it("sends one request: the command ID the review made, the trimmed reason and nothing else; the button is off meanwhile", async () => {
    let answer: (response: Response) => void = () => undefined;
    const page = await read(billing(), [
      () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
      json(billing(cancelled())),
    ]);
    openCancel(page);
    page.type("  Pedido do dono  ");
    const confirm = buttons(
      page.section,
      "Confirmar o cancelamento da renovação"
    )[0] as FakeElement;
    confirm.click();
    confirm.click();
    expect(confirm.getAttribute("aria-disabled")).toBe("true");
    expect(page.commands()).toHaveLength(1);
    answer(cancelResult("cancelled"));
    await flush();
    const [call] = page.commands();
    expect(call?.path).toBe(
      `/api/support-cases/${CASE_ID}/billing/cancel-renewal`
    );
    expect(page.bodyOf(call)).toEqual({
      commandId: expect.stringMatching(COMMAND_ID),
      reason: "Pedido do dono",
    });
    expect(call?.path).not.toContain("Pedido");
  });

  it("cancelled: says it, with the date, and reads the billing again so the renewal shows as cancelled", async () => {
    const page = await read(billing(), [
      cancelResult("cancelled"),
      json(billing(cancelled())),
    ]);
    await confirmCancel(page);
    expect(visibleText(page.section)).toContain(
      "Renovação cancelada no provedor. O acesso já pago continua até o fim do período já pago."
    );
    expect(page.fact("Renovação (pelo registro da loja)")).toBe(
      "Cancelada: o acesso pago vai até 24/11/2026"
    );
    expect(buttons(page.section, "Cancelar a renovação")).toEqual([]);
    expect(
      page.calls.filter((call) => call.path.endsWith("/refund-window"))
    ).toHaveLength(2);
  });

  it.each([
    ["already_cancelled", "A renovação já estava cancelada. Nada foi mudado."],
    [
      "nothing_to_cancel",
      "Esta loja não tem renovação para cancelar. Nada foi mudado.",
    ],
  ])("%s: a sentence of its own, no technical code", async (result, said) => {
    const page = await read(billing(), [
      cancelResult(result),
      json(
        billing({
          renewal: {
            accessUntil: null,
            renewsOn: null,
            resubscribeFrom: null,
            status: "none",
          },
        })
      ),
    ]);
    await confirmCancel(page);
    expect(visibleText(page.section)).toContain(said);
    expect(visibleText(page.section)).not.toContain(result);
  });

  it("not_linked: an alert, and the billing is read again", async () => {
    const page = await read(billing(), [
      cancelResult("not_linked", 409),
      json(billing()),
    ]);
    await confirmCancel(page);
    expect(alertOf(page.section)?.textContent).toBe(
      "Esta loja não está ligada ao provedor. Nada foi feito."
    );
  });

  it("command_in_progress: said in words, nothing done, the review stays and the buttons are free", async () => {
    const page = await read(billing(), [
      cancelResult("command_in_progress", 409),
    ]);
    await confirmCancel(page);
    expect(alertOf(page.section)?.textContent).toBe(IN_PROGRESS);
    const confirm = buttons(
      page.section,
      "Confirmar o cancelamento da renovação"
    )[0] as FakeElement;
    expect(confirm.getAttribute("aria-disabled")).toBe("false");
  });

  it("provider_unavailable: says it does not know, keeps the review and repeats with the same command ID", async () => {
    const page = await read(billing(), [
      cancelResult("provider_unavailable", 503, false),
      cancelResult("cancelled"),
      json(billing(cancelled())),
    ]);
    await confirmCancel(page);
    expect(alertOf(page.section)?.textContent).toBe(UNKNOWN_OUTCOME);
    expect(visibleText(page.section)).toContain(UNKNOWN_HINT);
    const retry = buttons(page.section, RETRY_BUTTON)[0] as FakeElement;
    retry.click();
    await flush();
    const [first, second] = page.commands();
    expect(page.bodyOf(second)).toEqual(page.bodyOf(first));
    expect(visibleText(page.section)).toContain(
      "Renovação cancelada no provedor."
    );
  });

  it("a result whose audit was not recorded says so and does not hide the result", async () => {
    const page = await read(billing(), [
      cancelResult("cancelled", 200, false),
      json(billing(cancelled())),
    ]);
    await confirmCancel(page);
    expect(alertOf(page.section)?.textContent).toBe(OUTCOME_NOT_RECORDED);
  });

  it.each([
    [
      json({ error: "not_found" }, 404),
      "O caso não está aberto ou não é desta loja. Nada foi feito. Recarregue a página.",
    ],
    [json({ error: "forbidden" }, 403), "Sem permissão para isto."],
    [json({ error: "invalid_request" }, 400), NOT_ACCEPTED],
  ])(
    "a refusal of the route is said in words (%#), nothing is read again",
    async (answer, said) => {
      const page = await read(billing(), [answer]);
      await confirmCancel(page);
      expect(alertOf(page.section)?.textContent).toBe(said);
      expect(
        page.calls.filter((call) => call.path.endsWith("/refund-window"))
      ).toHaveLength(1);
    }
  );

  it.each([
    [new TypeError("Failed to fetch")],
    [json({ error: "internal_error" }, 500)],
    [json({ error: "admin_not_configured" }, 503)],
  ])(
    "a failure after which the write may have happened is not a refusal (%#)",
    async (answer) => {
      const page = await read(billing(), [answer]);
      await confirmCancel(page);
      expect(alertOf(page.section)?.textContent).toBe(WRITE_MAY_HAVE_HAPPENED);
      expect(buttons(page.section, "Reler a cobrança")).toHaveLength(1);
      expect(buttons(page.section, RETRY_BUTTON)).toHaveLength(1);
    }
  );
});

describe("refunding (AC-P10.3 amended: it also cancels the renewal)", () => {
  it("(a) the highlighted amount and the button's are the amount sent, read only from the server", async () => {
    const page = await read(billing({ firstChargeAmount: "1234.00" }), [
      cancelResult("refund_requested"),
      json(billing()),
    ]);
    buttons(page.section, "Reembolsar R$ 1.234,00")[0]?.click();
    const money = allElements(page.section).find(
      (element) => element.getAttribute("class") === "money"
    );
    expect(money?.textContent).toBe("R$ 1.234,00");
    page.type("Cobrança em duplicidade");
    buttons(page.section, "Reembolsar R$ 1.234,00")[1]?.click();
    await flush();
    expect(page.bodyOf(page.commands()[0])).toEqual({
      commandId: expect.stringMatching(COMMAND_ID),
      expectedAmount: "1234.00",
      reason: "Cobrança em duplicidade",
    });
    expect(page.commands()[0]?.path).toBe(
      `/api/support-cases/${CASE_ID}/billing/refund`
    );
  });

  it("(b) the store, its ID and the case are in the review, with the effect, the undo, the audit and the cancellation said", async () => {
    const page = await read(billing());
    buttons(page.section, "Reembolsar R$ 249,00")[0]?.click();
    const text = visibleText(page.section);
    expect(text).toContain("Loja do Bruno");
    expect(text).toContain(STORE);
    expect(text).toContain("Dono pediu reembolso por e-mail");
    expect(text).toContain(
      "Se a renovação ainda estiver viva, ela é cancelada antes."
    );
    expect(text).toContain("o acesso Pro da loja acaba na hora, sem carência");
    expect(text).toContain(REFUND_UNDO);
    expect(text).toContain("isso não poderá ser desfeito");
    expect(text).toContain(REFUND_AUDIT);
    expect(text).toContain("Viva: renova em 24/11/2026");
  });

  it("(d) the reason field carries the notice against personal data, and (e) the limit is said", async () => {
    const page = await read(billing());
    buttons(page.section, "Reembolsar R$ 249,00")[0]?.click();
    const text = visibleText(page.section);
    expect(text).toContain(NO_PERSONAL_DATA);
    expect(text).toContain(REFUND_LIMIT);
    expect(text).toContain("até 3 reembolsos por hora");
    expect(
      byId(page.section, "cobranca-motivo")
        .getAttribute("aria-describedby")
        ?.includes("cobranca-motivo-dica")
    ).toBe(true);
  });

  it("does not ask for the store's name, and sends nothing before the confirmation", async () => {
    const page = await read(billing());
    buttons(page.section, "Reembolsar R$ 249,00")[0]?.click();
    expect(visibleText(page.section)).not.toContain("Digite o nome da loja");
    expect(page.commands()).toEqual([]);
  });

  it("in production the environment line says it is real money, and in staging that it is a test account", async () => {
    const production = await read(billing(), [], { environment: "production" });
    buttons(production.section, "Reembolsar R$ 249,00")[0]?.click();
    const warning = allElements(production.section).find(
      (element) => element.getAttribute("class") === "warning"
    );
    expect(warning?.textContent).toBe("PRODUÇÃO: dinheiro real");
    const staging = await read(billing());
    buttons(staging.section, "Reembolsar R$ 249,00")[0]?.click();
    expect(visibleText(staging.section)).toContain(
      "STAGING: conta de teste do provedor"
    );
  });

  it("refund_requested: says the amount and that the fact comes later, and the billing is read again", async () => {
    const page = await read(billing(), [
      cancelResult("refund_requested"),
      json(
        billing({
          renewal: {
            accessUntil: null,
            renewsOn: null,
            resubscribeFrom: null,
            status: "none",
          },
          state: "free",
        })
      ),
    ]);
    await confirmRefund(page);
    expect(visibleText(page.section)).toContain(
      "Reembolso de R$ 249,00 pedido ao provedor. O dinheiro volta pelo provedor; o fato chega depois e aparece no registro da loja."
    );
    expect(page.fact("Assinatura")).toBe("Free");
    expect(
      byTag(page.section, "button").some((button) =>
        button.textContent.startsWith("Reembolsar")
      )
    ).toBe(false);
  });

  it("nothing_to_refund: says it was done or is in progress, and nothing was done", async () => {
    const page = await read(billing(), [
      cancelResult("nothing_to_refund"),
      json(billing()),
    ]);
    await confirmRefund(page);
    expect(visibleText(page.section)).toContain(
      "Não há cobrança a reembolsar: ela já foi reembolsada ou está em reembolso. Nada foi feito."
    );
  });

  it("not_linked: an alert", async () => {
    const page = await read(billing(), [
      cancelResult("not_linked", 409),
      json(billing()),
    ]);
    await confirmRefund(page);
    expect(alertOf(page.section)?.textContent).toBe(
      "Esta loja não está ligada ao provedor. Nada foi feito."
    );
  });

  it("refund_not_supported (the switch changed between the read and the click): says it, and the read shows no button", async () => {
    const page = await read(billing({ method: "pix_automatic" }), [
      cancelResult("refund_not_supported", 409),
      json(billing({ method: "pix_automatic", refundsHere: false })),
    ]);
    await confirmRefund(page);
    expect(alertOf(page.section)?.textContent).toBe(
      "Reembolso de Pix é feito fora do Polaris. Nada foi feito."
    );
    expect(
      byTag(page.section, "button").some((button) =>
        button.textContent.startsWith("Reembolsar")
      )
    ).toBe(false);
  });

  it("(c) amount_changed: nothing was done, the amount is read again and shown, a new command ID is made, and a new confirmation is asked", async () => {
    const page = await read(billing(), [
      cancelResult("amount_changed", 409),
      json(billing({ firstChargeAmount: "199.00" })),
      cancelResult("refund_requested"),
      json(billing({ state: "free" })),
    ]);
    await confirmRefund(page);
    expect(alertOf(page.section)?.textContent).toBe(
      "O valor da primeira cobrança deste vínculo mudou desde a leitura: agora é R$ 199,00. Nada foi feito. Revise de novo antes de reembolsar."
    );
    expect(page.commands()).toHaveLength(1);
    const money = allElements(page.section).find(
      (element) => element.getAttribute("class") === "money"
    );
    expect(money?.textContent).toBe("R$ 199,00");
    expect(byId(page.section, "cobranca-motivo").value).toBe(
      "Cobrança em duplicidade"
    );
    buttons(page.section, "Reembolsar R$ 199,00")[1]?.click();
    await flush();
    const [first, second] = page.commands();
    expect(page.bodyOf(second).expectedAmount).toBe("199.00");
    expect(page.bodyOf(second).commandId).not.toBe(
      page.bodyOf(first).commandId
    );
  });

  it("amount_changed with the same amount read again says so and does not loop", async () => {
    const page = await read(billing(), [
      cancelResult("amount_changed", 409),
      json(billing()),
    ]);
    await confirmRefund(page);
    expect(alertOf(page.section)?.textContent).toBe(
      "A cobrança em vigor tem um valor diferente de R$ 249,00, o da primeira cobrança deste vínculo, que é o que o registro da loja guarda. Nada foi feito. Por enquanto, o reembolso dela vai pelo painel do provedor."
    );
    expect(page.commands()).toHaveLength(1);
  });

  it("amount_changed with the same amount does not reopen the review, so it spends no other refund of the hour", async () => {
    const page = await read(billing(), [
      cancelResult("amount_changed", 409),
      json(billing()),
    ]);
    await confirmRefund(page);
    expect(
      byTag(page.section, "h4").some(
        (heading) => heading.textContent === "Revise antes de reembolsar"
      )
    ).toBe(false);
  });

  it("amount_changed with the same amount sends one command, opens no confirmation and brings the form of a new case back", async () => {
    const page = await read(billing(), [
      cancelResult("amount_changed", 409),
      json(billing()),
    ]);
    await confirmRefund(page);
    expect(page.commands()).toHaveLength(1);
    expect(buttons(page.section, "Reembolsar R$ 249,00")).toHaveLength(1);
    expect(caseForm(page.section).hasAttribute("hidden")).toBe(false);
  });

  it("an answer whose audit was not recorded does not say the action was done unless it was", async () => {
    const page = await read(billing(), [
      cancelResult("nothing_to_refund", 200, false),
      json(billing()),
    ]);
    await confirmRefund(page);
    expect(alertOf(page.section)?.textContent).toContain(
      "Nada foi feito. O registro do resultado na auditoria não foi confirmado"
    );
    expect(alertOf(page.section)?.textContent).not.toContain(
      "A ação foi feita"
    );
  });

  it("a request that failed on the network does not claim that the audit kept it", async () => {
    const page = await read(billing(), [new TypeError("Failed to fetch")]);
    await confirmRefund(page);
    expect(visibleText(page.section)).not.toContain("A auditoria guardou");
    expect(visibleText(page.section)).toContain("Se o pedido chegou");
  });

  it("a definite refusal of the route makes the next attempt a new command", async () => {
    const page = await read(billing(), [
      json({ error: "invalid_request" }, 400),
      cancelResult("nothing_to_refund"),
      json(billing()),
    ]);
    await confirmRefund(page);
    buttons(page.section, "Reembolsar R$ 249,00")[1]?.click();
    await flush();
    const [first, second] = page.commands();
    expect(page.bodyOf(second).commandId).not.toBe(
      page.bodyOf(first).commandId
    );
  });

  it("command_in_progress keeps the command and its reason: the repeat is the same request", async () => {
    const page = await read(billing(), [
      cancelResult("command_in_progress", 409),
      cancelResult("nothing_to_refund"),
      json(billing()),
    ]);
    await confirmRefund(page);
    byId(page.section, "cobranca-motivo").value = "outro motivo";
    buttons(page.section, "Reembolsar R$ 249,00")[1]?.click();
    await flush();
    const [first, second] = page.commands();
    expect(page.bodyOf(second)).toEqual(page.bodyOf(first));
  });

  it("a store chosen while a command is on its way gets nothing of the answer but a sentence that names the other store", async () => {
    let answer: (response: Response) => void = () => undefined;
    const page = await read(billing(), [
      () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
    ]);
    buttons(page.section, "Reembolsar R$ 249,00")[0]?.click();
    page.type("Motivo");
    buttons(page.section, "Reembolsar R$ 249,00")[1]?.click();
    buttons(page.root, "Ver loja")[0]?.click();
    answer(cancelResult("refund_requested"));
    await flush();
    expect(alertOf(page.section)?.textContent).toContain(
      "Loja Loja do Bruno: Reembolso de R$ 249,00 pedido ao provedor."
    );
    expect(
      page.calls.filter((call) => call.path.endsWith("/refund-window"))
    ).toHaveLength(1);
  });

  it("command_in_progress: said in words, the review stays", async () => {
    const page = await read(billing(), [
      cancelResult("command_in_progress", 409),
    ]);
    await confirmRefund(page);
    expect(alertOf(page.section)?.textContent).toBe(IN_PROGRESS);
    expect(visibleText(page.section)).toContain("Revise antes de reembolsar");
  });

  it("the 429 says the limit of 3 refunds per hour, with the wait when the server gives it, and nothing was done", async () => {
    const wait = new Response(JSON.stringify({ error: "rate_limited" }), {
      headers: { "content-type": "application/json", "retry-after": "1500" },
      status: 429,
    });
    const page = await read(billing(), [wait]);
    await confirmRefund(page);
    expect(alertOf(page.section)?.textContent).toBe(
      "Limite de 3 reembolsos por hora atingido. Nada foi feito. Tente de novo em 25 minutos."
    );
    const without = await read(billing(), [
      json({ error: "rate_limited" }, 429),
    ]);
    await confirmRefund(without);
    expect(alertOf(without.section)?.textContent).toBe(
      "Limite de 3 reembolsos por hora atingido. Nada foi feito. Tente mais tarde."
    );
  });

  it("(c) provider_unavailable: the same command ID, the same amount and the same reason go again, once each, and only one refund results", async () => {
    const page = await read(billing(), [
      cancelResult("provider_unavailable", 503, false),
      cancelResult("refund_requested"),
      json(billing({ state: "free" })),
    ]);
    await confirmRefund(page);
    expect(alertOf(page.section)?.textContent).toBe(UNKNOWN_OUTCOME);
    expect(visibleText(page.section)).toContain(UNKNOWN_HINT);
    // the amount and the reason do not change under a repeat, whatever the field says
    const field = byId(page.section, "cobranca-motivo");
    expect(field.getAttribute("aria-readonly")).toBe("true");
    field.value = "outro motivo";
    buttons(page.section, RETRY_BUTTON)[0]?.click();
    await flush();
    const [first, second] = page.commands();
    expect(page.commands()).toHaveLength(2);
    expect(page.bodyOf(second)).toEqual(page.bodyOf(first));
    expect(visibleText(page.section)).toContain(
      "Reembolso de R$ 249,00 pedido"
    );
  });

  it("(c) Voltar after an unknown outcome drops the command ID: the next review makes a new one", async () => {
    const page = await read(billing(), [
      cancelResult("provider_unavailable", 503, false),
      cancelResult("nothing_to_refund"),
      json(billing()),
    ]);
    await confirmRefund(page);
    buttons(page.section, "Voltar")[0]?.click();
    buttons(page.section, "Reembolsar R$ 249,00")[0]?.click();
    page.type("Cobrança em duplicidade");
    buttons(page.section, "Reembolsar R$ 249,00")[1]?.click();
    await flush();
    const [first, second] = page.commands();
    expect(page.bodyOf(second).commandId).not.toBe(
      page.bodyOf(first).commandId
    );
  });

  it("asks once for a double click and keeps the button off while the server answers", async () => {
    let answer: (response: Response) => void = () => undefined;
    const page = await read(billing(), [
      () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
      json(billing()),
    ]);
    buttons(page.section, "Reembolsar R$ 249,00")[0]?.click();
    page.type("Motivo");
    const confirm = buttons(
      page.section,
      "Reembolsar R$ 249,00"
    )[1] as FakeElement;
    confirm.click();
    confirm.click();
    expect(confirm.getAttribute("aria-disabled")).toBe("true");
    expect(page.commands()).toHaveLength(1);
    answer(cancelResult("nothing_to_refund"));
    await flush();
    expect(page.commands()).toHaveLength(1);
  });

  it("puts no amount, reason, store or case in a URL, a title or the page's own storage", async () => {
    const page = await read(billing(), [
      cancelResult("refund_requested"),
      json(billing()),
    ]);
    await confirmRefund(page);
    for (const call of page.commands()) {
      expect(call.path).not.toMatch(MONEY_IN_URL);
    }
    for (const call of page.calls.filter((item) =>
      item.path.endsWith("/refund-window")
    )) {
      expect(call.path).not.toMatch(MONEY_IN_URL);
    }
    expect(page.navigations).toEqual([]);
    for (const element of allElements(page.root)) {
      expect(element.getAttribute("title") ?? "").not.toMatch(MONEY_IN_TITLE);
    }
  });
});
