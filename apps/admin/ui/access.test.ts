import { describe, expect, it } from "vitest";
import { PROBLEM_TEXT } from "./api";
import { brasiliaMomentText } from "./format";
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
} from "./test-page";
import type { SupportCaseDetail } from "./types";
import {
  ACCESS_MINUTES,
  ACCESS_TEXT,
  ACCESS_UNDO,
  ACCESS_UNKNOWN,
  END_ACCESS_UNDO,
  END_UNKNOWN,
  NO_ACCESS,
  NO_CUSTOMERS,
  NOTHING_ENDED,
  READ_AUDIT,
} from "./views/access";

/**
 * Giving and ending a temporary access and reading the masked customers on the screen of a support case (corte
 * admin-v2, Parte 5): the capability that hides the section (AC-C1), the sentences and the end the server gave
 * (AC-P5.1), the masked list by cursor and only with an access in force (AC-P5.2), the list leaving the page when the
 * access ends, runs out or the case closes (AC-P5.3), nothing of a customer in the address, title, storage or any
 * request (AC-P5.4), the audit sentence (AC-P5.5), one request per click (AC-C2) and the text as text (AC-C7).
 */

const CASE = "0199a0a0-0000-7000-8000-00000000c0de";
const STORE = "0199a0a0-0000-7000-8000-0000000000a1";
const GRANT = "0199d0d0-0000-7000-8000-0000000000a1";
const OTHER = "0199a0a0-0000-7000-8000-000000000002";
const NEXT = "0199e0e0-0000-7000-8000-0000000000b2";
const ENDS = "2026-10-28T18:45:00.000Z";
const NOW = "2026-10-28T15:07:00.000Z";
const OPERATOR = {
  ...OWNER,
  capabilities: [
    "support_case:manage",
    "tenant_access:grant",
    "tenant_data:read",
  ],
};
const REVEAL_WORD = /revelar|reveal/i;
const REVEAL_PATH = /reveal/;
const UUID_TEXT = /[0-9a-f-]{36}/g;
const PLAIN_PATH = /^\/api\/[a-z/{}?=&0-9-]+$/;
const HOSTILE = [
  "<img src=x onerror=alert(1)>",
  "<script>alert(1)</script>",
  "javascript:alert(1)",
  "‮abc",
  '"><svg onload=1>',
];
const TECHNICAL_TEXT =
  /tenant_access_denied|invalid_[a-z]+|case_not_open|unknown_case|\b4\d\d\b|\b50\d\b/;

type Grant = SupportCaseDetail["grants"][number];

const grantRow = (overrides: Partial<Grant> = {}): Grant => ({
  active: true,
  expiresAt: ENDS,
  id: GRANT,
  principalId: OWNER.principal.id,
  revokedAt: null,
  startsAt: "2026-10-28T14:00:00.000Z",
  ...overrides,
});

function detail(
  grants: Grant[] = [],
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
      reason: "Dono não acha um cliente",
      resolution: null,
      status: "open",
      ...overrides,
    },
    grants,
  };
}

const closedDetail = (grants: Grant[] = []) =>
  detail(grants, {
    closedAt: "2026-10-28T15:00:00.000Z",
    resolution: "Resolvido",
    status: "closed",
  });

const customer = (name: string, id: string, overrides = {}) => ({
  archived: false,
  email: "m***@e***.br",
  hasNotes: true,
  id,
  name,
  phone: "***",
  ...overrides,
});

const page = (customers: unknown[], next: string | null = null) =>
  json({ customers, next });

const refusal = (error: string, status: number, headers?: HeadersInit) =>
  new Response(JSON.stringify({ error }), {
    headers: { "content-type": "application/json", ...headers },
    status,
  });

const accessGiven = () =>
  json(
    {
      caseId: CASE,
      expiresAt: ENDS,
      id: GRANT,
      organizationId: STORE,
      startsAt: NOW,
    },
    201
  );

const clock = { now: new Date(NOW) };

const open = (
  answers: Answer[],
  caseDetail: SupportCaseDetail = detail(),
  who = OPERATOR
) => {
  clock.now = new Date(NOW);
  return mount(
    [json(caseDetail), ...answers],
    json(who),
    () => clock.now,
    screenContext({ id: CASE, screen: "caso" })
  );
};

const openActive = (answers: Answer[], who = OPERATOR) =>
  open(answers, detail([grantRow()]), who);

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
const customerCalls = (calls: Call[]) =>
  calls.filter((call) => call.path.includes("/customers"));
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

const sectionOf = (mounted: Mounted) =>
  allElements(mounted.root).find(
    (element) => element.getAttribute("aria-labelledby") === "acesso-titulo"
  );

const toReview = async (mounted: Mounted, minutes = "60") => {
  await click(mounted.root, "Dar acesso aos clientes");
  byId(mounted.root, "acesso-minutos").value = minutes;
  await click(mounted.root, "Revisar o acesso");
};

describe("the section's place on the case screen (AC-C1)", () => {
  it("is not on the screen without tenant_access:grant or tenant_data:read, and asks for nothing besides the case", async () => {
    const mounted = await open([], detail(), {
      ...OWNER,
      capabilities: ["support_case:manage"],
    });

    expect(shown(mounted)).not.toContain("Ver clientes da loja");
    expect(mounted.calls.map((call) => call.path)).toEqual([
      "/api/whoami",
      `/api/support-cases/${CASE}`,
    ]);
  });

  it("shows only what each capability allows", async () => {
    const readOnly = await open([], detail([grantRow()]), {
      ...OWNER,
      capabilities: ["support_case:manage", "tenant_data:read"],
    });
    expect(buttons(readOnly.root, "Ver clientes")).toHaveLength(1);
    expect(buttons(readOnly.root, "Encerrar acesso agora")).toHaveLength(0);
    expect(buttons(readOnly.root, "Dar acesso aos clientes")).toHaveLength(0);

    const grantOnly = await open([], detail([grantRow()]), {
      ...OWNER,
      capabilities: ["support_case:manage", "tenant_access:grant"],
    });
    expect(buttons(grantOnly.root, "Ver clientes")).toHaveLength(0);
    expect(shown(grantOnly)).not.toContain(READ_AUDIT);
    expect(buttons(grantOnly.root, "Encerrar acesso agora")).toHaveLength(1);
  });

  it("is not on the screen of a privacy case", async () => {
    const mounted = await open([], detail([], { kind: "privacy" }));

    expect(shown(mounted)).not.toContain("Ver clientes da loja");
  });
});

describe("giving an access (AC-P5.1, AC-C2, AC-C3)", () => {
  it("says what it is before the first click, with no access and no read of customers", async () => {
    const mounted = await open([]);

    expect(shown(mounted)).toContain(NO_ACCESS);
    expect(shown(mounted)).toContain(ACCESS_TEXT);
    expect(buttons(mounted.root, "Ver clientes")).toHaveLength(0);
    expect(customerCalls(mounted.calls)).toEqual([]);
  });

  it("offers 5 to 240 minutes, 60 first chosen, and shows the review with the store, the case and the three lines", async () => {
    const mounted = await open([]);
    await click(mounted.root, "Dar acesso aos clientes");

    const select = byId(mounted.root, "acesso-minutos");
    expect(select.value).toBe("60");
    expect(
      byTag(select, "option").map((option) =>
        Number(option.getAttribute("value"))
      )
    ).toEqual([...ACCESS_MINUTES]);
    expect(Math.min(...ACCESS_MINUTES)).toBe(5);
    expect(Math.max(...ACCESS_MINUTES)).toBe(240);

    select.value = "30";
    await click(mounted.root, "Revisar o acesso");
    const text = shown(mounted);
    expect(text).toContain("Revise antes de dar o acesso");
    expect(text).toContain("STAGING");
    expect(text).toContain("Loja da Ana");
    expect(text).toContain("Dono não acha um cliente");
    expect(text).toContain("por 30 minutos");
    expect(text).toContain(ACCESS_UNDO);
    expect(text).toContain("Fica na auditoria");
    expect(writes(mounted.calls)).toEqual([]);
  });

  it("does not take a duration the page did not offer", async () => {
    const mounted = await open([]);
    await click(mounted.root, "Dar acesso aos clientes");
    byId(mounted.root, "acesso-minutos").value = "9999";
    await click(mounted.root, "Revisar o acesso");

    expect(shown(mounted)).not.toContain("Revise antes");
    expect(writes(mounted.calls)).toEqual([]);
  });

  it("sends the minutes and says the end the server gave, never one it worked out", async () => {
    const mounted = await open([accessGiven(), json(detail([grantRow()]))]);
    await toReview(mounted, "30");
    await click(mounted.root, "Confirmar acesso");

    const [post] = writes(mounted.calls);
    expect(post?.path).toBe(`/api/support-cases/${CASE}/access`);
    expect(bodyOf(post)).toEqual({ minutes: 30 });
    // the browser's clock says 15:07 and 30 minutes would be 15:37; the server said 18:45 (15:45 in Brasília)
    expect(brasiliaMomentText(ENDS)).toBe("28/10/2026 15:45");
    expect(shown(mounted)).toContain("Acesso dado. Acaba em 28/10/2026 15:45.");
    expect(shown(mounted)).not.toContain("15:37");
    expect(shown(mounted)).toContain("Acesso ativo até 28/10/2026 15:45");
    expect(buttons(mounted.root, "Ver clientes")).toHaveLength(1);
    expect(buttons(mounted.root, "Dar acesso aos clientes")).toHaveLength(0);
    expect(customerCalls(mounted.calls)).toEqual([]);
  });

  it("sends one request for a double click", async () => {
    const slow = pending();
    const mounted = await open([slow.answer, json(detail([grantRow()]))]);
    await toReview(mounted);
    const confirm = firstButton(mounted.root, "Confirmar acesso");
    confirm.click();
    confirm.click();
    await flush();

    expect(writes(mounted.calls)).toHaveLength(1);
    expect(confirm.getAttribute("aria-disabled")).toBe("true");
    slow.release(accessGiven());
    await flush();
    expect(writes(mounted.calls)).toHaveLength(1);
  });

  it.each([
    ["case_not_open", 400, "O atendimento já está fechado. Nada foi dado."],
    [
      "unknown_case",
      400,
      "Este atendimento não foi encontrado. Nada foi dado.",
    ],
    [
      "invalid_duration",
      400,
      "A duração não foi aceita: use de 5 a 240 minutos. Nada foi dado.",
    ],
    ["forbidden", 403, PROBLEM_TEXT.forbidden],
    ["tenant_access_denied", 403, PROBLEM_TEXT.forbidden],
    ["internal_error", 500, ACCESS_UNKNOWN],
  ])("says the refusal %s in words", async (code, status, text) => {
    const answers: Answer[] = [refusal(code, status)];
    if (code === "case_not_open") {
      answers.push(json(closedDetail()));
    }
    const mounted = await open(answers);
    await toReview(mounted);
    await click(mounted.root, "Confirmar acesso");

    expect(alertOf(mounted.root)?.textContent).toBe(text);
    expect(shown(mounted)).not.toMatch(TECHNICAL_TEXT);
  });

  it("says a 429 with the wait the server gave, and a failed call without an answer as not confirmed", async () => {
    const limited = await open([
      refusal("rate_limited", 429, { "retry-after": "120" }),
    ]);
    await toReview(limited);
    await click(limited.root, "Confirmar acesso");
    expect(alertOf(limited.root)?.textContent).toContain("2 minutos");

    const lost = await open([new TypeError("Failed to fetch")]);
    await toReview(lost);
    await click(lost.root, "Confirmar acesso");
    expect(alertOf(lost.root)?.textContent).toBe(ACCESS_UNKNOWN);
    expect(buttons(lost.root, "Reler o atendimento")).toHaveLength(1);
  });

  it("reads the case again after a refusal that changes it (the case closed meanwhile)", async () => {
    const mounted = await open([
      refusal("case_not_open", 400),
      json(closedDetail()),
    ]);
    await toReview(mounted);
    await click(mounted.root, "Confirmar acesso");

    expect(mounted.calls.map((call) => call.path).at(-1)).toBe(
      `/api/support-cases/${CASE}`
    );
    expect(shown(mounted)).toContain("O atendimento está fechado");
    expect(buttons(mounted.root, "Dar acesso aos clientes")).toHaveLength(0);
  });
});

describe("the masked customers (AC-P5.2, AC-P5.5, AC-C5)", () => {
  it("reads nothing when the screen opens, says once that each page is audited and reads on the click", async () => {
    const mounted = await openActive([
      page([
        customer("M*** S***", "c1"),
        customer("A***", "c2", { email: null, hasNotes: false, phone: null }),
      ]),
    ]);
    expect(customerCalls(mounted.calls)).toEqual([]);
    expect(shown(mounted).split(READ_AUDIT)).toHaveLength(2);

    await click(mounted.root, "Ver clientes");

    const [read] = customerCalls(mounted.calls);
    expect(read?.path).toBe(`/api/support-cases/${CASE}/customers?limit=50`);
    expect(read?.init.method).toBe("GET");
    const text = shown(mounted);
    expect(text).toContain("M*** S***");
    expect(text).toContain("m***@e***.br");
    expect(text).toContain("***");
    expect(text).toContain("tem observações");
    expect(text).toContain("sem observações");
    expect(text).toContain("sem e-mail");
    expect(text).toContain("sem telefone");
    expect(text).toContain("Fim da lista.");
    expect(buttons(mounted.root, "Carregar mais")).toHaveLength(0);
    expect(text.split(READ_AUDIT)).toHaveLength(2);
  });

  it("loads the next page by the cursor the server gave and keeps the first", async () => {
    const mounted = await openActive([
      page([customer("P*** U***", "c1")], NEXT),
      page([customer("S*** L***", "c3")]),
    ]);
    await click(mounted.root, "Ver clientes");
    expect(shown(mounted)).toContain("1 cliente lido.");
    await click(mounted.root, "Carregar mais");

    const [, second] = customerCalls(mounted.calls);
    expect(second?.path).toBe(
      `/api/support-cases/${CASE}/customers?limit=50&after=${NEXT}`
    );
    const text = shown(mounted);
    expect(text).toContain("P*** U***");
    expect(text).toContain("S*** L***");
    expect(text).toContain("2 clientes lidos.");
    expect(buttons(mounted.root, "Carregar mais")).toHaveLength(0);
  });

  it("asks one page at a time for a double click", async () => {
    const slow = pending();
    const mounted = await openActive([slow.answer]);
    const read = firstButton(mounted.root, "Ver clientes");
    read.click();
    read.click();
    await flush();

    expect(customerCalls(mounted.calls)).toHaveLength(1);
    slow.release(page([]));
    await flush();
    expect(shown(mounted)).toContain(NO_CUSTOMERS);
  });

  it("does not take a page that is not a page of masked customers", async () => {
    const mounted = await openActive([
      json({ customers: [{ id: 1 }], next: null }),
    ]);
    await click(mounted.root, "Ver clientes");

    expect(alertOf(mounted.root)?.textContent).toBe(PROBLEM_TEXT.failed);
    expect(shown(mounted)).not.toContain("clientes lidos");
  });

  it.each([
    ["no access at all", detail()],
    [
      "an access that is another operator's",
      detail([grantRow({ principalId: OTHER })]),
    ],
    [
      "an access the server says is not in force",
      detail([grantRow({ active: false })]),
    ],
    [
      "an access already ended",
      detail([
        grantRow({ active: false, revokedAt: "2026-10-28T14:30:00.000Z" }),
      ]),
    ],
    ["a closed case", closedDetail([grantRow({ active: false })])],
  ])(
    "does not offer the read and does not call the route with %s",
    async (_name, caseDetail) => {
      const mounted = await open([], caseDetail);

      expect(shown(mounted)).toContain(NO_ACCESS);
      expect(buttons(mounted.root, "Ver clientes")).toHaveLength(0);
      expect(buttons(mounted.root, "Carregar mais")).toHaveLength(0);
      expect(customerCalls(mounted.calls)).toEqual([]);
    }
  );

  it("writes every customer text as text, whatever it says", async () => {
    const mounted = await openActive([
      page(
        HOSTILE.map((name, index) =>
          customer(name, `c${index}`, { email: name })
        )
      ),
    ]);
    await click(mounted.root, "Ver clientes");

    for (const text of HOSTILE) {
      expect(shown(mounted)).toContain(text);
    }
    expect(
      mounted.document.created.filter((tag) =>
        ["script", "img", "svg", "iframe", "style"].includes(tag)
      )
    ).toEqual([]);
    expect(
      allElements(mounted.root).filter(
        (element) =>
          element.tagName === "a" &&
          element.getAttribute("href")?.startsWith("javascript")
      )
    ).toEqual([]);
  });
});

describe("the list leaves the page (AC-P5.3)", () => {
  const listed = async (answers: Answer[] = []) => {
    const mounted = await openActive([
      page([customer("M*** S***", "c1")], NEXT),
      ...answers,
    ]);
    await click(mounted.root, "Ver clientes");
    expect(shown(mounted)).toContain("M*** S***");
    return mounted;
  };

  const gone = (mounted: Mounted) => {
    expect(shown(mounted)).not.toContain("M*** S***");
    expect(shown(mounted)).not.toContain("m***@e***.br");
    expect(shown(mounted)).toContain(NO_ACCESS);
    expect(buttons(mounted.root, "Carregar mais")).toHaveLength(0);
    expect(buttons(mounted.root, "Ver clientes")).toHaveLength(0);
    expect(
      allElements(mounted.root).filter((element) =>
        element.textContent.includes("M*** S***")
      )
    ).toEqual([]);
  };

  it("takes the rows off the page, and reads no more, once the server's end has passed at the next interaction", async () => {
    const mounted = await listed();
    clock.now = new Date("2026-10-28T18:45:00.000Z");
    const section = sectionOf(mounted);
    section?.dispatch("pointerdown");

    gone(mounted);
    expect(customerCalls(mounted.calls)).toHaveLength(1);
  });

  it("takes the rows off the page when the button is used after the end", async () => {
    const mounted = await listed();
    clock.now = new Date("2026-10-28T19:00:00.000Z");
    firstButton(mounted.root, "Carregar mais").click();
    await flush();

    gone(mounted);
    expect(customerCalls(mounted.calls)).toHaveLength(1);
  });

  it("keeps the rows while the end has not passed", async () => {
    const mounted = await listed();
    clock.now = new Date("2026-10-28T18:44:59.000Z");
    sectionOf(mounted)?.dispatch("focusin");

    expect(shown(mounted)).toContain("M*** S***");
  });

  it("takes the rows off when the server refuses the next page for the access, and reads the case again", async () => {
    const mounted = await listed([
      refusal("tenant_access_denied", 403),
      json(detail([grantRow({ active: false })])),
    ]);
    await click(mounted.root, "Carregar mais");

    gone(mounted);
    expect(mounted.calls.map((call) => call.path).at(-1)).toBe(
      `/api/support-cases/${CASE}`
    );
    expect(alertOf(mounted.root)?.textContent).toBe(NO_ACCESS);
  });

  it("says a missing capability as missing, and takes the rows off", async () => {
    const mounted = await listed([refusal("forbidden", 403)]);
    await click(mounted.root, "Carregar mais");

    expect(alertOf(mounted.root)?.textContent).toBe(PROBLEM_TEXT.forbidden);
    expect(shown(mounted)).not.toContain("M*** S***");
  });

  it("takes the rows off when the case is closed, and no customer is read again", async () => {
    const mounted = await listed([
      json({ changed: true, id: CASE, status: "closed" }),
      json(closedDetail([grantRow({ active: false })])),
    ]);
    await click(mounted.root, "Fechar atendimento");
    await click(mounted.root, "Revisar o fechamento");
    await click(mounted.root, "Confirmar o fechamento do atendimento");

    expect(shown(mounted)).toContain("Atendimento fechado");
    gone(mounted);
    expect(customerCalls(mounted.calls)).toHaveLength(1);
  });

  it("takes the rows off the page when the page is hidden", async () => {
    const mounted = await listed();
    mounted.document.defaultView.dispatch("pagehide");

    expect(shown(mounted)).not.toContain("M*** S***");
    expect(shown(mounted)).toContain(
      "Recarregue o atendimento para continuar."
    );
    expect(buttons(mounted.root, "Carregar mais")).toHaveLength(0);
  });
});

describe("the access in the middle of an answer", () => {
  it("does not send a second grant while the case is read again", async () => {
    const reread = pending();
    const mounted = await open([accessGiven(), reread.answer]);
    await toReview(mounted);
    const confirm = firstButton(mounted.root, "Confirmar acesso");
    confirm.click();
    await flush();
    confirm.click();
    await flush();

    expect(writes(mounted.calls)).toHaveLength(1);
    reread.release(json(detail([grantRow()])));
    await flush();
    expect(writes(mounted.calls)).toHaveLength(1);
  });

  it("does not end twice while the case is read again", async () => {
    const reread = pending();
    const mounted = await open(
      [json({ revoked: true }), reread.answer],
      detail([grantRow()])
    );
    await click(mounted.root, "Encerrar acesso agora");
    const confirm = firstButton(
      mounted.root,
      "Confirmar encerramento do acesso"
    );
    confirm.click();
    await flush();
    confirm.click();
    await flush();

    expect(writes(mounted.calls)).toHaveLength(1);
    reread.release(json(detail([grantRow({ active: false })])));
    await flush();
    expect(writes(mounted.calls)).toHaveLength(1);
  });

  it("does not let a page read that comes back after the page was hidden put the rows back", async () => {
    const slow = pending();
    const mounted = await openActive([slow.answer]);
    firstButton(mounted.root, "Ver clientes").click();
    await flush();
    mounted.document.defaultView.dispatch("pagehide");
    slow.release(page([customer("M*** S***", "c1")]));
    await flush();

    expect(shown(mounted)).not.toContain("M*** S***");
    expect(shown(mounted)).toContain(
      "Recarregue o atendimento para continuar."
    );
    expect(buttons(mounted.root, "Dar acesso aos clientes")).toHaveLength(0);
  });

  it("does not free the lock of a write that is still on its way when the end passes", async () => {
    const slow = pending();
    const mounted = await openActive([slow.answer]);
    await click(mounted.root, "Encerrar acesso agora");
    const confirm = firstButton(
      mounted.root,
      "Confirmar encerramento do acesso"
    );
    confirm.click();
    await flush();
    clock.now = new Date("2026-10-28T19:00:00.000Z");
    sectionOf(mounted)?.dispatch("pointerdown");
    await click(mounted.root, "Dar acesso aos clientes");
    confirm.click();
    await flush();

    expect(writes(mounted.calls)).toHaveLength(1);
  });
});

describe("ending the access now (AC-P5.3, AC-C2, AC-C4)", () => {
  it("asks for a confirmation that says the effect, how it is undone and what stays in the record", async () => {
    const withAccess = await open([], detail([grantRow()]));
    await click(withAccess.root, "Encerrar acesso agora");

    const text = shown(withAccess);
    expect(text).toContain("Revise antes de encerrar o acesso");
    expect(text).toContain("Loja da Ana");
    expect(text).toContain(END_ACCESS_UNDO);
    expect(text).toContain("Fica na auditoria");
    expect(writes(withAccess.calls)).toEqual([]);
    expect(withAccess.calls).toHaveLength(2);
  });

  it("ends by the ID the case's read gave, takes the list off and reads the case again", async () => {
    const mounted = await open(
      [
        page([customer("M*** S***", "c1")]),
        json({ revoked: true }),
        json(detail([grantRow({ active: false, revokedAt: NOW })])),
      ],
      detail([grantRow()])
    );
    await click(mounted.root, "Ver clientes");
    await click(mounted.root, "Encerrar acesso agora");
    await click(mounted.root, "Confirmar encerramento do acesso");

    const [end] = writes(mounted.calls);
    expect(end?.path).toBe(`/api/tenant-access/${GRANT}`);
    expect(end?.init.method).toBe("DELETE");
    expect(shown(mounted)).toContain(
      "Acesso encerrado. A lista de clientes saiu da tela."
    );
    expect(shown(mounted)).not.toContain("M*** S***");
    expect(shown(mounted)).toContain(NO_ACCESS);
    expect(buttons(mounted.root, "Dar acesso aos clientes")).toHaveLength(1);
  });

  it("sends one request for a double click", async () => {
    const slow = pending();
    const mounted = await open(
      [slow.answer, json(detail())],
      detail([grantRow()])
    );
    await click(mounted.root, "Encerrar acesso agora");
    const confirm = firstButton(
      mounted.root,
      "Confirmar encerramento do acesso"
    );
    confirm.click();
    confirm.click();
    await flush();

    expect(writes(mounted.calls)).toHaveLength(1);
    slow.release(json({ revoked: true }));
    await flush();
    expect(writes(mounted.calls)).toHaveLength(1);
  });

  it("says nothing was ended when the access had already ended, and reads the case again", async () => {
    const mounted = await open(
      [json({ revoked: false }), json(detail([grantRow({ active: false })]))],
      detail([grantRow()])
    );
    await click(mounted.root, "Encerrar acesso agora");
    await click(mounted.root, "Confirmar encerramento do acesso");

    expect(alertOf(mounted.root)?.textContent).toBe(NOTHING_ENDED);
    expect(shown(mounted)).toContain(NO_ACCESS);
  });

  it("says a 404 as nothing ended, a 403 as no permission, and a lost answer as not confirmed", async () => {
    const missing = await open(
      [refusal("not_found", 404), json(detail())],
      detail([grantRow()])
    );
    await click(missing.root, "Encerrar acesso agora");
    await click(missing.root, "Confirmar encerramento do acesso");
    expect(alertOf(missing.root)?.textContent).toBe(NOTHING_ENDED);

    const denied = await open(
      [refusal("forbidden", 403)],
      detail([grantRow()])
    );
    await click(denied.root, "Encerrar acesso agora");
    await click(denied.root, "Confirmar encerramento do acesso");
    expect(alertOf(denied.root)?.textContent).toBe(PROBLEM_TEXT.forbidden);

    const lost = await open(
      [new TypeError("Failed to fetch")],
      detail([grantRow()])
    );
    await click(lost.root, "Encerrar acesso agora");
    await click(lost.root, "Confirmar encerramento do acesso");
    expect(alertOf(lost.root)?.textContent).toBe(END_UNKNOWN);
    expect(shown(lost)).not.toMatch(TECHNICAL_TEXT);
  });

  it("goes back from the confirmation without sending", async () => {
    const mounted = await open([], detail([grantRow()]));
    await click(mounted.root, "Encerrar acesso agora");
    await click(mounted.root, "Voltar");

    expect(shown(mounted)).not.toContain("Revise antes de encerrar");
    expect(writes(mounted.calls)).toEqual([]);
  });
});

describe("no trace of a customer (AC-P5.4, AC-C6)", () => {
  it("leaves nothing in the address, the title, the storage or any request, and has no control to reveal", async () => {
    const mounted = await open(
      [
        page([customer("M*** S***", "c1", { email: "m***@e***.br" })], NEXT),
        page([customer("S*** L***", "c3")]),
        json({ revoked: true }),
        json(detail()),
      ],
      detail([grantRow()])
    );
    await click(mounted.root, "Ver clientes");
    await click(mounted.root, "Carregar mais");
    await click(mounted.root, "Encerrar acesso agora");
    await click(mounted.root, "Confirmar encerramento do acesso");

    const traffic = JSON.stringify(mounted.calls);
    for (const value of ["M***", "S***", "m***@e***.br"]) {
      expect(traffic).not.toContain(value);
    }
    expect(mounted.navigations).toEqual([]);
    expect(mounted.document.body.getAttribute("title")).toBeNull();
    expect(
      allElements(mounted.root).filter((element) =>
        REVEAL_WORD.test(
          `${element.textContent} ${element.getAttribute("aria-label") ?? ""}`
        )
      )
    ).toEqual([]);
    expect(mounted.calls.filter((call) => REVEAL_PATH.test(call.path))).toEqual(
      []
    );
    expect(
      mounted.calls.every((call) =>
        call.path.replaceAll(UUID_TEXT, "{uuid}").match(PLAIN_PATH)
      )
    ).toBe(true);
  });
});
