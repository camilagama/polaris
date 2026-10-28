import { describe, expect, it } from "vitest";
import { PROBLEM_TEXT } from "./api";
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
  summary,
} from "./test-page";
import type { RefundWindowView, SupportCaseSummary } from "./types";
import { AUDIT_TEXT, READ_ONLY_TEXT } from "./views/refund-window";

/**
 * The refund area of the chosen store (corte admin-tela-v1, AC-9 to AC-11): the open cases of the store, listed on
 * request or opened with a bounded reason; the window read by an explicit POST per click, next to the sentence that
 * says it is audited; the server's window shown as it came, and its refusal said without saying why.
 */

const STORE = "org-pro-1";
const CASE_ID = "0199b0b0-0000-7000-8000-00000000000a";

function supportCase(
  overrides: Partial<SupportCaseSummary> = {}
): SupportCaseSummary {
  return {
    closedAt: null,
    id: CASE_ID,
    kind: "support",
    openedAt: "2026-10-28T13:05:00.000Z",
    organizationId: STORE,
    organizationName: "Loja do Bruno",
    reason: "Dono pediu reembolso por e-mail",
    status: "open",
    ...overrides,
  };
}

/**
 * A window the browser could not have worked out: the deadline is not 7 days after the first charge, so a page that
 * computed one would show another date.
 */
function refundWindow(
  overrides: Partial<RefundWindowView> = {}
): RefundWindowView {
  return {
    firstChargeAmount: "1234.5",
    firstChargeAt: "2026-10-24T18:30:00.000Z",
    method: "card",
    now: "2026-10-28T15:07:12.000Z",
    refundable: true,
    refundRequestedAt: null,
    request: null,
    state: "active",
    window: { open: true, until: "2026-11-02T02:59:59.000Z" },
    ...overrides,
  };
}

const sectionOf = (root: FakeElement) =>
  allElements(root).find(
    (element) => element.getAttribute("aria-labelledby") === "reembolso-titulo"
  ) as FakeElement;

/** The page with one store chosen; `answers` follow the store list and its diagnostics. */
async function chosen(answers: Answer[], capabilities = OWNER.capabilities) {
  const page = await mount(
    [
      json({
        next: null,
        organizations: [summary({ id: STORE, name: "Loja do Bruno" })],
      }),
      json({ error: "unavailable" }, 503),
      ...answers,
    ],
    json({ ...OWNER, capabilities })
  );
  await page.search("Loja");
  buttons(page.root, "Ver loja")[0]?.click();
  await flush();
  const section = sectionOf(page.root);
  const listCases = async () => {
    buttons(section, "Ver casos abertos desta loja")[0]?.click();
    await flush();
  };
  const fact = (label: string) =>
    byTag(section, "dt").find((element) => element.textContent === label)
      ?.parent?.children[1]?.textContent;
  return { ...page, fact, listCases, section };
}

const refundCalls = (calls: Call[]) =>
  calls.filter((call) => call.path.endsWith("/refund-window"));

describe("the refund area of the chosen store (AC-9)", () => {
  it("says that it only shows the window, and reads nothing of the cases until asked", async () => {
    const { calls, section } = await chosen([]);
    expect(section.hasAttribute("hidden")).toBe(false);
    expect(visibleText(section)).toContain(READ_ONLY_TEXT);
    expect(visibleText(section)).not.toContain(AUDIT_TEXT);
    expect(
      calls.some((call) => call.path.startsWith("/api/support-cases"))
    ).toBe(false);
  });

  it("lists the open cases of this store only, as the server filters them", async () => {
    const { calls, listCases, section } = await chosen([
      json({
        cases: [
          supportCase(),
          // what the server would never send for this query is not offered either
          supportCase({
            id: "0199b0b0-0000-7000-8000-00000000000b",
            organizationId: "org-other",
          }),
          supportCase({
            id: "0199b0b0-0000-7000-8000-00000000000c",
            status: "closed",
          }),
          // a privacy case has its own workflow: its reason is not shown here
          supportCase({
            id: "0199b0b0-0000-7000-8000-00000000000d",
            kind: "privacy",
            reason: "Titular pediu os dados",
          }),
        ],
        next: null,
      }),
    ]);
    await listCases();
    const query = new URL(
      calls.at(-1)?.path ?? "",
      "https://admin.example.invalid"
    );
    expect(query.pathname).toBe("/api/support-cases");
    expect(Object.fromEntries(query.searchParams)).toEqual({
      limit: "50",
      organizationId: STORE,
      status: "open",
    });
    const rows = byTag(byTag(section, "tbody")[0] as FakeElement, "tr");
    expect(
      rows.map((row) => row.children.map((cell) => cell.textContent))
    ).toEqual([
      [
        "28/10/2026 10:05",
        "Suporte",
        "Dono pediu reembolso por e-mail",
        "Consultar janela",
      ],
    ]);
    expect(visibleText(section)).toContain("1 caso aberto.");
  });

  it("without an open case of the store offers no read, so the window's route is never called", async () => {
    const { calls, listCases, section } = await chosen([
      json({ cases: [], next: null }),
    ]);
    await listCases();
    expect(visibleText(section)).toContain(
      "Nenhum caso aberto desta loja. Abra um caso para consultar a janela."
    );
    expect(buttons(section, "Consultar janela")).toEqual([]);
    expect(refundCalls(calls)).toEqual([]);
  });

  it("opens a case with the reason as JSON in the body, never in the URL, and offers it for the read", async () => {
    const reason = 'Pedido de reembolso <b>&</b> "urgente"';
    const { calls, document, section } = await chosen([
      json(
        {
          id: CASE_ID,
          kind: "support",
          openedAt: "2026-10-28T15:07:00.000Z",
          organizationId: STORE,
          reason,
          status: "open",
        },
        201
      ),
    ]);
    const field = byId(section, "motivo");
    field.value = reason;
    field.dispatch("input");
    expect(byId(section, "motivo-contador").textContent).toBe(
      `${[...reason].length} de 500 caracteres`
    );
    buttons(section, "Abrir caso")[0]?.click();
    await flush();
    const open = calls.at(-1);
    expect(open?.path).toBe("/api/support-cases");
    expect(open?.init).toMatchObject({
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      method: "POST",
      redirect: "manual",
    });
    expect(JSON.parse(String(open?.init.body))).toEqual({
      kind: "support",
      organizationId: STORE,
      reason,
    });
    expect(open?.path).not.toContain("reembolso");
    const [read] = buttons(section, "Consultar janela");
    expect(document.activeElement).toBe(read);
    expect(byTag(section, "td").map((cell) => cell.textContent)).toContain(
      reason
    );
    expect(byTag(section, "b")).toEqual([]);
    expect(field.value).toBe("");
  });

  it.each([
    ["", "Escreva o motivo do caso."],
    ["   ", "Escreva o motivo do caso."],
    ["a".repeat(501), "O motivo aceita até 500 caracteres."],
    ["😀".repeat(501), "O motivo aceita até 500 caracteres."],
    [
      "linha\u0007",
      "O motivo não aceita caracteres de controle nem quebra de linha.",
    ],
    [
      "com\u009bC1",
      "O motivo não aceita caracteres de controle nem quebra de linha.",
    ],
  ])(
    "refuses a reason the server would refuse, without asking it, under the field (%#)",
    async (reason, text) => {
      const { calls, document, section } = await chosen([]);
      const before = calls.length;
      byId(section, "motivo").value = reason;
      buttons(section, "Abrir caso")[0]?.click();
      await flush();
      const field = byId(section, "motivo");
      const error = byId(section, "motivo-erro");
      expect(error.textContent).toBe(text);
      expect(error.hasAttribute("hidden")).toBe(false);
      expect(field.getAttribute("aria-describedby")).toContain("motivo-erro");
      expect(field.getAttribute("aria-invalid")).toBe("true");
      expect(document.activeElement).toBe(field);
      expect(alertOf(section)).toBeUndefined();
      expect(calls).toHaveLength(before);
      field.dispatch("input");
      expect(error.hasAttribute("hidden")).toBe(true);
      expect(field.hasAttribute("aria-invalid")).toBe(false);
    }
  );

  it("sends the reason trimmed, as it was checked", async () => {
    const { calls, section } = await chosen([
      json({ ...supportCase(), reason: "x" }, 201),
    ]);
    byId(section, "motivo").value = "  Motivo do caso \n";
    buttons(section, "Abrir caso")[0]?.click();
    await flush();
    expect(JSON.parse(String(calls.at(-1)?.init.body))).toMatchObject({
      reason: "Motivo do caso",
    });
  });

  it("takes a reason of exactly 500 characters, counted as a person counts them", async () => {
    const { calls, section } = await chosen([
      json({ ...supportCase(), reason: "x" }, 201),
    ]);
    byId(section, "motivo").value = "😀".repeat(500);
    buttons(section, "Abrir caso")[0]?.click();
    await flush();
    expect(calls.at(-1)?.path).toBe("/api/support-cases");
  });

  it("says a refused reason or a missing permission in words", async () => {
    const { section } = await chosen([
      json({ error: "invalid_case_reason" }, 400),
    ]);
    byId(section, "motivo").value = "Motivo";
    buttons(section, "Abrir caso")[0]?.click();
    await flush();
    expect(byId(section, "motivo-erro").textContent).toBe(
      "O motivo não foi aceito: use de 1 a 500 caracteres, sem caracteres de controle."
    );
    expect(alertOf(section)).toBeUndefined();
  });
  it("turns the buttons back on and says the Admin failed when the list is not one", async () => {
    const { listCases, section } = await chosen([json({ next: null })]);
    await listCases();
    expect(alertOf(section)?.textContent).toBe(PROBLEM_TEXT.failed);
    expect(
      buttons(section, "Ver casos abertos desta loja")[0]?.getAttribute(
        "aria-disabled"
      )
    ).toBe("false");
  });

  it.each([
    new TypeError("Failed to fetch"),
    json({ error: "internal_error" }, 500),
    json({ error: "unavailable" }, 503),
    json(null, 201),
  ])(
    "says that a case may have been opened when the answer is not the case, so it is not opened twice (%#)",
    async (answer) => {
      const { section } = await chosen([answer]);
      byId(section, "motivo").value = "Motivo";
      buttons(section, "Abrir caso")[0]?.click();
      await flush();
      expect(alertOf(section)?.textContent).toBe(
        "Não foi possível confirmar se o caso foi aberto. Veja os casos abertos desta loja antes de tentar de novo."
      );
    }
  );
});

describe("reading the refund window (AC-9, AC-10)", () => {
  async function listed(answers: Answer[], capabilities = OWNER.capabilities) {
    const page = await chosen(
      [json({ cases: [supportCase()], next: null }), ...answers],
      capabilities
    );
    await page.listCases();
    return page;
  }

  it("asks only on the explicit click, by POST of the store's ID, next to the sentence of the audit", async () => {
    const { calls, section } = await listed([json(refundWindow())]);
    expect(refundCalls(calls)).toEqual([]);
    const read = buttons(section, "Consultar janela")[0] as FakeElement;
    expect(read.getAttribute("aria-describedby")).toBe("reembolso-auditoria");
    expect(byId(section, "reembolso-auditoria").textContent).toBe(AUDIT_TEXT);
    // the sentence sits right above the list whose buttons make the read
    const audit = byId(section, "reembolso-auditoria");
    const siblings = audit.parent?.children ?? [];
    expect(siblings.indexOf(audit) + 1).toBe(
      siblings.findIndex((element) => element.tagName === "table")
    );
    read.click();
    await flush();
    const [call] = refundCalls(calls);
    expect(call?.path).toBe(`/api/support-cases/${CASE_ID}/refund-window`);
    expect(call?.init).toMatchObject({
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      method: "POST",
      redirect: "manual",
    });
    expect(JSON.parse(String(call?.init.body))).toEqual({
      organizationId: STORE,
    });
  });

  it("shows the window as the server computed it, never one of its own", async () => {
    const { fact, section } = await listed([json(refundWindow())]);
    buttons(section, "Consultar janela")[0]?.click();
    await flush();
    expect(fact("Janela de arrependimento")).toBe("Dentro do prazo");
    // the last minute of the day the server said, in Brasília: not one the page worked out from the first charge
    expect(fact("Prazo até")).toBe("01/11/2026 23:59");
    expect(fact("Primeira cobrança")).toBe("24/10/2026 15:30");
    expect(fact("Valor da primeira cobrança")).toBe("R$ 1.234,50");
    expect(fact("Forma de pagamento")).toBe("Cartão");
    expect(fact("Assinatura")).toBe("Pro ativo");
    expect(fact("A regra do Polaris ainda permite o reembolso")).toBe("Sim");
    expect(fact("Pedido de reembolso do dono")).toBe("Nenhum");
    expect(fact("Consulta feita em")).toBe(
      "28/10/2026 12:07 (relógio do servidor)"
    );
    expect(visibleText(section)).toContain(
      "Janela lida. A consulta ficou registrada na auditoria."
    );
  });

  it.each([
    [
      refundWindow({
        refundable: false,
        window: { open: false, until: "2026-10-20T02:59:59.000Z" },
      }),
      "Fora do prazo",
      "Não",
    ],
    [
      refundWindow({
        firstChargeAmount: null,
        firstChargeAt: null,
        method: null,
        refundable: false,
        state: "trialing",
        window: null,
      }),
      "Sem primeira cobrança: não há janela de arrependimento.",
      "Não",
    ],
    [
      refundWindow({ method: "boleto", state: "novo" }),
      "Dentro do prazo",
      "Sim",
    ],
  ])(
    "says the window's verdict in words (%#)",
    async (view, verdict, refundable) => {
      const { fact, section } = await listed([json(view)]);
      buttons(section, "Consultar janela")[0]?.click();
      await flush();
      expect(fact("Janela de arrependimento")).toBe(verdict);
      expect(fact("A regra do Polaris ainda permite o reembolso")).toBe(
        refundable
      );
      if (view.state === "novo") {
        expect(fact("Assinatura")).toBe("estado desconhecido: novo");
        expect(fact("Forma de pagamento")).toBe("forma desconhecida: boleto");
      }
    }
  );

  it("says the owner's request and until when the app completes it", async () => {
    const { fact, section } = await listed([
      json(
        refundWindow({
          refundRequestedAt: "2026-10-25T12:00:00.000Z",
          request: {
            at: "2026-10-25T12:00:00.000Z",
            completable: false,
            completableUntil: "2026-10-28T12:00:00.000Z",
          },
        })
      ),
    ]);
    buttons(section, "Consultar janela")[0]?.click();
    await flush();
    expect(fact("Pedido de reembolso do dono")).toBe(
      "Feito em 25/10/2026 09:00; pode ser concluído pelo app até 28/10/2026 09:00 (prazo passou)"
    );
  });

  it("shows no window from an answer of another shape, and says the Admin failed", async () => {
    const { fact, section } = await listed([json({ state: "active" })]);
    buttons(section, "Consultar janela")[0]?.click();
    await flush();
    expect(alertOf(section)?.textContent).toBe(PROBLEM_TEXT.failed);
    expect(fact("Janela de arrependimento")).toBeUndefined();
    expect(
      buttons(section, "Consultar janela")[0]?.getAttribute("aria-disabled")
    ).toBe("false");
  });

  it("asks once for a double click: the buttons are off while the server answers", async () => {
    let answer: (response: Response) => void = () => undefined;
    const { calls, section } = await listed([
      () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
    ]);
    const read = buttons(section, "Consultar janela")[0] as FakeElement;
    read.click();
    read.click();
    expect(read.getAttribute("aria-disabled")).toBe("true");
    expect(refundCalls(calls)).toHaveLength(1);
    answer(json(refundWindow()));
    await flush();
    expect(read.getAttribute("aria-disabled")).toBe("false");
    expect(refundCalls(calls)).toHaveLength(1);
  });

  it("says a refusal without saying whether the case was closed or of another store, and does not ask again", async () => {
    const { calls, document, section } = await listed([
      json({ error: "refund_window_read_refused" }, 403),
    ]);
    buttons(section, "Consultar janela")[0]?.click();
    await flush();
    const alert = alertOf(section);
    expect(alert?.textContent).toBe(
      "Consulta recusada: confira se o caso está aberto e é desta loja."
    );
    expect(document.activeElement).toBe(alert);
    expect(refundCalls(calls)).toHaveLength(1);
  });

  it.each([
    [json({ error: "forbidden" }, 403), PROBLEM_TEXT.forbidden],
    [json({ error: "unauthenticated" }, 401), PROBLEM_TEXT.session],
    [json({ error: "internal_error" }, 500), PROBLEM_TEXT.failed],
    [new TypeError("Failed to fetch"), PROBLEM_TEXT.network],
  ])(
    "says every other failure in its own words (%#)",
    async (failure, text) => {
      const { section } = await listed([failure]);
      buttons(section, "Consultar janela")[0]?.click();
      await flush();
      expect(alertOf(section)?.textContent).toBe(text);
    }
  );

  it("forgets the window and the cases of the store chosen before", async () => {
    const page = await listed([
      json(refundWindow()),
      json({ error: "unavailable" }, 503),
    ]);
    buttons(page.section, "Consultar janela")[0]?.click();
    await flush();
    buttons(page.root, "Ver loja")[0]?.click();
    await flush();
    expect(byTag(page.section, "dt")).toEqual([]);
    expect(buttons(page.section, "Consultar janela")).toEqual([]);
  });
});

describe("what the operator may do (AC-3)", () => {
  it("lists and opens cases without billing:operate, but offers no read of the window", async () => {
    const { calls, section } = await chosen(
      [json({ cases: [supportCase()], next: null })],
      ["organization:diagnose", "support_case:manage"]
    );
    buttons(section, "Ver casos abertos desta loja")[0]?.click();
    await flush();
    expect(visibleText(section)).toContain(
      "Sem permissão para consultar a janela."
    );
    expect(buttons(section, "Consultar janela")).toEqual([]);
    expect(refundCalls(calls)).toEqual([]);
  });

  it("shows nothing of the cases without support_case:manage, and says why", async () => {
    const { section } = await chosen(
      [],
      ["organization:diagnose", "billing:operate"]
    );
    expect(visibleText(section)).toContain(PROBLEM_TEXT.forbidden);
    expect(buttons(section, "Ver casos abertos desta loja")).toEqual([]);
    expect(byTag(section, "form")).toEqual([]);
  });
});
