import { describe, expect, it } from "vitest";
import { PROBLEM_TEXT } from "./api";
import {
  allElements,
  buttons,
  type FakeElement,
  visibleText,
} from "./test-dom";
import {
  type Answer,
  alertOf,
  type Call,
  diagnostics,
  flush,
  json,
  mount,
  OWNER,
  screenContext,
} from "./test-page";
import type { SupportCaseDetail, SupportCasePage } from "./types";
import {
  CLOSED_STORE,
  INTERNAL_EFFECT,
  INTERNAL_UNREAD,
  REACTIVATE_EFFECT,
  REACTIVATE_UNDO,
  SUSPEND_EFFECTS,
  SUSPEND_UNDO,
} from "./views/store-actions";

/**
 * Suspend, reactivate and mark as internal on the screen of an open case, in a small DOM against a simulated API
 * (corte admin-v2, Parte 3): what the review says and in which order (AC-P3.1), reactivating only a suspension
 * (AC-P3.2), the state read again once after the answer (AC-P3.3), the mark (AC-P3.4), one request per click and the
 * sentence of each answer (AC-C2, AC-C3), the capability that hides each action (AC-C1).
 */

const CASE = "0199a0a0-0000-7000-8000-00000000c0de";
const STORE = "0199a0a0-0000-7000-8000-0000000000a1";
const ANOTHER_STORE = "0199a0a0-0000-7000-8000-0000000000a2";
const OPENED_AT = "2026-10-28T13:05:00.000Z";
const HOSTILE = [
  "<img src=x onerror=alert(1)>",
  "<script>alert(1)</script>",
  "javascript:alert(1)",
  "‮abc",
  '"><svg onload=1>',
];
const NEVER_CREATED = ["script", "img", "svg", "iframe"];

const ALL = {
  ...OWNER,
  capabilities: [
    ...OWNER.capabilities,
    "organization:suspend",
    "organization:classify",
  ],
};
const withCapabilities = (...capabilities: string[]) => ({
  ...OWNER,
  capabilities,
});

function detail(
  overrides: Partial<SupportCaseDetail["case"]> = {}
): SupportCaseDetail {
  return {
    audit: [],
    case: {
      closedAt: null,
      context: null,
      id: CASE,
      kind: "support",
      openedAt: OPENED_AT,
      openedBy: OWNER.principal.id,
      organizationId: STORE,
      organizationName: "Loja da Ana",
      reason: "Dono pediu ajuda com o estoque",
      resolution: null,
      status: "open",
      ...overrides,
    },
    grants: [],
  };
}

const state = (status: string, id = STORE) => json(diagnostics({ id, status }));

const caseContext = () => screenContext({ id: CASE, screen: "caso" });

const posts = (calls: Call[]) =>
  calls.filter((call) => call.init.method === "POST");

const bodyOf = (call: Call | undefined) =>
  JSON.parse(String(call?.init.body ?? "null"));

function pending() {
  let release: (response: Response) => void = () => undefined;
  const answer: Answer = () =>
    new Promise<Response>((resolve) => {
      release = resolve;
    });
  return { answer, release: (response: Response) => release(response) };
}

const open = (
  answers: Answer[],
  who = ALL,
  caseDetail = detail(),
  context = caseContext()
) =>
  mount(
    [json(caseDetail), ...answers],
    json(who),
    () => new Date("2026-10-28T15:07:00.000Z"),
    context
  );

type Mounted = Awaited<ReturnType<typeof open>>;

const firstButton = (root: FakeElement, text: string): FakeElement => {
  const [target] = buttons(root, text);
  if (target === undefined) {
    throw new Error(`no button ${text}`);
  }
  return target;
};

const click = async (root: FakeElement, text: string) => {
  firstButton(root, text).click();
  await flush();
};

const WAITING_TEXT = /fica na fila|ficam na fila|até a reativação/;
const TECHNICAL_TEXT = /internal_error|case_not_open|\b400\b/;

const shown = (mounted: Mounted) => visibleText(mounted.root);

describe("the review before suspending (AC-P3.1)", () => {
  it("offers Suspender a loja only for an active store, and sends nothing before the click", async () => {
    const mounted = await open([state("active")]);

    expect(mounted.calls.map((call) => call.path)).toEqual([
      "/api/whoami",
      `/api/support-cases/${CASE}`,
      `/api/organizations/${STORE}/diagnostics`,
    ]);
    expect(buttons(mounted.root, "Suspender a loja")).toHaveLength(1);
    expect(buttons(mounted.root, "Reativar a loja")).toHaveLength(0);
    expect(shown(mounted)).toContain("Situação da loja: Ativa.");
    expect(posts(mounted.calls)).toHaveLength(0);
  });

  it("says, in this order, every effect, the way back and what stays in the audit, with the store and the case", async () => {
    const mounted = await open([state("active")]);

    await click(mounted.root, "Suspender a loja");
    const text = shown(mounted).slice(
      shown(mounted).indexOf("Revise antes de suspender")
    );

    const positions = [
      "STAGING",
      "Loja da Ana",
      "Dono pediu ajuda com o estoque",
      ...SUSPEND_EFFECTS,
      SUSPEND_UNDO,
      "A suspensão fica na auditoria com o seu e-mail e o caso.",
    ].map((part) => text.indexOf(part));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(positions[3]).toBeGreaterThan(positions[2] ?? 0);
    expect(SUSPEND_EFFECTS[0]).toContain("deixa de abrir para os próprios");
    expect(SUSPEND_EFFECTS[1]).toContain("pode ser recusado ao sincronizar");
    expect(SUSPEND_EFFECTS[2]).toBe("A cobrança não muda.");
    expect(SUSPEND_EFFECTS[3]).toBe("O cliente não é avisado.");
    expect(SUSPEND_UNDO).toContain("Reativar não devolve as concessões");
    expect(text).not.toMatch(WAITING_TEXT);
    expect(posts(mounted.calls)).toHaveLength(0);
  });

  it("puts the focus on the review heading and gives it back to the button on Voltar", async () => {
    const mounted = await open([state("active")]);

    await click(mounted.root, "Suspender a loja");
    expect(mounted.document.activeElement?.textContent).toBe(
      "Revise antes de suspender"
    );

    await click(mounted.root, "Voltar");
    expect(mounted.document.activeElement?.textContent).toBe(
      "Suspender a loja"
    );
    expect(posts(mounted.calls)).toHaveLength(0);
  });

  it("suspends with one POST to the case's route and reads the store once more, then shows the state it says", async () => {
    const mounted = await open([
      state("active"),
      json({ changed: true, revokedLeases: 2, status: "suspended" }),
      state("suspended"),
    ]);

    await click(mounted.root, "Suspender a loja");
    await click(mounted.root, "Confirmar suspensão da loja");

    expect(posts(mounted.calls)).toHaveLength(1);
    expect(mounted.calls[3]?.path).toBe(`/api/support-cases/${CASE}/suspend`);
    expect(bodyOf(mounted.calls[3])).toEqual({});
    expect(mounted.calls[4]?.path).toBe(
      `/api/organizations/${STORE}/diagnostics`
    );
    expect(mounted.calls).toHaveLength(5);
    const text = shown(mounted);
    expect(text).toContain("Loja suspensa às 12:07.");
    expect(text).toContain("2 autorizações offline revogadas.");
    expect(text).toContain("Situação da loja: Suspensa.");
    expect(buttons(mounted.root, "Suspender a loja")).toHaveLength(0);
    expect(buttons(mounted.root, "Reativar a loja")).toHaveLength(1);
  });

  it("shows the state the server reads back, not the one the click expected", async () => {
    const mounted = await open([
      state("active"),
      json({ changed: true, status: "suspended" }),
      state("active"),
    ]);

    await click(mounted.root, "Suspender a loja");
    await click(mounted.root, "Confirmar suspensão da loja");

    expect(shown(mounted)).toContain("Situação da loja: Ativa.");
    expect(buttons(mounted.root, "Suspender a loja")).toHaveLength(1);
    expect(buttons(mounted.root, "Reativar a loja")).toHaveLength(0);
  });

  it("says nothing changed when the server answers changed false, and still reads the store once", async () => {
    const mounted = await open([
      state("active"),
      json({ changed: false, status: "closed" }),
      state("closed"),
    ]);

    await click(mounted.root, "Suspender a loja");
    await click(mounted.root, "Confirmar suspensão da loja");

    const text = shown(mounted);
    expect(text).toContain("Nada mudou: a situação da loja é Encerrada.");
    expect(text).not.toContain("Loja suspensa às");
    expect(mounted.calls).toHaveLength(5);
    expect(text).toContain(CLOSED_STORE);
  });

  it("sends one POST when Confirmar is clicked twice while the answer is on its way", async () => {
    const wait = pending();
    const mounted = await open([
      state("active"),
      wait.answer,
      state("suspended"),
    ]);

    await click(mounted.root, "Suspender a loja");
    const confirm = firstButton(mounted.root, "Confirmar suspensão da loja");
    confirm.click();
    confirm.click();
    await flush();

    expect(posts(mounted.calls)).toHaveLength(1);
    expect(confirm.getAttribute("aria-disabled")).toBe("true");

    await click(mounted.root, "Voltar");
    expect(shown(mounted)).toContain("Revise antes de suspender");

    wait.release(json({ changed: true, status: "suspended" }));
    await flush();

    expect(posts(mounted.calls)).toHaveLength(1);
    expect(mounted.calls).toHaveLength(5);
  });
});

describe("reactivating (AC-P3.2)", () => {
  it("offers Reativar only for a suspended store, with the sentence that it undoes only the suspension", async () => {
    const mounted = await open([state("suspended")]);

    expect(buttons(mounted.root, "Reativar a loja")).toHaveLength(1);
    expect(buttons(mounted.root, "Suspender a loja")).toHaveLength(0);
    expect(shown(mounted)).toContain(
      "Reativar desfaz só a suspensão. Loja encerrada continua encerrada."
    );
    expect(REACTIVATE_EFFECT).toBe(
      "Reativar desfaz só a suspensão. Loja encerrada continua encerrada."
    );
  });

  it("reviews, then posts to the reactivate route, reads once more and shows the active store", async () => {
    const mounted = await open([
      state("suspended"),
      json({ changed: true, status: "active" }),
      state("active"),
    ]);

    await click(mounted.root, "Reativar a loja");
    expect(shown(mounted)).toContain(REACTIVATE_UNDO);
    expect(posts(mounted.calls)).toHaveLength(0);
    await click(mounted.root, "Confirmar reativação da loja");

    expect(mounted.calls[3]?.path).toBe(
      `/api/support-cases/${CASE}/reactivate`
    );
    expect(mounted.calls).toHaveLength(5);
    const text = shown(mounted);
    expect(text).toContain("Loja reativada às 12:07.");
    expect(text).toContain("Situação da loja: Ativa.");
    expect(buttons(mounted.root, "Suspender a loja")).toHaveLength(1);
  });

  it("shows no Reativar and no Suspender for a closed store, and says it stays closed", async () => {
    const mounted = await open([state("closed")]);

    expect(buttons(mounted.root, "Reativar a loja")).toHaveLength(0);
    expect(buttons(mounted.root, "Suspender a loja")).toHaveLength(0);
    expect(shown(mounted)).toContain(CLOSED_STORE);
    expect(posts(mounted.calls)).toHaveLength(0);
  });

  it("offers no action for a state it does not know, and says so", async () => {
    const mounted = await open([state("purge_pending")]);

    expect(buttons(mounted.root, "Reativar a loja")).toHaveLength(0);
    expect(buttons(mounted.root, "Suspender a loja")).toHaveLength(0);
    expect(shown(mounted)).toContain("situação desconhecida: purge_pending");
  });

  it("says nothing changed when the store was not suspended any more", async () => {
    const mounted = await open([
      state("suspended"),
      json({ changed: false, status: "active" }),
      state("active"),
    ]);

    await click(mounted.root, "Reativar a loja");
    await click(mounted.root, "Confirmar reativação da loja");

    expect(shown(mounted)).toContain("Nada mudou: a situação da loja é Ativa.");
  });
});

describe("who sees what (AC-C1, AC-P3.1)", () => {
  it("shows no panel and reads no store without the capability to suspend or classify", async () => {
    const mounted = await open([], OWNER);

    expect(mounted.calls).toHaveLength(2);
    expect(buttons(mounted.root, "Suspender a loja")).toHaveLength(0);
    expect(shown(mounted)).not.toContain("Loja interna");
  });

  it("tells a suspender without the diagnose capability that the state is needed, with no read and no button", async () => {
    const mounted = await open(
      [],
      withCapabilities("support_case:manage", "organization:suspend")
    );

    expect(mounted.calls).toHaveLength(2);
    expect(shown(mounted)).toContain(
      "Para suspender ou reativar é preciso poder ver a situação da loja."
    );
    expect(buttons(mounted.root, "Suspender a loja")).toHaveLength(0);
  });

  it("shows only the mark, and reads no store, with only the capability to classify", async () => {
    const mounted = await open(
      [],
      withCapabilities("support_case:manage", "organization:classify")
    );

    expect(mounted.calls).toHaveLength(2);
    expect(buttons(mounted.root, "Suspender a loja")).toHaveLength(0);
    expect(
      buttons(mounted.root, "Marcar como loja interna do Polaris")
    ).toHaveLength(1);
  });

  it("offers no action on a closed case", async () => {
    const mounted = await open(
      [],
      ALL,
      detail({ closedAt: OPENED_AT, status: "closed" })
    );

    expect(mounted.calls).toHaveLength(2);
    expect(shown(mounted)).not.toContain("Loja interna");
    expect(buttons(mounted.root, "Suspender a loja")).toHaveLength(0);
  });

  it("does not trust a diagnosis of another store: no state, no action", async () => {
    const mounted = await open([state("active", ANOTHER_STORE)]);

    expect(alertOf(mounted.root)?.textContent).toBe(PROBLEM_TEXT.failed);
    expect(buttons(mounted.root, "Suspender a loja")).toHaveLength(0);
    expect(buttons(mounted.root, "Reler a situação")).toHaveLength(1);
    expect(posts(mounted.calls)).toHaveLength(0);
  });

  it("reads the store again, only on request, when the first read failed", async () => {
    const mounted = await open([
      json({ error: "admin_not_configured" }, 503),
      state("active"),
    ]);

    expect(alertOf(mounted.root)?.textContent).toBe(PROBLEM_TEXT.unavailable);
    await click(mounted.root, "Reler a situação");

    expect(mounted.calls).toHaveLength(4);
    expect(buttons(mounted.root, "Suspender a loja")).toHaveLength(1);
  });
});

describe("what each answer of the suspension says (AC-C3)", () => {
  const confirmed = async (answer: Answer, ...after: Answer[]) => {
    const mounted = await open([state("active"), answer, ...after]);
    await click(mounted.root, "Suspender a loja");
    await click(mounted.root, "Confirmar suspensão da loja");
    return mounted;
  };

  it.each([
    [
      400,
      "O caso não está aberto ou não é desta loja. Nada foi mudado. Recarregue o caso.",
    ],
    [403, "Sem permissão para isto."],
    [404, "Este caso não foi encontrado."],
    [401, PROBLEM_TEXT.session],
  ])(
    "says the sentence of a %s, keeps the review and allows the click again",
    async (status, sentence) => {
      const mounted = await confirmed(json({ error: "x" }, status));

      expect(alertOf(mounted.root)?.textContent).toBe(sentence);
      expect(mounted.calls).toHaveLength(4);
      expect(shown(mounted)).toContain("Revise antes de suspender");
      const confirm = firstButton(mounted.root, "Confirmar suspensão da loja");
      expect(confirm.getAttribute("aria-disabled")).toBe("false");
      expect(shown(mounted)).not.toMatch(TECHNICAL_TEXT);
    }
  );

  it("says the wait the server gave on a 429, with no automatic retry", async () => {
    const mounted = await confirmed(
      new Response("{}", { headers: { "retry-after": "61" }, status: 429 })
    );

    expect(alertOf(mounted.root)?.textContent).toBe(
      "Limite de consultas por hora atingido. Tente de novo em 2 minutos."
    );
    expect(mounted.calls).toHaveLength(4);
  });

  it("reads the store once on a 409 and says what it is now", async () => {
    const mounted = await confirmed(
      json({ error: "conflict" }, 409),
      state("suspended")
    );

    expect(alertOf(mounted.root)?.textContent).toBe(
      "Esta ação já não se aplica: a loja agora está suspensa."
    );
    expect(mounted.calls).toHaveLength(5);
    expect(buttons(mounted.root, "Reativar a loja")).toHaveLength(1);
  });

  it.each([
    ["a 503", () => json({ error: "admin_not_configured" }, 503)],
    ["a 500", () => json({ error: "internal_error" }, 500)],
    ["a network failure", () => new Error("offline")],
    ["an answer it cannot read", () => json({ unexpected: true })],
  ])(
    "does not say it failed on %s: it says it could not confirm, offers only a new read and no retry",
    async (_name, make) => {
      const mounted = await confirmed(make(), state("suspended"));

      expect(alertOf(mounted.root)?.textContent).toBe(
        "Não deu para confirmar se a loja foi suspensa. Releia a situação antes de tentar de novo."
      );
      expect(buttons(mounted.root, "Confirmar suspensão da loja")).toHaveLength(
        0
      );
      expect(buttons(mounted.root, "Suspender a loja")).toHaveLength(0);
      expect(buttons(mounted.root, "Reler a situação")).toHaveLength(1);
      expect(posts(mounted.calls)).toHaveLength(1);
      expect(shown(mounted)).toContain("Situação da loja não confirmada.");
      expect(shown(mounted)).not.toContain("Situação da loja: Ativa.");

      await click(mounted.root, "Reler a situação");

      expect(mounted.calls).toHaveLength(5);
      expect(buttons(mounted.root, "Reativar a loja")).toHaveLength(1);
    }
  );

  it("keeps the success when the read after it fails, and offers no action until the state is read again", async () => {
    const mounted = await confirmed(
      json({ changed: true, status: "suspended" }),
      json({ error: "internal_error" }, 500)
    );

    expect(shown(mounted)).toContain("Loja suspensa às 12:07.");
    expect(buttons(mounted.root, "Suspender a loja")).toHaveLength(0);
    expect(buttons(mounted.root, "Reativar a loja")).toHaveLength(0);
    expect(buttons(mounted.root, "Reler a situação")).toHaveLength(1);
  });

  it.each(HOSTILE)(
    "shows the hostile name %s as text and builds no element of a script",
    async (name) => {
      const mounted = await open(
        [state("active")],
        ALL,
        detail({ organizationName: name, reason: name })
      );
      await click(mounted.root, "Suspender a loja");

      expect(shown(mounted)).toContain("Revise antes de suspender");
      const created = new Set(mounted.document.created);
      expect(NEVER_CREATED.filter((tag) => created.has(tag))).toEqual([]);
    }
  );
});

describe("the mark of an internal store (AC-P3.4)", () => {
  const markOnly = withCapabilities(
    "support_case:manage",
    "organization:classify"
  );

  it("says what the mark does and that the state is not known before the server says it", async () => {
    const mounted = await open([], markOnly);

    const text = shown(mounted);
    expect(text).toContain(INTERNAL_EFFECT);
    expect(text).toContain(INTERNAL_UNREAD);
    expect(text).toContain("A loja sai do funil de ativação.");
    expect(text).toContain("Desmarcar a devolve ao funil.");
    expect(
      buttons(mounted.root, "Marcar como loja interna do Polaris")
    ).toHaveLength(1);
    expect(buttons(mounted.root, "Desmarcar loja interna")).toHaveLength(1);
    expect(posts(mounted.calls)).toHaveLength(0);
  });

  it("marks with one POST of internal true to the store's route and then shows what the server says", async () => {
    const mounted = await open(
      [json({ changed: true, internal: true })],
      markOnly
    );

    await click(mounted.root, "Marcar como loja interna do Polaris");

    expect(mounted.calls[2]?.path).toBe(
      `/api/organizations/${STORE}/classification`
    );
    expect(bodyOf(mounted.calls[2])).toEqual({ internal: true });
    expect(mounted.calls).toHaveLength(3);
    const text = shown(mounted);
    expect(text).toContain(
      "A loja está marcada como interna e saiu do funil de ativação."
    );
    expect(text).toContain("Esta loja está marcada como interna.");
    expect(
      buttons(mounted.root, "Marcar como loja interna do Polaris")
    ).toHaveLength(0);
    expect(buttons(mounted.root, "Desmarcar loja interna")).toHaveLength(1);
  });

  it("unmarks, and says it went back to the funnel", async () => {
    const mounted = await open(
      [
        json({ changed: true, internal: true }),
        json({ changed: true, internal: false }),
      ],
      markOnly
    );

    await click(mounted.root, "Marcar como loja interna do Polaris");
    await click(mounted.root, "Desmarcar loja interna");

    expect(bodyOf(mounted.calls[3])).toEqual({ internal: false });
    const text = shown(mounted);
    expect(text).toContain("voltou ao funil de ativação");
    expect(text).toContain("Esta loja não está marcada como interna.");
  });

  it("says nothing changed when the server says it already was so", async () => {
    const mounted = await open(
      [json({ changed: false, internal: false })],
      markOnly
    );

    await click(mounted.root, "Desmarcar loja interna");

    expect(shown(mounted)).toContain("Nada mudou: já era assim.");
  });

  it("shows the state the server answers, not the one asked", async () => {
    const mounted = await open(
      [json({ changed: false, internal: false })],
      markOnly
    );

    await click(mounted.root, "Marcar como loja interna do Polaris");

    expect(shown(mounted)).toContain(
      "Esta loja não está marcada como interna."
    );
  });

  it("sends one POST when the button is clicked twice while the answer is on its way", async () => {
    const wait = pending();
    const mounted = await open([wait.answer], markOnly);

    const button = firstButton(
      mounted.root,
      "Marcar como loja interna do Polaris"
    );
    button.click();
    button.click();
    await flush();

    expect(posts(mounted.calls)).toHaveLength(1);
    expect(button.getAttribute("aria-disabled")).toBe("true");

    wait.release(json({ changed: true, internal: true }));
    await flush();

    expect(posts(mounted.calls)).toHaveLength(1);
  });

  it.each([
    [400, "O pedido não foi aceito. Recarregue a página."],
    [403, "Sem permissão para isto."],
    [404, "Esta loja não foi encontrada."],
    [401, PROBLEM_TEXT.session],
  ])(
    "says the sentence of a %s and allows another click",
    async (status, sentence) => {
      const mounted = await open([json({ error: "x" }, status)], markOnly);

      await click(mounted.root, "Marcar como loja interna do Polaris");

      expect(alertOf(mounted.root)?.textContent).toBe(sentence);
      const button = firstButton(
        mounted.root,
        "Marcar como loja interna do Polaris"
      );
      expect(button.getAttribute("aria-disabled")).toBe("false");
    }
  );

  it("says the wait on a 429", async () => {
    const mounted = await open(
      [new Response("{}", { headers: { "retry-after": "300" }, status: 429 })],
      markOnly
    );

    await click(mounted.root, "Marcar como loja interna do Polaris");

    expect(alertOf(mounted.root)?.textContent).toBe(
      "Limite de consultas por hora atingido. Tente de novo em 5 minutos."
    );
  });

  it.each([
    ["a 503", () => json({ error: "admin_not_configured" }, 503)],
    ["a network failure", () => new Error("offline")],
    ["an answer it cannot read", () => json({ unexpected: true })],
  ])(
    "says it could not confirm the mark on %s, and says repeating is safe",
    async (_name, make) => {
      const mounted = await open([make()], markOnly);

      await click(mounted.root, "Marcar como loja interna do Polaris");

      expect(alertOf(mounted.root)?.textContent).toBe(
        "Não deu para confirmar se a marca foi gravada. Repetir é seguro: tente de novo."
      );
      expect(shown(mounted)).toContain(INTERNAL_UNREAD);
    }
  );

  it("makes the mark without a case being read as a state of the store", async () => {
    const mounted = await open([json({ changed: true, internal: true })], ALL);

    await click(mounted.root, "Marcar como loja interna do Polaris");

    expect(
      mounted.calls.filter((call) => call.path.endsWith("/diagnostics"))
    ).toHaveLength(1);
  });
});

describe("opening the screen only reads (AC-C5, AC-C6)", () => {
  it("asks the same, with no POST, each time the case opens", async () => {
    const first = await open([state("active")]);
    const second = await open([state("active")]);

    const summarize = (calls: Call[]) =>
      calls.map((call) => [call.init.method, call.path]);
    expect(summarize(second.calls)).toEqual(summarize(first.calls));
    expect(posts(first.calls)).toHaveLength(0);
  });

  it("puts nothing of the store in the URLs it asks for besides its ID", async () => {
    const mounted = await open([state("active")]);

    for (const call of mounted.calls) {
      expect(call.path).not.toContain("Loja da Ana");
      expect(call.path).not.toContain("estoque");
    }
    expect(
      allElements(mounted.root).filter((element) => element.tagName === "a")
        .length
    ).toBeGreaterThanOrEqual(0);
  });
});

describe("Loja points to the actions that live in the case (AC-P3.1)", () => {
  const storeContext = () => screenContext({ id: STORE, screen: "loja" });
  const casePage = (cases: SupportCasePage["cases"]): SupportCasePage => ({
    cases,
    next: null,
  });
  const summaryOf = (organizationId: string, id: string) => ({
    closedAt: null,
    id,
    kind: "support",
    openedAt: OPENED_AT,
    organizationId,
    organizationName: "Loja",
    reason: "Motivo",
    status: "open",
  });

  it("has no action of its own, makes no POST, and says where they are", async () => {
    const mounted = await mount(
      [json(casePage([summaryOf(STORE, CASE)])), state("active")],
      json(ALL),
      undefined,
      storeContext()
    );

    expect(posts(mounted.calls)).toHaveLength(0);
    expect(buttons(mounted.root, "Suspender a loja")).toHaveLength(0);
    expect(visibleText(mounted.root)).toContain(
      "Suspender, reativar e marcar a loja como interna são ações do caso aberto desta loja."
    );
  });

  it("does not offer a case of another store as the way to act", async () => {
    const other = "0199a0a0-0000-7000-8000-00000000c0aa";
    const mounted = await mount(
      [json(casePage([summaryOf(ANOTHER_STORE, other)])), state("active")],
      json(ALL),
      undefined,
      storeContext()
    );

    const links = allElements(mounted.root)
      .filter((element) => element.tagName === "a")
      .map((element) => element.getAttribute("href"));
    expect(links.some((href) => href?.includes(other))).toBe(false);
    expect(visibleText(mounted.root)).toContain(
      "Nenhum caso aberto desta loja."
    );
  });

  it("says nothing about the actions to an operator who cannot take them", async () => {
    const mounted = await mount(
      [json(casePage([])), state("active")],
      json(withCapabilities("organization:diagnose", "support_case:manage")),
      undefined,
      storeContext()
    );

    expect(visibleText(mounted.root)).not.toContain(
      "marcar a loja como interna"
    );
  });
});
