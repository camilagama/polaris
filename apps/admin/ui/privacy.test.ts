import { describe, expect, it } from "vitest";
import { PROBLEM_TEXT } from "./api";
import {
  ACTIONS,
  CATEGORIES,
  CHANNELS,
  DECISION_REASONS,
  DECISIONS,
  dueText,
  IDENTITY_METHODS,
  IDENTITY_STATUSES,
  REQUEST_TYPES,
  REQUESTER_KINDS,
  ROLES,
  STAGES,
} from "./privacy";
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
import type { PrivacyCaseDetail, PrivacyCaseSummary } from "./types";
import {
  ACTIONS_ONLY_RECORD,
  RULES,
  STAGE_CONFLICT,
  STAGE_ORDER,
  STEP_RECORD,
  STEP_UNDO,
  STEP_UNKNOWN,
} from "./views/privacy-case";
import { OPEN_EFFECT } from "./views/privacy-new";

/**
 * The privacy screens (corte admin-v2, Parte 11) in a small DOM against a simulated API: the list with the due date
 * in words (AC-P11.1, AC-P11.6), opening a case with the closed lists and the fixed warning (AC-P11.1), and the case
 * as six steps, one open at a time, nothing chosen for the operator, each reviewed in two steps and sent once, with
 * the server's refusals said in words (AC-P11.2 to AC-P11.5), and nothing left on the page after leaving it.
 */

const CASE = "0199a0a0-0000-7000-8000-00000000c0de";
const STORE = "0199a0a0-0000-7000-8000-0000000000a1";
const CUSTOMER = "0199a0a0-0000-7000-8000-0000000000c1";
const NOW = new Date("2026-11-05T15:00:00.000Z");
const HOSTILE: readonly [string, string, string, string, string] = [
  "<img src=x onerror=alert(1)>",
  "<script>alert(1)</script>",
  "javascript:alert(1)",
  "‮abc",
  '"><svg onload=1>',
];
const TECHNICAL = /privacy_|invalid_|case_not_open|\b40\d\b|\b50\d\b/;

const PRIVACY = {
  ...OWNER,
  capabilities: [...OWNER.capabilities, "privacy_case:manage"],
};

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

const choose = (root: FakeElement, id: string, value: string) => {
  const field = byId(root, id);
  field.value = value;
  field.dispatch("change");
};

const type = (root: FakeElement, id: string, value: string) => {
  const field = byId(root, id);
  field.value = value;
  field.dispatch("input");
};

function summary(
  overrides: Partial<PrivacyCaseSummary> = {}
): PrivacyCaseSummary {
  return {
    dueAt: "2026-11-14T15:00:00.000Z",
    id: CASE,
    openedAt: "2026-10-30T15:00:00.000Z",
    organizationId: STORE,
    organizationName: "Loja da Ana",
    overdue: false,
    requesterKind: "data_subject",
    requestType: "deletion",
    stage: "role_determined",
    status: "open",
    ...overrides,
  };
}

const STAGE_FACTS: Readonly<
  Record<string, Partial<PrivacyCaseDetail["privacy"]>>
> = {
  identity_checked: {
    identityMethod: "email_ownership",
    identityStatus: "verified",
  },
  requested: {},
  role_determined: {
    identityMethod: "email_ownership",
    identityStatus: "verified",
    polarisRole: "controller",
  },
  scoped: {
    identityMethod: "email_ownership",
    identityStatus: "verified",
    polarisRole: "controller",
    scopeCategories: ["account", "customers"],
    subjectReference: "cliente-42",
  },
};

function detail(
  stage: string,
  privacy: Partial<PrivacyCaseDetail["privacy"]> = {},
  extra: Partial<PrivacyCaseDetail> = {}
): PrivacyCaseDetail {
  const decided = ["decided", "executed", "resolved"].includes(stage);
  return {
    actions: [],
    audit: [
      {
        at: "2026-10-30T15:00:00.000Z",
        detail: null,
        entityType: "support_case",
        eventType: "support_case.opened",
        principalId: OWNER.principal.id,
      },
    ],
    case: {
      closedAt: null,
      id: CASE,
      openedAt: "2026-10-30T15:00:00.000Z",
      organizationId: STORE,
      organizationName: "Loja da Ana",
      resolution: null,
      status: stage === "resolved" ? "closed" : "open",
    },
    privacy: {
      channel: "email",
      decision: decided ? "accept" : null,
      decisionNote: null,
      decisionReason: null,
      dueAt: "2026-11-14T15:00:00.000Z",
      identityMethod: null,
      identityStatus: null,
      note: "Pedido pelo e-mail de suporte",
      overdue: false,
      polarisRole: null,
      receivedAt: "2026-10-30T15:00:00.000Z",
      requesterKind: "data_subject",
      requestType: "deletion",
      resolvedAt: null,
      scopeCategories: null,
      stage,
      subjectReference: null,
      ...(decided ? STAGE_FACTS.scoped : (STAGE_FACTS[stage] ?? {})),
      ...privacy,
    },
    ...extra,
  };
}

const list = (
  answers: Answer[],
  who = PRIVACY,
  listState: "abertos" | "fechados" = "abertos"
) =>
  mount(
    answers,
    json(who),
    () => NOW,
    screenContext({ listState, screen: "privacidade" })
  );

const opening = (
  answers: Answer[],
  who = PRIVACY,
  store: string | null = STORE
) =>
  mount(
    answers,
    json(who),
    () => NOW,
    screenContext({ screen: "privacidade-novo", store })
  );

const openCase = (
  first: PrivacyCaseDetail,
  answers: Answer[] = [],
  who = PRIVACY
) =>
  mount(
    [json(first), ...answers],
    json(who),
    () => NOW,
    screenContext({ id: CASE, screen: "privacidade-caso" })
  );

const stepItems = (root: FakeElement) =>
  byTag(root, "li").filter((item) =>
    (item.getAttribute("class") ?? "").startsWith("step ")
  );

describe("the stage order of the case screen", () => {
  it("is the order of STAGES, the same codes", () => {
    expect(STAGE_ORDER).toEqual(STAGES.map(([code]) => code));
    expect(STAGE_ORDER).toHaveLength(7);
  });
});

describe("the due date in words (AC-P11.1, AC-P11.6)", () => {
  it.each([
    ["2026-11-14T15:00:00.000Z", false, "faltam 9 dias", false],
    ["2026-11-08T15:00:00.000Z", false, "faltam 3 dias", false],
    ["2026-11-07T15:00:00.000Z", false, "vence em 2 dias", true],
    ["2026-11-06T15:00:00.000Z", false, "vence em 1 dia", true],
    ["2026-11-05T23:00:00.000Z", false, "vence hoje", true],
    ["2026-11-04T15:00:00.000Z", true, "prazo vencido em 04/11/2026", true],
  ] as const)("says %s (overdue %s) as “%s”", (dueAt, overdue, text, warn) => {
    expect(dueText(dueAt, overdue, NOW)).toEqual({
      day: text.startsWith("prazo vencido") ? "04/11/2026" : expect.any(String),
      text,
      warn,
    });
  });

  it("counts calendar days in Brasília, not 24-hour periods, near midnight", () => {
    // 23:30 in Brasília, due at 00:30 two calendar days later: two days
    const lateNight = new Date("2026-11-06T02:30:00.000Z");
    expect(dueText("2026-11-07T03:30:00.000Z", false, lateNight).text).toBe(
      "vence em 2 dias"
    );
    // 40 minutes later, past midnight, same due date: one day
    const justAfter = new Date("2026-11-06T03:10:00.000Z");
    expect(dueText("2026-11-07T03:30:00.000Z", false, justAfter).text).toBe(
      "vence em 1 dia"
    );
  });

  it("says it is due today before the hour of the due moment and late after it, though the server still reads overdue=false", () => {
    const dueAt = "2026-11-05T18:00:00.000Z";
    expect(dueText(dueAt, false, new Date("2026-11-05T17:59:59.000Z"))).toEqual(
      { day: "05/11/2026", text: "vence hoje", warn: true }
    );
    expect(dueText(dueAt, false, new Date(dueAt)).text).toBe("vence hoje");
    expect(dueText(dueAt, false, new Date("2026-11-05T18:00:01.000Z"))).toEqual(
      { day: "05/11/2026", text: "prazo vencido em 05/11/2026", warn: true }
    );
  });

  it("says late on the server's mark, or once the server's day is past on the page's clock", () => {
    expect(dueText("2026-11-01T15:00:00.000Z", false, NOW).text).toBe(
      "prazo vencido em 01/11/2026"
    );
    expect(dueText("2026-11-30T15:00:00.000Z", true, NOW).text).toBe(
      "prazo vencido em 30/11/2026"
    );
  });
});

describe("Privacidade: the list (AC-P11.1)", () => {
  it("reads the open cases once, a page of 25, and shows store, request, stage and due date in words", async () => {
    const mounted = await list([
      json({
        cases: [
          summary(),
          summary({
            dueAt: "2026-11-07T15:00:00.000Z",
            id: "0199a0a0-0000-7000-8000-00000000c0df",
            stage: "scoped",
          }),
        ],
        next: null,
      }),
    ]);

    expect(mounted.calls.map((call) => call.path)).toEqual([
      "/api/whoami",
      "/api/privacy-cases?filter=open&limit=25",
    ]);
    const text = visibleText(mounted.root);
    expect(text).toContain("Loja da Ana");
    expect(text).toContain("Exclusão");
    expect(text).toContain("Titular dos dados");
    expect(text).toContain("Falta o escopo");
    expect(text).toContain("faltam 9 dias (até 14/11/2026, prazo provisório)");
    expect(text).toContain(
      "Atenção: vence em 2 dias (até 07/11/2026, prazo provisório)"
    );
    expect(text).toContain("2 atendimentos.");
    const warned = allElements(mounted.root).filter(
      (element) => element.getAttribute("class") === "due due-warn"
    );
    expect(warned).toHaveLength(1);
    const links = byTag(mounted.root, "a")
      .map((link) => link.getAttribute("href"))
      .filter((href) => href?.startsWith("/privacidade/0199"));
    expect(links).toEqual([
      `/privacidade/${CASE}`,
      "/privacidade/0199a0a0-0000-7000-8000-00000000c0df",
    ]);
  });

  describe("the due date keeps up with the clock of a page left open", () => {
    const DUE = "2026-11-05T21:00:00.000Z";
    const clock = { now: NOW };
    const standing = (dueAt = DUE) =>
      mount(
        [json({ cases: [summary({ dueAt })], next: null })],
        json(PRIVACY),
        () => clock.now,
        screenContext({ listState: "abertos", screen: "privacidade" })
      );
    const dueTexts = (root: FakeElement) =>
      allElements(root)
        .filter((element) => element.getAttribute("class") === "due-text")
        .map((element) => element.textContent);
    const dueClasses = (root: FakeElement) =>
      allElements(root)
        .filter((element) => element.getAttribute("class")?.startsWith("due"))
        .filter((element) => element.getAttribute("class") !== "due-text")
        .map((element) => element.getAttribute("class"));

    it("turns 'vence hoje' into 'prazo vencido' when the tab becomes visible again, with no new request", async () => {
      clock.now = NOW;
      const mounted = await standing();
      expect(dueTexts(mounted.root)).toEqual(["Atenção: vence hoje"]);
      const requests = mounted.calls.length;

      clock.now = new Date("2026-11-05T21:00:01.000Z");
      mounted.document.hidden = false;
      mounted.document.dispatch("visibilitychange");

      expect(dueTexts(mounted.root)).toEqual([
        "Atenção: prazo vencido em 05/11/2026",
      ]);
      expect(dueClasses(mounted.root)).toEqual(["due due-warn"]);
      expect(mounted.calls).toHaveLength(requests);
    });

    it("does the same when the window gets the focus back", async () => {
      clock.now = NOW;
      const mounted = await standing();

      clock.now = new Date("2026-11-06T12:00:00.000Z");
      mounted.document.defaultView.dispatch("focus");

      expect(dueTexts(mounted.root)).toEqual([
        "Atenção: prazo vencido em 05/11/2026",
      ]);
    });

    it("moves a row from the calm wording to the warning when the days run out", async () => {
      clock.now = NOW;
      const mounted = await standing("2026-11-14T15:00:00.000Z");
      expect(dueTexts(mounted.root)).toEqual(["faltam 9 dias"]);
      expect(dueClasses(mounted.root)).toEqual(["due"]);

      clock.now = new Date("2026-11-13T15:00:00.000Z");
      mounted.document.defaultView.dispatch("focus");

      expect(dueTexts(mounted.root)).toEqual(["Atenção: vence em 1 dia"]);
      expect(dueClasses(mounted.root)).toEqual(["due due-warn"]);
    });

    it("does not redraw while the tab is hidden", async () => {
      clock.now = NOW;
      const mounted = await standing();

      clock.now = new Date("2026-11-06T12:00:00.000Z");
      mounted.document.hidden = true;
      mounted.document.dispatch("visibilitychange");

      expect(dueTexts(mounted.root)).toEqual(["Atenção: vence hoje"]);
    });

    it("redraws a page restored after it left, when the tab becomes visible again", async () => {
      clock.now = NOW;
      const mounted = await standing();
      mounted.document.defaultView.dispatch("pagehide");

      clock.now = new Date("2026-11-06T12:00:00.000Z");
      mounted.document.dispatch("visibilitychange");

      expect(dueTexts(mounted.root)).toEqual([
        "Atenção: prazo vencido em 05/11/2026",
      ]);
    });
  });

  describe("the due date in the case header keeps up with the clock too", () => {
    const DUE = "2026-11-05T21:00:00.000Z";
    const clock = { now: NOW };
    const standingCase = (
      privacy: Partial<PrivacyCaseDetail["privacy"]> = {}
    ) =>
      mount(
        [json(detail("received", { dueAt: DUE, ...privacy }))],
        json(PRIVACY),
        () => clock.now,
        screenContext({ id: CASE, screen: "privacidade-caso" })
      );
    const headerDue = (root: FakeElement) =>
      allElements(root)
        .filter((element) => element.getAttribute("class") === "due-text")
        .map((element) => element.textContent);

    it("turns 'vence hoje' into 'prazo vencido' on visibilitychange, with no new request", async () => {
      clock.now = NOW;
      const mounted = await standingCase();
      expect(headerDue(mounted.root)).toEqual(["Atenção: vence hoje"]);
      const requests = mounted.calls.length;

      clock.now = new Date("2026-11-05T21:00:01.000Z");
      mounted.document.hidden = false;
      mounted.document.dispatch("visibilitychange");

      expect(headerDue(mounted.root)).toEqual([
        "Atenção: prazo vencido em 05/11/2026",
      ]);
      expect(mounted.calls).toHaveLength(requests);
    });

    it("does the same when the window gets the focus back, and not while hidden", async () => {
      clock.now = NOW;
      const mounted = await standingCase();

      clock.now = new Date("2026-11-06T12:00:00.000Z");
      mounted.document.hidden = true;
      mounted.document.dispatch("visibilitychange");
      expect(headerDue(mounted.root)).toEqual(["Atenção: vence hoje"]);

      mounted.document.hidden = false;
      mounted.document.defaultView.dispatch("focus");
      expect(headerDue(mounted.root)).toEqual([
        "Atenção: prazo vencido em 05/11/2026",
      ]);
    });
  });

  it("says when nothing is open, and offers to open a case", async () => {
    const mounted = await list([json({ cases: [], next: null })]);
    expect(visibleText(mounted.root)).toContain(
      "Nenhum atendimento de privacidade aberto."
    );
    expect(
      byTag(mounted.root, "a").some(
        (link) => link.getAttribute("href") === "/privacidade/novo"
      )
    ).toBe(true);
  });

  it("lists the closed cases by the fixed tab, with no due date", async () => {
    const mounted = await list(
      [
        json({
          cases: [summary({ stage: "resolved", status: "closed" })],
          next: null,
        }),
      ],
      PRIVACY,
      "fechados"
    );
    expect(mounted.calls[1]?.path).toBe(
      "/api/privacy-cases?filter=closed&limit=25"
    );
    const text = visibleText(mounted.root);
    expect(text).toContain("Atendimento fechado");
    expect(text).not.toContain("faltam");
  });

  it("asks for the next page with the server's cursor, one request per click", async () => {
    const wait = pending();
    const mounted = await list([
      json({ cases: [summary()], next: CASE }),
      wait.answer,
    ]);
    firstButton(mounted.root, "Carregar mais").click();
    firstButton(mounted.root, "Carregar mais").click();
    await flush();
    wait.release(json({ cases: [], next: null }));
    await flush();
    expect(mounted.calls.map((call) => call.path)).toEqual([
      "/api/whoami",
      "/api/privacy-cases?filter=open&limit=25",
      `/api/privacy-cases?filter=open&limit=25&after=${CASE}`,
    ]);
  });

  it("writes a hostile store name as text", async () => {
    const mounted = await list([
      json({
        cases: HOSTILE.map((name, index) =>
          summary({
            id: `0199a0a0-0000-7000-8000-00000000c0${index}0`,
            organizationName: name,
          })
        ),
        next: null,
      }),
    ]);
    for (const tag of ["script", "img", "svg", "iframe"]) {
      expect(mounted.document.created).not.toContain(tag);
    }
    expect(visibleText(mounted.root)).toContain("<script>alert(1)</script>");
  });

  it("shows nothing and asks nothing without privacy_case:manage (AC-C1)", async () => {
    const mounted = await list([], OWNER);
    expect(mounted.calls.map((call) => call.path)).toEqual(["/api/whoami"]);
    expect(visibleText(mounted.root)).toContain(PROBLEM_TEXT.forbidden);
  });

  it("says a 403 of the server in words", async () => {
    const mounted = await list([json({ error: "forbidden" }, 403)]);
    expect(alertOf(mounted.root)?.textContent).toBe(PROBLEM_TEXT.forbidden);
  });
});

describe("Abrir atendimento de privacidade (AC-P11.1)", () => {
  const ready = async (answers: Answer[] = []) => {
    const mounted = await opening([
      json({ next: null, organizations: [{ id: STORE, name: "Loja da Ana" }] }),
      ...answers,
    ]);
    return mounted;
  };

  const fill = (root: FakeElement) => {
    type(root, "privacidade-motivo", "  Pedido de exclusão da conta  ");
    choose(root, "privacidade-canal", "email");
    choose(root, "privacidade-tipo", "deletion");
    choose(root, "privacidade-quem", "data_subject");
  };

  it("puts the fixed warning above every field", async () => {
    const mounted = await ready();
    const order = allElements(mounted.root).map((element) =>
      element.getAttribute("id")
    );
    const warning = order.indexOf("privacidade-aviso");
    expect(byId(mounted.root, "privacidade-aviso").textContent).toBe(
      "Não escreva nome, e-mail, documento nem valor de registro: o atendimento guarda só códigos e uma nota curta."
    );
    for (const field of [
      "privacidade-motivo",
      "privacidade-canal",
      "privacidade-tipo",
      "privacidade-quem",
      "privacidade-recebido",
      "privacidade-nota",
    ]) {
      expect(order.indexOf(field)).toBeGreaterThan(warning);
    }
    expect(visibleText(mounted.root)).toContain(OPEN_EFFECT);
    expect(OPEN_EFFECT).toContain(
      "Se a loja for apagada, o texto livre do atendimento some e o registro fica."
    );
  });

  it.each([
    ["privacidade-canal", CHANNELS],
    ["privacidade-tipo", REQUEST_TYPES],
    ["privacidade-quem", REQUESTER_KINDS],
  ] as const)(
    "offers in %s only the codes of the contract's list, with nothing chosen",
    async (id, codes) => {
      const mounted = await ready();
      const select = byId(mounted.root, id);
      const options = byTag(select, "option");
      expect(options.map((option) => option.getAttribute("value"))).toEqual([
        "",
        ...codes.map(([code]) => code),
      ]);
      expect(options[0]?.textContent).toBe("Escolha…");
      expect(select.value).toBe("");
    }
  );

  it("opens with one POST of the trimmed reason and the three codes, then goes to the case", async () => {
    const mounted = await ready([json({ id: CASE }, 201)]);
    fill(mounted.root);
    firstButton(mounted.root, "Abrir atendimento de privacidade").click();
    firstButton(mounted.root, "Abrir atendimento de privacidade").click();
    await flush();

    expect(posts(mounted.calls)).toHaveLength(1);
    expect(posts(mounted.calls)[0]?.path).toBe("/api/privacy-cases");
    expect(bodyOf(posts(mounted.calls)[0])).toEqual({
      channel: "email",
      organizationId: STORE,
      reason: "Pedido de exclusão da conta",
      requesterKind: "data_subject",
      requestType: "deletion",
    });
    expect(mounted.navigations).toEqual([`/privacidade/${CASE}`]);
  });

  it("sends the day it arrived as 00:00 in Brasília and the note, and counts the note's characters", async () => {
    const mounted = await ready([json({ id: CASE }, 201)]);
    fill(mounted.root);
    type(mounted.root, "privacidade-recebido", "2026-11-02");
    type(mounted.root, "privacidade-nota", "Chegou pelo chamado 88");
    expect(visibleText(mounted.root)).toContain("22 de 500 caracteres");
    firstButton(mounted.root, "Abrir atendimento de privacidade").click();
    await flush();
    expect(bodyOf(posts(mounted.calls)[0])).toMatchObject({
      note: "Chegou pelo chamado 88",
      receivedAt: "2026-11-02T03:00:00.000Z",
    });
  });

  it("has no native maxlength on the reason and the note, which would count UTF-16 units", async () => {
    const mounted = await ready();

    expect(
      byId(mounted.root, "privacidade-motivo").getAttribute("maxlength")
    ).toBeNull();
    expect(
      byId(mounted.root, "privacidade-nota").getAttribute("maxlength")
    ).toBeNull();
  });

  it("takes a reason of 500 emoji, counts them as 500 and sends them whole", async () => {
    const mounted = await ready([json({ id: CASE }, 201)]);
    fill(mounted.root);
    type(mounted.root, "privacidade-motivo", "😀".repeat(500));
    expect(byId(mounted.root, "privacidade-motivo-contador").textContent).toBe(
      "500 de 500 caracteres"
    );
    firstButton(mounted.root, "Abrir atendimento de privacidade").click();
    await flush();
    expect(bodyOf(posts(mounted.calls)[0])).toMatchObject({
      reason: "😀".repeat(500),
    });
  });

  it("announces the limit once, when the counter crosses it, and not on every key", async () => {
    const mounted = await ready();
    const live = () => {
      const field = byId(mounted.root, "privacidade-motivo");
      const [region] = allElements(mounted.root).filter(
        (element) => element.getAttribute("class") === "sr-only"
      );
      expect(field.getAttribute("aria-describedby")).not.toContain(
        region?.getAttribute("id") ?? "sem-id"
      );
      return region as FakeElement;
    };
    expect(live().getAttribute("aria-live")).toBe("polite");
    type(mounted.root, "privacidade-motivo", "a".repeat(500));
    expect(live().textContent).toBe("");

    type(mounted.root, "privacidade-motivo", "a".repeat(501));
    const said = live().textContent;
    expect(said).toContain("500 caracteres");
    expect(said).not.toBe("");

    live().textContent = "já lido";
    type(mounted.root, "privacidade-motivo", "a".repeat(502));
    expect(live().textContent).toBe("já lido");

    type(mounted.root, "privacidade-motivo", "a".repeat(500));
    expect(live().textContent).toBe("");
  });

  it("does not count the spaces around the reason, because the check and the sent text drop them", async () => {
    const mounted = await ready([json({ id: CASE }, 201)]);
    fill(mounted.root);
    type(mounted.root, "privacidade-motivo", `  ${"😀".repeat(500)}  `);
    expect(byId(mounted.root, "privacidade-motivo-contador").textContent).toBe(
      "500 de 500 caracteres"
    );
    firstButton(mounted.root, "Abrir atendimento de privacidade").click();
    await flush();
    expect(bodyOf(posts(mounted.calls)[0])).toMatchObject({
      reason: "😀".repeat(500),
    });
  });

  it("refuses 501 emoji in the reason, the counter says 501 and nothing is sent", async () => {
    const mounted = await ready();
    fill(mounted.root);
    type(mounted.root, "privacidade-motivo", "😀".repeat(501));
    expect(byId(mounted.root, "privacidade-motivo-contador").textContent).toBe(
      "501 de 500 caracteres"
    );
    firstButton(mounted.root, "Abrir atendimento de privacidade").click();
    await flush();
    expect(posts(mounted.calls)).toHaveLength(0);
    expect(byId(mounted.root, "privacidade-motivo-erro").textContent).toBe(
      "O motivo aceita até 500 caracteres."
    );
  });

  it("counts the note the same way: 500 emoji with spaces around it are taken", async () => {
    const mounted = await ready([json({ id: CASE }, 201)]);
    fill(mounted.root);
    type(mounted.root, "privacidade-nota", ` ${"😀".repeat(500)} `);
    expect(byId(mounted.root, "privacidade-nota-contador").textContent).toBe(
      "500 de 500 caracteres"
    );
    firstButton(mounted.root, "Abrir atendimento de privacidade").click();
    await flush();
    expect(bodyOf(posts(mounted.calls)[0])).toMatchObject({
      note: "😀".repeat(500),
    });
  });

  it.each([
    ["privacidade-motivo", "", "Escreva o motivo do atendimento."],
    ["privacidade-canal", "", "Escolha o canal."],
    ["privacidade-tipo", "", "Escolha o tipo de pedido."],
    ["privacidade-quem", "", "Escolha quem pede."],
    [
      "privacidade-recebido",
      "2026-11-06",
      "A data de recebimento não pode ser depois de hoje.",
    ],
    [
      "privacidade-nota",
      "linha\num",
      "A nota não aceita caracteres de controle nem quebra de linha.",
    ],
  ])(
    "refuses %s = %j on the screen, with no request",
    async (id, value, problem) => {
      const mounted = await ready();
      fill(mounted.root);
      const field = byId(mounted.root, id);
      field.value = value;
      firstButton(mounted.root, "Abrir atendimento de privacidade").click();
      await flush();
      expect(posts(mounted.calls)).toHaveLength(0);
      expect(byId(mounted.root, `${id}-erro`).textContent).toBe(problem);
      expect(field.getAttribute("aria-invalid")).toBe("true");
      expect(mounted.document.activeElement).toBe(field);
    }
  );

  it.each([
    [
      json({ error: "invalid_privacy_request" }, 400),
      "O atendimento não foi aberto: confira",
    ],
    [
      json({ error: "unknown_organization" }, 404),
      "Esta loja não foi encontrada.",
    ],
    [json({ error: "forbidden" }, 403), PROBLEM_TEXT.forbidden],
  ] as const)(
    "says a refusal in words, without a code, and lets the button work again",
    async (answer, said) => {
      const mounted = await ready([answer]);
      fill(mounted.root);
      firstButton(mounted.root, "Abrir atendimento de privacidade").click();
      await flush();
      const alert = alertOf(mounted.root)?.textContent ?? "";
      expect(alert).toContain(said);
      expect(alert).not.toMatch(TECHNICAL);
      expect(mounted.navigations).toEqual([]);
      expect(
        firstButton(
          mounted.root,
          "Abrir atendimento de privacidade"
        ).getAttribute("aria-disabled")
      ).toBe("false");
    }
  );

  it.each([
    [new Error("offline")],
    [json({ error: "internal_error" }, 500)],
    [json({ error: "unavailable" }, 503)],
  ])(
    "after an answer that does not say whether the case was opened, keeps the button off so a second click opens nothing",
    async (answer) => {
      const mounted = await ready([answer]);
      fill(mounted.root);
      firstButton(mounted.root, "Abrir atendimento de privacidade").click();
      await flush();
      expect(alertOf(mounted.root)?.textContent).toContain(
        "Não deu para confirmar se o atendimento foi aberto."
      );
      const button = firstButton(
        mounted.root,
        "Abrir atendimento de privacidade"
      );
      expect(button.getAttribute("aria-disabled")).toBe("true");
      button.click();
      await flush();
      expect(posts(mounted.calls)).toHaveLength(1);
    }
  );

  it("keeps nothing typed after the page is left (AC-C6)", async () => {
    const mounted = await ready();
    fill(mounted.root);
    type(mounted.root, "privacidade-nota", "nota");
    mounted.document.defaultView.dispatch("pagehide");
    for (const id of [
      "privacidade-motivo",
      "privacidade-nota",
      "privacidade-recebido",
    ]) {
      expect(byId(mounted.root, id).value).toBe("");
    }
  });

  it("zeroes the counters and the limit warning with the fields, so a page restored from the back-forward cache shows none of it", async () => {
    const mounted = await ready();
    type(mounted.root, "privacidade-motivo", "a".repeat(501));
    type(mounted.root, "privacidade-nota", "nota curta");
    const [warning] = allElements(mounted.root).filter(
      (element) => element.getAttribute("class") === "sr-only"
    );
    expect(warning?.textContent).not.toBe("");
    mounted.document.defaultView.dispatch("pagehide");

    expect(byId(mounted.root, "privacidade-motivo-contador").textContent).toBe(
      "0 de 500 caracteres"
    );
    expect(byId(mounted.root, "privacidade-nota-contador").textContent).toBe(
      "0 de 500 caracteres"
    );
    expect(warning?.textContent).toBe("");
  });
});

describe("the case, step by step (AC-P11.2, AC-P11.3, AC-P11.8)", () => {
  it("shows the done steps in one line, the current one open and the next ones off", async () => {
    const mounted = await openCase(detail("role_determined"));
    const items = stepItems(mounted.root);
    expect(items.map((item) => item.getAttribute("class"))).toEqual([
      "step step-done",
      "step step-done",
      "step step-current",
      "step step-later",
      "step step-later",
      "step step-later",
    ]);
    expect(visibleText(items[0] as FakeElement)).toBe(
      "Feita: 1. Identidade: Confirmada, por posse do e-mail"
    );
    expect(visibleText(items[1] as FakeElement)).toBe(
      "Feita: 2. Papel do Polaris: Controlador: o Polaris decide sobre o dado"
    );
    expect(items[2]?.getAttribute("aria-current")).toBe("step");
    for (const later of items.slice(3)) {
      expect(byTag(later, "button")).toHaveLength(0);
    }
    expect(visibleText(mounted.root)).toContain(
      "faltam 9 dias (até 14/11/2026, prazo provisório)"
    );
    expect(visibleText(mounted.root)).toContain(
      "Pedido pelo e-mail de suporte"
    );
    expect(mounted.calls.map((call) => call.path)).toEqual([
      "/api/whoami",
      `/api/privacy-cases/${CASE}`,
    ]);
  });

  it.each([
    ["requested", ["etapa-identity-status", "etapa-identity-metodo"]],
    ["identity_checked", ["etapa-role-papel"]],
    ["scoped", ["etapa-decision-decisao", "etapa-decision-motivo"]],
    ["decided", ["etapa-actions-acao"]],
  ] as const)(
    "chooses nothing for the operator at %s",
    async (stage, selects) => {
      const mounted = await openCase(detail(stage));
      for (const id of selects) {
        const select = byId(mounted.root, id);
        expect(select.value).toBe("");
        expect(byTag(select, "option")[0]?.getAttribute("value")).toBe("");
      }
      expect(
        byTag(mounted.root, "input").filter((input) => input.checked)
      ).toHaveLength(0);
    }
  );

  it("offers every category of the contract as a box, none of them marked", async () => {
    const mounted = await openCase(detail("role_determined"));
    const boxes = byTag(mounted.root, "input").filter(
      (input) => input.getAttribute("type") === "checkbox"
    );
    expect(boxes.map((box) => box.getAttribute("value"))).toEqual(
      CATEGORIES.map(([code]) => code)
    );
    expect(boxes.some((box) => box.checked)).toBe(false);
  });

  it.each([
    ["requested", "identity"],
    ["identity_checked", "role"],
    ["role_determined", "scope"],
    ["scoped", "decision"],
    ["decided", "actions"],
    ["executed", "resolve"],
  ] as const)("says the server's rules in words at %s", async (stage, key) => {
    const mounted = await openCase(detail(stage));
    for (const rule of RULES[key]) {
      expect(visibleText(mounted.root)).toContain(rule);
    }
  });

  it("says the case's facts before the decision without choosing it", async () => {
    const mounted = await openCase(
      detail("scoped", { identityStatus: "failed", polarisRole: "processor" })
    );
    expect(visibleText(mounted.root)).toContain(
      "Neste atendimento: identidade não confirmada; papel do Polaris operador; quem pede: titular dos dados."
    );
  });

  it.each([
    ["scoped", detail("scoped")],
    ["role_determined", detail("role_determined")],
    ["decided", detail("decided")],
  ])("keeps aria-disabled off every step item (%s)", async (_state, shown) => {
    const mounted = await openCase(shown);
    const items = stepItems(mounted.root);
    expect(items).toHaveLength(6);
    for (const item of items) {
      expect(item.hasAttribute("aria-disabled")).toBe(false);
    }
    expect(
      byTag(mounted.root, "li").filter((item) =>
        item.hasAttribute("aria-disabled")
      )
    ).toEqual([]);
  });

  it("says the Polaris controller list as the ADR 0077 does", async () => {
    const mounted = await openCase(detail("identity_checked"));
    expect(visibleText(mounted.root)).toContain(
      "(conta, autenticação, assinatura, segurança e suporte)"
    );
  });

  it("with a refusal decided, skips the actions and opens the resolution", async () => {
    const mounted = await openCase(
      detail("decided", { decision: "reject", decisionReason: "no_authority" })
    );
    const items = stepItems(mounted.root);
    expect(visibleText(items[4] as FakeElement)).toBe(
      "Sem ação: 5. Ações: Sem ação: uma recusa não tem o que registrar."
    );
    expect(items[5]?.getAttribute("aria-current")).toBe("step");
  });

  it("with a redirect decided, opens both the optional actions and the resolution", async () => {
    const mounted = await openCase(
      detail("decided", {
        decision: "redirect_to_controller",
        decisionReason: "controller_is_reseller",
      })
    );
    const items = stepItems(mounted.root);
    expect(items[4]?.getAttribute("aria-current")).toBe("step");
    expect(items[5]?.getAttribute("aria-current")).toBe("step");
  });

  it("with an acceptance, keeps the resolution off until an action is recorded", async () => {
    const mounted = await openCase(detail("decided"));
    const items = stepItems(mounted.root);
    expect(items[4]?.getAttribute("aria-current")).toBe("step");
    expect(items[5]?.getAttribute("class")).toBe("step step-later");
  });

  it("says a case closed outside the workflow was closed, not resolved, and offers nothing to send", async () => {
    const closed = detail("scoped");
    const mounted = await openCase({
      ...closed,
      case: {
        ...closed.case,
        closedAt: "2026-11-03T15:00:00.000Z",
        status: "closed",
      },
    });
    const text = visibleText(mounted.root);
    expect(text).toContain(
      "Atendimento fechado em 03/11/2026 12:00, sem resolução no fluxo de privacidade"
    );
    expect(text).not.toContain("Atendimento resolvido");
    expect(text).toContain("fechado fora do fluxo de privacidade");
    expect(byTag(mounted.root, "button")).toHaveLength(0);
  });

  it("shows a resolved case with every step done and nothing to send", async () => {
    const mounted = await openCase(
      detail(
        "resolved",
        { resolvedAt: "2026-11-04T15:00:00.000Z" },
        {
          actions: [
            {
              action: "customer_anonymized",
              entityId: CUSTOMER,
              id: "0199a0a0-0000-7000-8000-0000000000e1",
              recordedAt: "2026-11-03T15:00:00.000Z",
              recordedBy: OWNER.principal.id,
            },
          ],
        }
      )
    );
    expect(
      stepItems(mounted.root).map((item) => item.getAttribute("class"))
    ).toEqual(new Array(6).fill("step step-done"));
    expect(byTag(mounted.root, "button")).toHaveLength(0);
    expect(visibleText(mounted.root)).toContain(
      "Atendimento resolvido em 04/11/2026 12:00"
    );
    expect(visibleText(mounted.root)).toContain(
      "Cliente anonimizado (03/11/2026 12:00, por você)"
    );
  });
});

interface StepCase {
  answer: () => Response;
  body: Record<string, unknown>;
  button: string;
  effect: string;
  fill: (root: FakeElement) => void;
  path: string;
  stage: string;
}

const STEP_CASES: readonly [string, StepCase][] = [
  [
    "Identidade",
    {
      answer: () => json({ id: CASE, stage: "identity_checked" }),
      body: { method: "email_ownership", status: "verified" },
      button: "Revisar identidade",
      effect:
        "A etapa “Identidade” fica registrada como Confirmada, por posse do e-mail.",
      fill: (root) => {
        choose(root, "etapa-identity-status", "verified");
        choose(root, "etapa-identity-metodo", "email_ownership");
      },
      path: "/identity",
      stage: "requested",
    },
  ],
  [
    "Papel do Polaris",
    {
      answer: () => json({ id: CASE, stage: "role_determined" }),
      body: { role: "processor" },
      button: "Revisar papel do Polaris",
      effect:
        "A etapa “Papel do Polaris” fica registrada como Operador: o Polaris só processa, pela loja.",
      fill: (root) => choose(root, "etapa-role-papel", "processor"),
      path: "/role",
      stage: "identity_checked",
    },
  ],
  [
    "Escopo",
    {
      answer: () => json({ id: CASE, stage: "scoped" }),
      body: { categories: ["customers", "sales"], subjectReference: CUSTOMER },
      button: "Revisar escopo",
      effect: `A etapa “Escopo” fica registrada como Clientes da loja, Vendas, referência ${CUSTOMER}.`,
      fill: (root) => {
        byId(root, "etapa-scope-customers").checked = true;
        byId(root, "etapa-scope-sales").checked = true;
        type(root, "etapa-scope-referencia", CUSTOMER);
      },
      path: "/scope",
      stage: "role_determined",
    },
  ],
  [
    "Decisão",
    {
      answer: () => json({ id: CASE, stage: "decided" }),
      body: {
        decision: "partially_accept",
        note: "Só a conta",
        reason: "legal_retention",
      },
      button: "Revisar decisão",
      effect:
        "A etapa “Decisão” fica registrada como Aceitar em parte, motivo: Guarda por obrigação legal (diga a norma na nota), com nota.",
      fill: (root) => {
        choose(root, "etapa-decision-decisao", "partially_accept");
        choose(root, "etapa-decision-motivo", "legal_retention");
        type(root, "etapa-decision-nota", " Só a conta ");
      },
      path: "/decision",
      stage: "scoped",
    },
  ],
  [
    "Ações",
    {
      answer: () => json({ actionId: CASE, id: CASE, stage: "executed" }, 201),
      body: { action: "customer_anonymized", entityId: CUSTOMER },
      button: "Revisar ações",
      effect: `A etapa “Ações” fica registrada como Cliente anonimizado, registro ${CUSTOMER}.`,
      fill: (root) => {
        choose(root, "etapa-actions-acao", "customer_anonymized");
        type(root, "etapa-actions-registro", CUSTOMER.toUpperCase());
      },
      path: "/actions",
      stage: "decided",
    },
  ],
  [
    "Resolução",
    {
      answer: () => json({ id: CASE, revokedGrants: 0, stage: "resolved" }),
      body: { resolution: "Conta apagada pelo dono" },
      button: "Revisar resolução",
      effect:
        "A resolução fica registrada como atendimento resolvido: “Conta apagada pelo dono”. O atendimento fecha e os acessos temporários dele são revogados.",
      fill: (root) =>
        type(root, "etapa-resolve-texto", "Conta apagada pelo dono"),
      path: "/resolve",
      stage: "executed",
    },
  ],
];

const reviewOf = async (step: StepCase, answers: Answer[] = []) => {
  const mounted = await openCase(detail(step.stage), answers);
  step.fill(mounted.root);
  await click(mounted.root, step.button);
  return mounted;
};

describe("each step: reviewed in two steps, sent once (AC-P11.2, AC-P11.4, AC-C2)", () => {
  it.each(STEP_CASES)(
    "%s: the review says, in order, where, what, that it cannot be undone and what stays on record",
    async (_name, step) => {
      const mounted = await reviewOf(step);
      const whole = visibleText(mounted.root);
      const text = whole.slice(whole.indexOf("Revise antes de registrar"));
      const positions = [
        "Revise antes de registrar",
        "STAGING",
        "Loja da Ana",
        "Atendimento de privacidade aberto em 30/10/2026 12:00",
        step.effect,
        STEP_UNDO,
        STEP_RECORD,
      ].map((part) => text.indexOf(part));
      expect(positions.every((position) => position >= 0)).toBe(true);
      expect([...positions].sort((a, b) => a - b)).toEqual(positions);
      expect(posts(mounted.calls)).toHaveLength(0);
      expect(mounted.document.activeElement?.textContent).toContain(
        "Revise antes de registrar"
      );
    }
  );

  it.each(STEP_CASES)(
    "%s: a double click sends one POST with the chosen codes, then the case is read again",
    async (name, step) => {
      const wait = pending();
      const after = detail(
        STEP_CASES[STEP_CASES.findIndex(([n]) => n === name) + 1]?.[1].stage ??
          "resolved"
      );
      const mounted = await reviewOf(step, [wait.answer, json(after)]);
      const confirm = firstButton(
        mounted.root,
        step.button.replace("Revisar", "Registrar")
      );
      confirm.click();
      confirm.click();
      await flush();
      expect(confirm.getAttribute("aria-disabled")).toBe("true");
      wait.release(step.answer());
      await flush();
      await flush();

      expect(posts(mounted.calls)).toHaveLength(1);
      expect(posts(mounted.calls)[0]?.path).toBe(
        `/api/privacy-cases/${CASE}${step.path}`
      );
      expect(bodyOf(posts(mounted.calls)[0])).toEqual(step.body);
      expect(mounted.calls.at(-1)?.path).toBe(`/api/privacy-cases/${CASE}`);
      expect(mounted.calls.at(-1)?.init.method).toBe("GET");
      expect(visibleText(mounted.root)).toContain(
        `Etapa “${name}” registrada.`
      );
    }
  );

  it("Voltar keeps what was chosen, sends nothing and gives the focus back to the review button", async () => {
    const [, step] = STEP_CASES[0] as [string, StepCase];
    const mounted = await reviewOf(step);
    await click(mounted.root, "Voltar");
    expect(byId(mounted.root, "etapa-identity-status").value).toBe("verified");
    expect(mounted.document.activeElement?.textContent).toBe(
      "Revisar identidade"
    );
    expect(posts(mounted.calls)).toHaveLength(0);
  });

  it.each([
    [
      "requested",
      "Revisar identidade",
      "etapa-identity-status-erro",
      "Escolha se a identidade foi confirmada.",
    ],
    [
      "identity_checked",
      "Revisar papel do Polaris",
      "etapa-role-papel-erro",
      "Escolha o papel do Polaris.",
    ],
    [
      "role_determined",
      "Revisar escopo",
      "etapa-scope-categorias-erro",
      "Marque ao menos uma categoria.",
    ],
    [
      "scoped",
      "Revisar decisão",
      "etapa-decision-decisao-erro",
      "Escolha a decisão.",
    ],
    [
      "decided",
      "Revisar ações",
      "etapa-actions-acao-erro",
      "Escolha o que foi feito.",
    ],
  ])(
    "at %s, refuses to review with nothing chosen",
    async (stage, button, error, text) => {
      const mounted = await openCase(detail(stage));
      await click(mounted.root, button);
      expect(byId(mounted.root, error).textContent).toBe(text);
      expect(visibleText(mounted.root)).not.toContain(
        "Revise antes de registrar"
      );
    }
  );

  it("asks for a reason for any decision but a plain acceptance, and lets a plain acceptance go without one", async () => {
    const mounted = await openCase(detail("scoped"));
    choose(mounted.root, "etapa-decision-decisao", "reject");
    await click(mounted.root, "Revisar decisão");
    expect(byId(mounted.root, "etapa-decision-motivo-erro").textContent).toBe(
      "Escolha o motivo: toda decisão que não seja aceitar sem ressalva tem motivo."
    );
    choose(mounted.root, "etapa-decision-decisao", "accept");
    await click(mounted.root, "Revisar decisão");
    expect(visibleText(mounted.root)).toContain(
      "A etapa “Decisão” fica registrada como Aceitar."
    );
  });

  describe("a legal retention asks for the norm in the note", () => {
    const decisionPost = (mounted: Awaited<ReturnType<typeof openCase>>) =>
      posts(mounted.calls).filter((call) => call.path.endsWith("/decision"));

    it("refuses an empty, short or blank note in words and sends nothing", async () => {
      const mounted = await openCase(detail("scoped"));
      choose(mounted.root, "etapa-decision-decisao", "reject");
      choose(mounted.root, "etapa-decision-motivo", "legal_retention");
      const refuse = async (note: string) => {
        type(mounted.root, "etapa-decision-nota", note);
        await click(mounted.root, "Revisar decisão");
        expect(byId(mounted.root, "etapa-decision-nota-erro").textContent).toBe(
          "Com este motivo a nota é obrigatória: diga a norma, de 10 a 500 caracteres."
        );
        expect(
          byId(mounted.root, "etapa-decision-nota").getAttribute("aria-invalid")
        ).toBe("true");
      };
      await refuse("");
      await refuse("   ");
      await refuse("lei");
      await refuse("123456789");
      await refuse("📜".repeat(9));
      expect(posts(mounted.calls)).toHaveLength(0);
      expect(visibleText(mounted.root)).not.toContain(
        "Revise antes de registrar"
      );
    });

    it("says the note is mandatory only while that reason is chosen", async () => {
      const mounted = await openCase(detail("scoped"));
      const hint = () => byId(mounted.root, "etapa-decision-nota-obrigatoria");
      const label = () =>
        byTag(mounted.root, "label").find(
          (item) => item.getAttribute("for") === "etapa-decision-nota"
        );
      expect(hint().hasAttribute("hidden")).toBe(true);
      expect(label()?.textContent).toBe("Nota da decisão (opcional)");
      choose(mounted.root, "etapa-decision-motivo", "legal_retention");
      expect(hint().hasAttribute("hidden")).toBe(false);
      expect(hint().textContent).toBe(
        "Obrigatória: diga a norma (de 10 a 500 caracteres)"
      );
      expect(label()?.textContent).toBe("Nota da decisão (obrigatória)");
      expect(
        byId(mounted.root, "etapa-decision-nota").getAttribute(
          "aria-describedby"
        )
      ).toContain("etapa-decision-nota-obrigatoria");
      choose(mounted.root, "etapa-decision-motivo", "other");
      expect(hint().hasAttribute("hidden")).toBe(true);
      expect(label()?.textContent).toBe("Nota da decisão (opcional)");
      expect(
        byId(mounted.root, "etapa-decision-nota").getAttribute(
          "aria-describedby"
        )
      ).not.toContain("etapa-decision-nota-obrigatoria");
    });

    it.each([
      ["CTN art195", "CTN art195"],
      ["a".repeat(500), "a".repeat(500)],
      ["📜".repeat(10), "📜".repeat(10)],
    ])(
      "sends the decision with a note of 10 to 500 characters (%#)",
      async (note, sent) => {
        const mounted = await openCase(detail("scoped"), [
          json({ id: CASE, stage: "decided" }),
          json(detail("decided")),
        ]);
        choose(mounted.root, "etapa-decision-decisao", "reject");
        choose(mounted.root, "etapa-decision-motivo", "legal_retention");
        type(mounted.root, "etapa-decision-nota", `  ${note}  `);
        await click(mounted.root, "Revisar decisão");
        firstButton(mounted.root, "Registrar decisão").click();
        await flush();
        expect(decisionPost(mounted)).toHaveLength(1);
        expect(bodyOf(decisionPost(mounted)[0])).toEqual({
          decision: "reject",
          note: sent,
          reason: "legal_retention",
        });
        expect(mounted.calls.every((call) => !call.path.includes(sent))).toBe(
          true
        );
      }
    );

    it("lets another reason go without a note", async () => {
      const mounted = await openCase(detail("scoped"), [
        json({ id: CASE, stage: "decided" }),
        json(detail("decided")),
      ]);
      choose(mounted.root, "etapa-decision-decisao", "reject");
      choose(mounted.root, "etapa-decision-motivo", "no_authority");
      await click(mounted.root, "Revisar decisão");
      firstButton(mounted.root, "Registrar decisão").click();
      await flush();
      expect(bodyOf(decisionPost(mounted)[0])).toEqual({
        decision: "reject",
        reason: "no_authority",
      });
    });

    it("says an old decision without a note was taken before the rule, and a new one shows its note", async () => {
      const old = await openCase(
        detail("decided", {
          decision: "reject",
          decisionNote: null,
          decisionReason: "legal_retention",
        })
      );
      expect(visibleText(old.root)).toContain(
        "nota: não registrada (decidido antes desta regra ou apagada com a loja)"
      );
      const current = await openCase(
        detail("decided", {
          decision: "reject",
          decisionNote: "CTN art195",
          decisionReason: "legal_retention",
        })
      );
      expect(visibleText(current.root)).toContain("nota: CTN art195");
      expect(visibleText(current.root)).not.toContain("não registrada");
      const other = await openCase(
        detail("decided", {
          decision: "reject",
          decisionNote: null,
          decisionReason: "no_authority",
        })
      );
      expect(visibleText(other.root)).not.toContain("não registrada");
    });
  });

  it("refuses a reference that is not an opaque code, and an action's record that is not a UUID", async () => {
    const scope = await openCase(detail("role_determined"));
    byId(scope.root, "etapa-scope-account").checked = true;
    type(scope.root, "etapa-scope-referencia", "maria@example.com");
    await click(scope.root, "Revisar escopo");
    expect(
      byId(scope.root, "etapa-scope-referencia-erro").textContent
    ).toContain("Nunca nome, e-mail ou documento.");

    const actions = await openCase(detail("decided"));
    choose(actions.root, "etapa-actions-acao", "other");
    type(actions.root, "etapa-actions-registro", "cliente 42");
    await click(actions.root, "Revisar ações");
    expect(byId(actions.root, "etapa-actions-registro-erro").textContent).toBe(
      "Use o ID (UUID) do registro, ou deixe vazio."
    );
  });
});

describe("the server's refusals (AC-P11.2, AC-P11.3, AC-C3)", () => {
  it("says a step out of turn or repeated in words, sends nothing again and reads the steps as the server has them", async () => {
    const [, step] = STEP_CASES[1] as [string, StepCase];
    const mounted = await reviewOf(step, [
      json({ error: "privacy_stage_conflict" }, 409),
      json(detail("role_determined")),
    ]);
    await click(mounted.root, "Registrar papel do Polaris");

    expect(alertOf(mounted.root)?.textContent).toBe(STAGE_CONFLICT);
    expect(posts(mounted.calls)).toHaveLength(1);
    expect(mounted.calls.at(-1)?.path).toBe(`/api/privacy-cases/${CASE}`);
    const items = stepItems(mounted.root);
    expect(items[1]?.getAttribute("class")).toBe("step step-done");
    expect(items[2]?.getAttribute("aria-current")).toBe("step");
    expect(STAGE_CONFLICT).toBe(
      "Esta etapa já foi registrada ou ainda não é a vez dela. Nada foi refeito."
    );
  });

  it("says a decision the case does not allow without a code, inside the step, keeping the choices", async () => {
    const mounted = await openCase(
      detail("scoped", { polarisRole: "processor" }),
      [json({ error: "privacy_decision_not_allowed" }, 400)]
    );
    choose(mounted.root, "etapa-decision-decisao", "accept");
    await click(mounted.root, "Revisar decisão");
    await click(mounted.root, "Registrar decisão");

    const alert = alertOf(mounted.root)?.textContent ?? "";
    expect(alert).toBe(PROBLEM_TEXT.not_allowed);
    expect(alert).not.toMatch(TECHNICAL);
    expect(byId(mounted.root, "etapa-decision-decisao").value).toBe("accept");
    expect(mounted.document.activeElement).toBe(alertOf(mounted.root));
    expect(posts(mounted.calls)).toHaveLength(1);
  });

  it.each([
    [new Error("offline")],
    [json({ error: "internal_error" }, 500)],
    [json({ error: "unavailable" }, 503)],
  ])(
    "after an answer that does not say whether the step was recorded, offers only to read the case again",
    async (answer) => {
      const [, step] = STEP_CASES[0] as [string, StepCase];
      const mounted = await reviewOf(step, [
        answer,
        json(detail("identity_checked")),
      ]);
      await click(mounted.root, "Registrar identidade");
      expect(alertOf(mounted.root)?.textContent).toBe(STEP_UNKNOWN);
      expect(
        firstButton(mounted.root, "Registrar identidade").hasAttribute("hidden")
      ).toBe(true);
      await click(mounted.root, "Recarregar o atendimento");
      expect(posts(mounted.calls)).toHaveLength(1);
      expect(mounted.calls.at(-1)?.path).toBe(`/api/privacy-cases/${CASE}`);
    }
  );

  it("says a 403 of a step as no permission", async () => {
    const [, step] = STEP_CASES[0] as [string, StepCase];
    const mounted = await reviewOf(step, [json({ error: "forbidden" }, 403)]);
    await click(mounted.root, "Registrar identidade");
    expect(alertOf(mounted.root)?.textContent).toBe(PROBLEM_TEXT.forbidden);
  });

  it("says a case that does not exist in words", async () => {
    const mounted = await mount(
      [json({ error: "not_found" }, 404)],
      json(PRIVACY),
      () => NOW,
      screenContext({ id: CASE, screen: "privacidade-caso" })
    );
    expect(alertOf(mounted.root)?.textContent).toBe(
      "Este atendimento não foi encontrado."
    );
  });
});

describe("the actions step records, it does not execute (AC-P11.5)", () => {
  it("says the fixed sentence in the step and in the review, and calls only the privacy case's own routes", async () => {
    const [, step] = STEP_CASES[4] as [string, StepCase];
    const mounted = await openCase(detail("decided"), [
      step.answer(),
      json(detail("executed")),
    ]);
    expect(visibleText(mounted.root)).toContain(ACTIONS_ONLY_RECORD);
    step.fill(mounted.root);
    await click(mounted.root, step.button);
    expect(visibleText(mounted.root)).toContain(ACTIONS_ONLY_RECORD);
    await click(mounted.root, "Registrar ações");

    expect(ACTIONS_ONLY_RECORD).toBe(
      "Isto registra o que foi feito pelos comandos próprios; não altera dado da loja."
    );
    expect(
      mounted.calls.map((call) => `${call.init.method} ${call.path}`)
    ).toEqual([
      "GET /api/whoami",
      `GET /api/privacy-cases/${CASE}`,
      `POST /api/privacy-cases/${CASE}/actions`,
      `GET /api/privacy-cases/${CASE}`,
    ]);
  });
});

describe("nothing of the case after leaving (AC-P11.6, AC-C6)", () => {
  it("takes the case, its note and the steps off the page on pagehide, and a late answer writes nothing", async () => {
    const wait = pending();
    const mounted = await mount(
      [wait.answer],
      json(PRIVACY),
      () => NOW,
      screenContext({ id: CASE, screen: "privacidade-caso" })
    );
    mounted.document.defaultView.dispatch("pagehide");
    wait.release(json(detail("scoped")));
    await flush();
    expect(visibleText(mounted.root)).not.toContain("Pedido pelo e-mail");
    expect(stepItems(mounted.root)).toHaveLength(0);
  });

  it("does not show the case again when a step's answer arrives after the page was left", async () => {
    const wait = pending();
    const [, step] = STEP_CASES[0] as [string, StepCase];
    const mounted = await reviewOf(step, [wait.answer]);
    firstButton(mounted.root, "Registrar identidade").click();
    mounted.document.defaultView.dispatch("pagehide");
    wait.release(step.answer());
    await flush();
    await flush();
    expect(stepItems(mounted.root)).toHaveLength(0);
    expect(mounted.calls.at(-1)?.init.method).toBe("POST");
  });

  it("clears a case already shown", async () => {
    const mounted = await openCase(detail("scoped"));
    expect(visibleText(mounted.root)).toContain(
      "Pedido pelo e-mail de suporte"
    );
    mounted.document.defaultView.dispatch("pagehide");
    expect(visibleText(mounted.root)).not.toContain(
      "Pedido pelo e-mail de suporte"
    );
    expect(visibleText(mounted.root)).not.toContain("cliente-42");
  });

  it("writes the note, the reference and the decision's note as text", async () => {
    const mounted = await openCase(
      detail("decided", {
        decision: "reject",
        decisionNote: HOSTILE[0],
        decisionReason: "other",
        note: HOSTILE[1],
        subjectReference: HOSTILE[2],
      })
    );
    for (const tag of ["script", "img", "svg", "iframe"]) {
      expect(mounted.document.created).not.toContain(tag);
    }
    const text = visibleText(mounted.root);
    expect(text).toContain("<script>alert(1)</script>");
    expect(text).toContain("<img src=x onerror=alert(1)>");
    expect(
      byTag(mounted.root, "a").every((link) =>
        (link.getAttribute("href") ?? "").startsWith("/")
      )
    ).toBe(true);
  });
});

describe("the lists the case's steps offer come from the contract (AC-P11.1)", () => {
  it.each([
    ["requested", "etapa-identity-status", IDENTITY_STATUSES],
    ["requested", "etapa-identity-metodo", IDENTITY_METHODS],
    ["identity_checked", "etapa-role-papel", ROLES],
    ["scoped", "etapa-decision-decisao", DECISIONS],
    ["scoped", "etapa-decision-motivo", DECISION_REASONS],
    ["decided", "etapa-actions-acao", ACTIONS],
  ] as const)(
    "at %s, %s offers the list's codes after an empty choice",
    async (stage, id, codes) => {
      const mounted = await openCase(detail(stage));
      expect(
        byTag(byId(mounted.root, id), "option").map((option) =>
          option.getAttribute("value")
        )
      ).toEqual(["", ...codes.map(([code]) => code)]);
    }
  );
});
