import { describe, expect, it } from "vitest";
import { PROBLEM_TEXT } from "./api";
import { MAX_HOURS, MAX_REASON_LENGTH } from "./grant-limits";
import {
  allElements,
  buttons,
  byId,
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
import type { SupportCaseDetail } from "./types";
import {
  END_EFFECT,
  END_UNDO,
  END_UNKNOWN,
  GRANT_REPEATED,
  GRANT_RETRY,
  GRANT_UNDO,
  GRANT_UNKNOWN,
  NO_GRANTS,
  NOTHING_ENDED,
  OUTCOME_NOT_RECORDED,
} from "./views/entitlements";
import { GRANT_EXPIRES, GRANT_RAISES } from "./views/grant-form";

/**
 * Giving and ending a temporary entitlement on the screen of an open case (corte admin-v2, Parte 4): the form and what
 * it refuses before sending (AC-P4.1), the sentences (AC-P4.2), the same ID for the same request (AC-P4.3), ending
 * by the ID of the diagnostics (AC-P4.4, AC-P4.6), one request per click and the sentence of each answer
 * (AC-C2, AC-C3), the capability that hides it (AC-C1), the text as text (AC-C7).
 */

const CASE = "0199a0a0-0000-7000-8000-00000000c0de";
const STORE = "0199a0a0-0000-7000-8000-0000000000a1";
const GRANT = "0199c0c0-0000-7000-8000-0000000000a1";
const OTHER_GRANT = "0199c0c0-0000-7000-8000-0000000000a2";
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HOSTILE = [
  "<img src=x onerror=alert(1)>",
  "<script>alert(1)</script>",
  "javascript:alert(1)",
  "‮abc",
  '"><svg onload=1>',
];
const NEVER_CREATED = ["script", "img", "svg", "iframe"];
const TECHNICAL_TEXT =
  /grant_id_conflict|invalid_[a-z]+|internal_error|case_not_open|\b4\d\d\b|\b50\d\b/;

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
      openedAt: "2026-10-28T13:05:00.000Z",
      openedBy: OWNER.principal.id,
      organizationId: STORE,
      organizationName: "Loja da Ana",
      reason: "Dono pediu mais variantes por uma semana",
      resolution: null,
      status: "open",
      ...overrides,
    },
    grants: [],
  };
}

const inForce = (id: string | undefined, key = "variants.active.max") => ({
  expiresAt: "2026-11-02T15:00:00.000Z",
  flagValue: null,
  ...(id === undefined ? {} : { id }),
  key,
  limitValue: 2000,
  revokedAt: null,
  startsAt: "2026-10-28T12:00:00.000Z",
});

const report = (grants: unknown[], id = STORE) =>
  json({ ...diagnostics({ id }), grants });

const caseContext = () => screenContext({ id: CASE, screen: "caso" });

const open = (
  answers: Answer[],
  who = OWNER,
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

const shown = (mounted: Mounted) => visibleText(mounted.root);

const writes = (calls: Call[]) =>
  calls.filter((call) => call.init.method !== "GET");

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

interface Typed {
  hours?: string;
  key?: string;
  reason?: string;
  value?: string;
}

/** Fills the form as a person would and asks for the review. */
async function fill(mounted: Mounted, typed: Typed = {}) {
  const key = byId(mounted.root, "concessao-chave");
  key.value = typed.key ?? "variants.active.max";
  key.dispatch("change");
  byId(mounted.root, "concessao-valor").value = typed.value ?? "2000";
  byId(mounted.root, "concessao-horas").value = typed.hours ?? "48";
  byId(mounted.root, "concessao-motivo").value =
    typed.reason ?? "Compensação pela queda";
  await click(mounted.root, "Revisar a concessão");
}

async function toReview(mounted: Mounted, typed: Typed = {}) {
  await click(mounted.root, "Dar uma concessão");
  await fill(mounted, typed);
}

const granted = (overrides: Record<string, unknown> = {}, status = 201) =>
  json(
    {
      created: true,
      id: "0199c0c0-0000-7000-8000-0000000000ff",
      organizationId: STORE,
      outcomeRecorded: true,
      ...overrides,
    },
    status
  );

const refusal = (error: string, status: number, headers?: HeadersInit) =>
  new Response(JSON.stringify({ error }), {
    headers: { "content-type": "application/json", ...headers },
    status,
  });

describe("the panel's place on the case screen (AC-P4.1, AC-C1, AC-C5)", () => {
  it("appears for an open support case with billing:operate and asks for nothing besides the case", async () => {
    const mounted = await open([]);

    expect(shown(mounted)).toContain("Plano e cobrança");
    expect(buttons(mounted.root, "Dar uma concessão")).toHaveLength(1);
    expect(mounted.calls.map((call) => call.path)).toEqual([
      "/api/whoami",
      `/api/support-cases/${CASE}`,
    ]);
  });

  it("is not on the screen without billing:operate, for a closed case or for a privacy case", async () => {
    const without = await open([], {
      ...OWNER,
      capabilities: ["support_case:manage", "organization:diagnose"],
    });
    expect(shown(without)).not.toContain("Plano e cobrança");

    const closed = await open(
      [],
      OWNER,
      detail({ closedAt: "2026-10-28T14:00:00.000Z", status: "closed" })
    );
    expect(shown(closed)).not.toContain("Plano e cobrança");

    const privacy = await open([], OWNER, detail({ kind: "privacy" }));
    expect(shown(privacy)).not.toContain("Plano e cobrança");
  });

  it("offers only the keys the Worker named, with their words, and none from a list of its own", async () => {
    const mounted = await open(
      [],
      OWNER,
      detail(),
      screenContext({
        flagKeys: ["public_catalog"],
        id: CASE,
        limitKeys: ["goals.active.max"],
        screen: "caso",
      })
    );

    await click(mounted.root, "Dar uma concessão");
    const options = allElements(byId(mounted.root, "concessao-chave"))
      .filter((element) => element.tagName === "option")
      .map((element) => [element.getAttribute("value"), element.textContent]);

    expect(options).toEqual([
      ["", "Escolha…"],
      ["goals.active.max", "Metas ativas"],
      ["public_catalog", "Catálogo público"],
    ]);
  });
});

describe("the grants in force and the way to end one (AC-P4.4, AC-P4.6)", () => {
  it("reads the diagnostics on the click and lists the key, the value and the end of each grant in force", async () => {
    const mounted = await open([
      report([
        inForce(GRANT),
        { ...inForce(OTHER_GRANT, "goals.active.max"), limitValue: 20 },
        {
          ...inForce("0199c0c0-0000-7000-8000-0000000000b1"),
          revokedAt: "2026-10-28T14:00:00.000Z",
        },
        {
          ...inForce("0199c0c0-0000-7000-8000-0000000000b2"),
          expiresAt: "2026-10-28T15:00:00.000Z",
        },
      ]),
    ]);

    await click(mounted.root, "Ver concessões em vigor");

    expect(mounted.calls[2]?.path).toBe(
      `/api/organizations/${STORE}/diagnostics`
    );
    const text = shown(mounted);
    expect(text).toContain("Variantes ativas");
    expect(text).toContain("2000");
    expect(text).toContain("02/11/2026");
    expect(text).toContain("Metas ativas");
    expect(buttons(mounted.root, "Encerrar concessão")).toHaveLength(2);
    expect(text).toContain("Concessões lidas às 12:07.");
    expect(buttons(mounted.root, "Ver concessões em vigor")).toHaveLength(0);
    expect(buttons(mounted.root, "Atualizar concessões")).toHaveLength(1);
  });

  it("says when there is none in force", async () => {
    const mounted = await open([report([])]);

    await click(mounted.root, "Ver concessões em vigor");

    expect(shown(mounted)).toContain(NO_GRANTS);
    expect(buttons(mounted.root, "Encerrar concessão")).toHaveLength(0);
  });

  it("lists a grant that came without an ID but offers no way to end it", async () => {
    const mounted = await open([report([inForce(undefined)])]);

    await click(mounted.root, "Ver concessões em vigor");

    expect(shown(mounted)).toContain("Variantes ativas");
    expect(buttons(mounted.root, "Encerrar concessão")).toHaveLength(0);
  });

  it("shows nothing of a report that is of another store", async () => {
    const mounted = await open([
      report([inForce(GRANT)], "0199a0a0-0000-7000-8000-0000000000a9"),
    ]);

    await click(mounted.root, "Ver concessões em vigor");

    expect(buttons(mounted.root, "Encerrar concessão")).toHaveLength(0);
    expect(alertOf(mounted.root)?.textContent).toBe(PROBLEM_TEXT.failed);
  });

  it("does not offer the list without the capability to see the store, and still lets a grant be given", async () => {
    const mounted = await open([], {
      ...OWNER,
      capabilities: ["support_case:manage", "billing:operate"],
    });

    expect(buttons(mounted.root, "Ver concessões em vigor")).toHaveLength(0);
    expect(buttons(mounted.root, "Dar uma concessão")).toHaveLength(1);
  });
});

describe("the form (AC-P4.1, AC-P4.2)", () => {
  it("says that a grant only raises and expires by itself, before anything is asked", async () => {
    const mounted = await open([]);

    expect(shown(mounted)).toContain(GRANT_RAISES);
    expect(shown(mounted)).toContain("Expira sozinha no prazo.");
    expect(GRANT_RAISES).toBe(
      "A concessão só eleva o plano da loja; nunca reduz um limite nem desliga um recurso."
    );
    expect(GRANT_EXPIRES).toBe("Expira sozinha no prazo.");
  });

  it("counts the reason, and a flag is yes or no while a limit is a number", async () => {
    const mounted = await open([]);

    await click(mounted.root, "Dar uma concessão");
    expect(shown(mounted)).toContain(`0 de ${MAX_REASON_LENGTH} caracteres`);
    const reason = byId(mounted.root, "concessao-motivo");
    reason.value = "abc";
    reason.dispatch("input");
    expect(shown(mounted)).toContain(`3 de ${MAX_REASON_LENGTH} caracteres`);

    const key = byId(mounted.root, "concessao-chave");
    key.value = "offline.write";
    key.dispatch("change");
    expect(byId(mounted.root, "concessao-valor").tagName).toBe("select");
    key.value = "variants.active.max";
    key.dispatch("change");
    expect(byId(mounted.root, "concessao-valor").tagName).toBe("input");
  });

  it.each([
    ["no key", { key: "" }],
    ["a key that is not in the catalog", { key: "plan.pro" }],
    ["a value that is not a whole number", { value: "1.5" }],
    ["an empty value", { value: "" }],
    ["a negative value", { value: "-1" }],
    ["no hours", { hours: "" }],
    ["zero hours", { hours: "0" }],
    ["hours that are not whole", { hours: "1.5" }],
    ["hours past the server's longest grant", { hours: String(MAX_HOURS + 1) }],
    ["no reason", { reason: "   " }],
    [
      "a reason of 301 characters",
      { reason: "x".repeat(MAX_REASON_LENGTH + 1) },
    ],
    ["a reason with a control character", { reason: "um\u0007dois" }],
    ["a reason with a line break", { reason: "um\ndois" }],
  ])(
    "does not send %s, and says what is wrong with the focus on the field",
    async (_name, typed) => {
      const mounted = await open([]);

      await toReview(mounted, typed);

      expect(writes(mounted.calls)).toHaveLength(0);
      expect(buttons(mounted.root, "Confirmar concessão")).toHaveLength(0);
      expect(byId(mounted.root, "concessao-erro").textContent).not.toBe("");
      expect(mounted.document.activeElement?.getAttribute("aria-invalid")).toBe(
        "true"
      );
    }
  );

  it("takes a reason of exactly 300 characters and the longest period", async () => {
    const mounted = await open([]);

    await toReview(mounted, {
      hours: String(MAX_HOURS),
      reason: "x".repeat(MAX_REASON_LENGTH),
    });

    expect(buttons(mounted.root, "Confirmar concessão")).toHaveLength(1);
  });

  it("goes back to the start on Cancelar, with nothing sent", async () => {
    const mounted = await open([]);

    await click(mounted.root, "Dar uma concessão");
    await click(mounted.root, "Cancelar");

    expect(buttons(mounted.root, "Dar uma concessão")).toHaveLength(1);
    expect(writes(mounted.calls)).toHaveLength(0);
  });
});

describe("the review before giving (AC-C2, AC-C4, AC-P4.1)", () => {
  it("says, in this order, the environment, the store, the case, the effect, the way back and the audit, and sends nothing", async () => {
    const mounted = await open([]);

    await toReview(mounted);
    const all = shown(mounted);
    const text = all.slice(all.indexOf("Revise antes de dar a concessão"));

    const positions = [
      "STAGING",
      "Loja da Ana",
      "Dono pediu mais variantes por uma semana",
      "A loja passa a ter Variantes ativas = 2000 até 30/10/2026",
      ", sem mudar a cobrança.",
      GRANT_RAISES,
      GRANT_UNDO,
      "A concessão fica na auditoria com o seu e-mail e o caso.",
    ].map((part) => text.indexOf(part));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(text).toContain("Compensação pela queda");
    expect(text).toContain(GRANT_EXPIRES);
    expect(text).toContain("estimativa pelo relógio deste navegador");
    expect(writes(mounted.calls)).toHaveLength(0);
    expect(mounted.document.activeElement?.textContent).toBe(
      "Revise antes de dar a concessão"
    );
  });

  it("says a capability as ligado or desligado", async () => {
    const mounted = await open([]);

    await toReview(mounted, { key: "offline.write", value: "true" });

    expect(shown(mounted)).toContain(
      "A loja passa a ter Venda offline = ligado até"
    );
  });

  it("goes back to the form with what was typed", async () => {
    const mounted = await open([]);

    await toReview(mounted, { reason: "Meu motivo" });
    await click(mounted.root, "Voltar");

    expect(byId(mounted.root, "concessao-motivo").value).toBe("Meu motivo");
    expect(byId(mounted.root, "concessao-horas").value).toBe("48");
    expect(byId(mounted.root, "concessao-chave").value).toBe(
      "variants.active.max"
    );
    expect(writes(mounted.calls)).toHaveLength(0);
  });
});

describe("giving the grant (AC-P4.3, AC-C2, AC-C3)", () => {
  it("sends one POST to the case's route with the command ID, reads the diagnostics once and says the end comes from the list", async () => {
    const mounted = await open([
      granted(),
      report([inForce("0199c0c0-0000-7000-8000-0000000000ff")]),
    ]);

    await toReview(mounted);
    await click(mounted.root, "Confirmar concessão");

    expect(writes(mounted.calls)).toHaveLength(1);
    const [, , post] = mounted.calls;
    expect(post?.path).toBe(`/api/support-cases/${CASE}/entitlement-grants`);
    expect(post?.init.method).toBe("POST");
    const body = bodyOf(post);
    expect(Object.keys(body).sort()).toEqual([
      "commandId",
      "hours",
      "key",
      "reason",
      "value",
    ]);
    expect(body).toMatchObject({
      hours: 48,
      key: "variants.active.max",
      reason: "Compensação pela queda",
      value: 2000,
    });
    expect(body.commandId).toMatch(UUID);
    expect(mounted.calls[3]?.path).toBe(
      `/api/organizations/${STORE}/diagnostics`
    );
    expect(mounted.calls).toHaveLength(4);
    const text = shown(mounted);
    expect(text).toContain("Concessão dada às 12:07.");
    expect(text).toContain("A data em que acaba é a da lista.");
    expect(buttons(mounted.root, "Encerrar concessão")).toHaveLength(1);
    expect(mounted.document.activeElement?.textContent).toContain(
      "Concessão dada"
    );
  });

  it("sends a capability as a boolean", async () => {
    const mounted = await open([granted(), report([])]);

    await toReview(mounted, { key: "public_catalog", value: "true" });
    await click(mounted.root, "Confirmar concessão");

    expect(bodyOf(mounted.calls[2])).toMatchObject({
      key: "public_catalog",
      value: true,
    });
  });

  it("sends one request for a double click, with the button off while it answers", async () => {
    const slow = pending();
    const mounted = await open([slow.answer, report([])]);

    await toReview(mounted);
    const confirm = firstButton(mounted.root, "Confirmar concessão");
    confirm.click();
    confirm.click();
    await flush();

    expect(writes(mounted.calls)).toHaveLength(1);
    expect(confirm.getAttribute("aria-disabled")).toBe("true");
    expect(
      firstButton(mounted.root, "Voltar").getAttribute("aria-disabled")
    ).toBe("true");
    slow.release(granted());
    await flush();
    expect(writes(mounted.calls)).toHaveLength(1);
  });

  it("repeats the same command ID for the same request after an answer that never came", async () => {
    const mounted = await open([
      new Error("network"),
      granted({ created: false }, 200),
      report([]),
    ]);

    await toReview(mounted);
    await click(mounted.root, "Confirmar concessão");
    expect(alertOf(mounted.root)?.textContent).toBe(GRANT_UNKNOWN);
    expect(buttons(mounted.root, "Confirmar concessão")).toHaveLength(0);

    await click(mounted.root, "Voltar ao formulário");
    await click(mounted.root, "Revisar a concessão");
    await click(mounted.root, "Confirmar concessão");

    const [first, second] = writes(mounted.calls);
    expect(bodyOf(first).commandId).toMatch(UUID);
    expect(bodyOf(second).commandId).toBe(bodyOf(first).commandId);
    expect(shown(mounted)).toContain(GRANT_REPEATED);
  });

  it("makes another command ID when what is sent is not the same request any more", async () => {
    const mounted = await open([new Error("network"), granted(), report([])]);

    await toReview(mounted);
    await click(mounted.root, "Confirmar concessão");
    await click(mounted.root, "Voltar ao formulário");
    byId(mounted.root, "concessao-horas").value = "72";
    await click(mounted.root, "Revisar a concessão");
    await click(mounted.root, "Confirmar concessão");

    const [first, second] = writes(mounted.calls);
    expect(bodyOf(second).hours).toBe(72);
    expect(bodyOf(second).commandId).not.toBe(bodyOf(first).commandId);
  });

  it("makes a new command ID each time the form is opened", async () => {
    const mounted = await open([granted(), report([]), granted(), report([])]);

    await toReview(mounted);
    await click(mounted.root, "Confirmar concessão");
    await toReview(mounted);
    await click(mounted.root, "Confirmar concessão");

    const [first, second] = writes(mounted.calls);
    expect(bodyOf(second).commandId).not.toBe(bodyOf(first).commandId);
  });
});

describe("the sentence of each answer to giving (AC-C3, AC-P4.3)", () => {
  const confirmWith = async (answers: Answer[]) => {
    const mounted = await open(answers);
    await toReview(mounted);
    await click(mounted.root, "Confirmar concessão");
    return mounted;
  };

  it("200 with created false says it was the same request", async () => {
    const mounted = await confirmWith([
      granted({ created: false }, 200),
      report([]),
    ]);

    expect(shown(mounted)).toContain(GRANT_REPEATED);
  });

  it("outcomeRecorded false says that it was done and the result was not recorded, never that it failed, and reads the state", async () => {
    const mounted = await confirmWith([
      granted({ outcomeRecorded: false }),
      report([inForce("0199c0c0-0000-7000-8000-0000000000ff")]),
    ]);

    expect(alertOf(mounted.root)?.textContent).toBe(OUTCOME_NOT_RECORDED);
    expect(OUTCOME_NOT_RECORDED).toContain("A ação foi feita");
    expect(OUTCOME_NOT_RECORDED.toLowerCase()).not.toContain("falh");
    expect(mounted.calls).toHaveLength(4);
    expect(buttons(mounted.root, "Encerrar concessão")).toHaveLength(1);
  });

  it.each([
    ["invalid_key", "não está no catálogo"],
    ["invalid_value", "O valor não foi aceito"],
    ["invalid_period", "O prazo não foi aceito"],
    ["grant_too_long", "passa do máximo de 366 dias"],
    ["invalid_reason", "O motivo não foi aceito"],
    ["invalid_actor", "não está aberto ou não é desta loja"],
  ])(
    "400 %s is said in words in the form, with what was typed kept and nothing sent again",
    async (code, part) => {
      const mounted = await confirmWith([refusal(code, 400)]);

      const text = shown(mounted);
      expect(text).toContain(part);
      expect(text).not.toMatch(TECHNICAL_TEXT);
      expect(byId(mounted.root, "concessao-motivo").value).toBe(
        "Compensação pela queda"
      );
      expect(byId(mounted.root, "concessao-horas").value).toBe("48");
      expect(writes(mounted.calls)).toHaveLength(1);
      expect(mounted.document.activeElement?.getAttribute("id")).toBe(
        "concessao-erro"
      );
    }
  );

  it("a 400 without a code is the generic refusal, not a code", async () => {
    const mounted = await confirmWith([json({}, 400)]);

    expect(shown(mounted)).toContain("Nada foi mudado. Recarregue o caso.");
    expect(shown(mounted)).not.toMatch(TECHNICAL_TEXT);
  });

  it("403 says that there is no permission, and the button is back", async () => {
    const mounted = await confirmWith([refusal("forbidden", 403)]);

    expect(alertOf(mounted.root)?.textContent).toBe(PROBLEM_TEXT.forbidden);
    expect(
      firstButton(mounted.root, "Confirmar concessão").getAttribute(
        "aria-disabled"
      )
    ).toBe("false");
  });

  it("404 says that the case was not found and that nothing was given", async () => {
    const mounted = await confirmWith([refusal("not_found", 404)]);

    expect(alertOf(mounted.root)?.textContent).toBe(
      "Este caso não foi encontrado. Nada foi dado."
    );
  });

  it("409 says to try again, without a technical error, and the same request can be sent again", async () => {
    const mounted = await confirmWith([
      refusal("grant_id_conflict", 409),
      granted({ created: false }, 200),
      report([]),
    ]);

    expect(alertOf(mounted.root)?.textContent).toBe(GRANT_RETRY);
    expect(GRANT_RETRY).toContain("Tente de novo");
    expect(shown(mounted)).not.toMatch(TECHNICAL_TEXT);

    await click(mounted.root, "Confirmar concessão");
    const [first, second] = writes(mounted.calls);
    expect(bodyOf(second).commandId).toBe(bodyOf(first).commandId);
  });

  it("429 says how long to wait, with no new try by itself", async () => {
    const mounted = await confirmWith([
      refusal("rate_limited", 429, { "retry-after": "180" }),
    ]);

    expect(alertOf(mounted.root)?.textContent).toBe(
      "Limite de consultas por hora atingido. Tente de novo em 3 minutos."
    );
    expect(writes(mounted.calls)).toHaveLength(1);
  });

  it.each([
    ["503", () => refusal("unavailable", 503)],
    ["500", () => refusal("internal_error", 500)],
    ["a network failure", () => new Error("offline")],
    ["an answer that is not the grant", () => json({ surprise: true }, 201)],
  ])(
    "%s says that it could not be confirmed and asks to read the grants first",
    async (_name, answer) => {
      const mounted = await confirmWith([answer()]);

      expect(alertOf(mounted.root)?.textContent).toBe(GRANT_UNKNOWN);
      expect(shown(mounted)).not.toMatch(TECHNICAL_TEXT);
      expect(buttons(mounted.root, "Reler as concessões")).toHaveLength(1);
      expect(writes(mounted.calls)).toHaveLength(1);
    }
  );

  it("401 says that the session is over", async () => {
    const mounted = await confirmWith([refusal("unauthenticated", 401)]);

    expect(alertOf(mounted.root)?.textContent).toBe(PROBLEM_TEXT.session);
  });
});

describe("ending a grant (AC-P4.4)", () => {
  const withList = async (answers: Answer[]) => {
    const mounted = await open([
      report([inForce(GRANT), inForce(OTHER_GRANT, "goals.active.max")]),
      ...answers,
    ]);
    await click(mounted.root, "Ver concessões em vigor");
    return mounted;
  };

  it("asks first, with the text of the cut, the store, the case and what stays in the audit, and sends nothing", async () => {
    const mounted = await withList([]);

    await click(mounted.root, "Encerrar concessão");
    const all = shown(mounted);
    const text = all.slice(all.indexOf("Revise antes de encerrar"));

    for (const part of [
      "STAGING",
      "Loja da Ana",
      "Dono pediu mais variantes por uma semana",
      "A loja volta ao que o plano dá para Variantes ativas.",
      END_EFFECT,
      END_UNDO,
      "O encerramento fica na auditoria com o seu e-mail e o caso.",
    ]) {
      expect(text).toContain(part);
    }
    expect(END_EFFECT).toBe(
      "Encerrar a concessão devolve a loja ao que o plano dá. Não poderá ser desfeito; uma nova concessão é outra decisão registrada."
    );
    expect(writes(mounted.calls)).toHaveLength(0);
    expect(mounted.document.activeElement?.textContent).toBe(
      "Revise antes de encerrar"
    );

    await click(mounted.root, "Voltar");
    expect(
      buttons(mounted.root, "Confirmar encerramento da concessão")
    ).toHaveLength(0);
    expect(writes(mounted.calls)).toHaveLength(0);
  });

  it("ends by the ID of the grant that was listed, once, and reads the diagnostics again once", async () => {
    const mounted = await withList([
      json({ outcomeRecorded: true, revoked: true }),
      report([inForce(OTHER_GRANT, "goals.active.max")]),
    ]);

    await click(mounted.root, "Encerrar concessão");
    const confirm = firstButton(
      mounted.root,
      "Confirmar encerramento da concessão"
    );
    confirm.click();
    confirm.click();
    await flush();

    expect(writes(mounted.calls)).toHaveLength(1);
    expect(mounted.calls[3]?.path).toBe(
      `/api/support-cases/${CASE}/entitlement-grants/${GRANT}`
    );
    expect(mounted.calls[3]?.init.method).toBe("DELETE");
    expect(mounted.calls[3]?.init.body).toBeUndefined();
    expect(mounted.calls[4]?.path).toBe(
      `/api/organizations/${STORE}/diagnostics`
    );
    expect(mounted.calls).toHaveLength(5);
    expect(shown(mounted)).toContain("Concessão encerrada às 12:07.");
    expect(buttons(mounted.root, "Encerrar concessão")).toHaveLength(1);
  });

  it("ends the one that was chosen, not the first", async () => {
    const mounted = await withList([
      json({ outcomeRecorded: true, revoked: true }),
      report([]),
    ]);

    const [, other] = buttons(mounted.root, "Encerrar concessão");
    other?.click();
    await flush();
    await click(mounted.root, "Confirmar encerramento da concessão");

    expect(mounted.calls[3]?.path).toBe(
      `/api/support-cases/${CASE}/entitlement-grants/${OTHER_GRANT}`
    );
  });

  it("says Nada foi encerrado. when the server ended nothing (another store, none, or already over), and reads again", async () => {
    const mounted = await withList([
      json({ outcomeRecorded: true, revoked: false }),
      report([]),
    ]);

    await click(mounted.root, "Encerrar concessão");
    await click(mounted.root, "Confirmar encerramento da concessão");

    expect(alertOf(mounted.root)?.textContent).toBe(NOTHING_ENDED);
    expect(NOTHING_ENDED).toBe("Nada foi encerrado.");
    expect(shown(mounted)).toContain(NO_GRANTS);
  });

  it("says Nada foi encerrado. for a 404 too", async () => {
    const mounted = await withList([refusal("not_found", 404), report([])]);

    await click(mounted.root, "Encerrar concessão");
    await click(mounted.root, "Confirmar encerramento da concessão");

    expect(alertOf(mounted.root)?.textContent).toBe(NOTHING_ENDED);
  });

  it("outcomeRecorded false says that it was done and the result was not recorded", async () => {
    const mounted = await withList([
      json({ outcomeRecorded: false, revoked: true }),
      report([]),
    ]);

    await click(mounted.root, "Encerrar concessão");
    await click(mounted.root, "Confirmar encerramento da concessão");

    expect(alertOf(mounted.root)?.textContent).toBe(OUTCOME_NOT_RECORDED);
    expect(shown(mounted)).toContain(NO_GRANTS);
  });

  it.each([
    ["403", () => refusal("forbidden", 403), PROBLEM_TEXT.forbidden],
    [
      "429",
      () => refusal("rate_limited", 429, { "retry-after": "60" }),
      "Limite de consultas por hora atingido. Tente de novo em 1 minuto.",
    ],
    ["401", () => refusal("unauthenticated", 401), PROBLEM_TEXT.session],
    ["503", () => refusal("unavailable", 503), END_UNKNOWN],
    ["a network failure", () => new Error("offline"), END_UNKNOWN],
  ])(
    "%s is said in words and nothing is repeated by itself",
    async (_name, answer, sentence) => {
      const mounted = await withList([answer()]);

      await click(mounted.root, "Encerrar concessão");
      await click(mounted.root, "Confirmar encerramento da concessão");

      expect(alertOf(mounted.root)?.textContent).toBe(sentence);
      expect(shown(mounted)).not.toMatch(TECHNICAL_TEXT);
      expect(writes(mounted.calls)).toHaveLength(1);
    }
  );
});

describe("what the panel writes and keeps (AC-C6, AC-C7)", () => {
  it.each(HOSTILE)(
    "writes the reason %j as text, creates no element but the page's own and moves nowhere",
    async (hostile) => {
      const mounted = await open([]);
      await toReview(mounted, { reason: hostile });

      expect(shown(mounted)).toContain(hostile.trim());
      for (const tag of NEVER_CREATED) {
        expect(mounted.document.created).not.toContain(tag);
      }
      expect(mounted.navigations).toEqual([]);
      expect(
        allElements(mounted.root).some((element) =>
          [...element.attributes.keys()].some((name) => name.startsWith("on"))
        )
      ).toBe(false);
    }
  );
});
