import { describe, expect, it } from "vitest";
import { environmentText } from "./app";
import {
  CANCEL_EFFECT,
  CANCEL_UNDO,
  CASE_REQUIRED,
  COMMAND_UNKNOWN,
  HOLD_STOPS_PURGE,
  HOLD_UNDO,
  holdEffectText,
  NEXT_PURGE_CYCLE,
  ONLY_CLOSED,
  PURGE_DONE,
  PURGE_KEPT,
  PURGE_REFUSALS,
  PURGE_UNDO,
  purgeErasedText,
  purgeRefusalText,
  REFUSED_GENERIC,
  RELEASE_EFFECT,
  REVIEW_DUE,
  SERVER_CHECKS,
} from "./purge-words";
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
  diagnostics,
  flush,
  json,
  mount,
  OWNER,
  screenContext,
} from "./test-page";
import type { PrivacyCaseDetail } from "./types";
import { purgeCaseProblem, sameStoreName } from "./views/purge";

/**
 * The tab "Purge e trava legal" of a privacy case (corte admin-v2, Parte 7): what it offers by the store's state and
 * the case, the typed name that gates the scheduling, one request per click, the server's refusals said in words, and
 * the case read again after every answer.
 */

const TRACE = /Loja|Ana|motivo|reservado|2026/;
const CASE = "0199a0a0-0000-7000-8000-00000000c0de";
const STORE = "0199a0a0-0000-7000-8000-0000000000a1";
const NOW = new Date("2026-11-05T15:00:00.000Z");
const CONTEXT = screenContext({
  action: "purge",
  id: CASE,
  screen: "privacidade-caso",
});
const SCOPE = [
  "organization_profile",
  "customers",
  "sales",
  "inventory_catalog",
  "media",
];

const CORTE_WHAT_HAPPENS =
  "Os dados operacionais da loja (vendas, produtos e catálogo, estoque, clientes, despesas, metas, formas de pagamento, imagens, dados sincronizados com os aparelhos e cópias exportadas) serão apagados a partir de {data do servidor}. Ficam, sem texto livre: os registros de cobrança, pseudonimizados (sem os dados do pagador; as referências do provedor continuam e permitem localizá-lo lá), os casos de suporte e de privacidade, e os registros de auditoria e de exclusão. A conta de cada pessoa não é apagada com a loja.";
const CORTE_UNDO =
  "Você pode cancelar o agendamento enquanto nenhuma execução estiver em curso e nada tiver sido apagado do armazenamento. Depois da primeira exclusão de arquivo, isso não poderá ser desfeito.";

const MAY = {
  ...OWNER,
  capabilities: [
    ...OWNER.capabilities,
    "privacy_case:manage",
    "organization:purge",
    "organization:legal_hold",
  ],
};
const WITHOUT_PURGE = {
  ...OWNER,
  capabilities: [...OWNER.capabilities, "privacy_case:manage"],
};

interface Overrides {
  audit?: PrivacyCaseDetail["audit"];
  name?: string;
  privacy?: Partial<PrivacyCaseDetail["privacy"]>;
  status?: string;
}

function detail(overrides: Overrides = {}): PrivacyCaseDetail {
  return {
    actions: [],
    audit: overrides.audit ?? [],
    case: {
      closedAt: null,
      id: CASE,
      openedAt: "2026-10-30T15:00:00.000Z",
      organizationId: STORE,
      organizationName: overrides.name ?? "Loja da Ana",
      resolution: null,
      status: overrides.status ?? "open",
    },
    privacy: {
      channel: "email",
      decision: "accept",
      decisionNote: null,
      decisionReason: null,
      dueAt: "2026-11-14T15:00:00.000Z",
      identityMethod: "email_ownership",
      identityStatus: "verified",
      note: null,
      overdue: false,
      polarisRole: "controller",
      receivedAt: "2026-10-30T15:00:00.000Z",
      requesterKind: "organization_owner",
      requestType: "deletion",
      resolvedAt: null,
      scopeCategories: SCOPE,
      stage: "decided",
      subjectReference: null,
      ...overrides.privacy,
    },
  } as PrivacyCaseDetail;
}

const hold = (overrides: { reviewDue?: boolean } = {}) => ({
  id: "0199a0a0-0000-7000-8000-0000000000b1",
  organizationId: STORE,
  placedAt: "2026-10-31T15:00:00.000Z",
  placedBy: OWNER.principal.id,
  reviewAt: "2026-12-15T15:00:00.000Z",
  reviewDue: false,
  supportCaseId: CASE,
  ...overrides,
});
const page = (
  holds: ReturnType<typeof hold>[] = [],
  next: string | null = null
) => json({ dueForReview: 0, holds, next });
const store = (status: string) =>
  json(diagnostics({ id: STORE, name: "Loja da Ana", status }));
const audit = (eventType: string, at: string) => ({
  at,
  detail: null,
  entityType: null,
  eventType,
  principalId: OWNER.principal.id,
});

/** What the page asks again after a command: the case, the store and the holds. */
const reread = (status = "closed", overrides: Overrides = {}) => [
  json(detail(overrides)),
  store(status),
  page(),
];

const open = (
  answers: Answer[],
  who = MAY,
  first = detail(),
  context = CONTEXT
) => mount([json(first), ...answers], json(who), () => NOW, context);

const openClosed = (more: Answer[] = [], first = detail()) =>
  open([store("closed"), page(), ...more], MAY, first);

const posts = (calls: Call[]) =>
  calls.filter((call) => call.init.method === "POST");
const bodyOf = (call: Call | undefined) =>
  JSON.parse(String(call?.init.body ?? "null"));

const panelOf = (root: FakeElement): FakeElement => {
  const found = allElements(root).find((element) =>
    (element.getAttribute("class") ?? "").startsWith("purge ")
  );
  if (found === undefined) {
    throw new Error("no purge panel");
  }
  return found;
};

const click = async (root: FakeElement, text: string) => {
  const [target] = buttons(root, text);
  if (target === undefined) {
    throw new Error(`no button ${text}`);
  }
  target.click();
  await flush();
};

const type = (root: FakeElement, id: string, value: string) => {
  const input = byId(root, id);
  input.value = value;
  input.dispatch("input");
  return input;
};

const confirmOf = (root: FakeElement): FakeElement => {
  const found = byTag(root, "button").find((button) =>
    button.textContent.startsWith("Agendar o apagamento da ")
  );
  if (found === undefined) {
    throw new Error("no confirm button");
  }
  return found;
};

const toReview = async (
  mounted: { root: FakeElement },
  name = "Loja da Ana"
) => {
  await click(mounted.root, "Agendar o apagamento");
  type(mounted.root, "purge-nome", name);
  return confirmOf(mounted.root);
};

const submit = async (root: FakeElement) => {
  confirmOf(root).click();
  await flush();
};

const panelButtons = (root: FakeElement) =>
  byTag(panelOf(root), "button")
    .filter((button) => !button.hasAttribute("hidden"))
    .map((button) => button.textContent);

function pending() {
  let release: (response: Response) => void = () => undefined;
  const answer: Answer = () =>
    new Promise<Response>((resolve) => {
      release = resolve;
    });
  return { answer, release: (response: Response) => release(response) };
}

const refusal = (code: string, status = 409) =>
  json({ error: code, message: "x" }, status);

describe("Purge tab: who sees it", () => {
  it("is not offered without organization:purge and organization:legal_hold, and the page asks nothing about the store", async () => {
    const tabs = await open(
      [],
      WITHOUT_PURGE,
      detail(),
      screenContext({ id: CASE, screen: "privacidade-caso" })
    );
    expect(
      byTag(tabs.root, "a").filter(
        (link) => link.textContent === "Purge e trava legal"
      )
    ).toHaveLength(0);

    const mounted = await open([], WITHOUT_PURGE);
    expect(visibleText(mounted.root)).toContain("Sem permissão para isto.");
    expect(mounted.calls.map((call) => call.path)).toEqual([
      "/api/whoami",
      `/api/privacy-cases/${CASE}`,
    ]);
  });

  it("offers both tabs by default, with fixed hrefs, and keeps the closure notice out of the purge tab", async () => {
    const plain = screenContext({ id: CASE, screen: "privacidade-caso" });
    const mounted = await open([store("closed")], MAY, detail(), plain);
    const links = byTag(mounted.root, "a");
    const tab = (text: string) =>
      links.find((link) => link.textContent === text)?.getAttribute("href");
    expect(tab("Etapas e aviso")).toBe(`/privacidade/${CASE}`);
    expect(tab("Purge e trava legal")).toBe(`/privacidade/${CASE}?acao=purge`);
    expect(buttons(mounted.root, "Reemitir o aviso").length).toBeGreaterThan(0);

    const purge = await openClosed();
    expect(buttons(purge.root, "Reemitir o aviso")).toHaveLength(0);
    expect(buttons(purge.root, "Dispensar o aviso")).toHaveLength(0);
    expect(
      purge.calls.filter((call) => call.path.includes("closure-notice"))
    ).toHaveLength(0);
    expect(purge.calls.map((call) => call.path)).toEqual([
      "/api/whoami",
      `/api/privacy-cases/${CASE}`,
      `/api/organizations/${STORE}/diagnostics`,
      "/api/legal-holds?limit=50",
    ]);
  });
});

describe("Purge tab: what the store and the case allow", () => {
  it.each(["active", "closing"])(
    "says only a closed store has a purge when the store is %s",
    async (status) => {
      const mounted = await open([store(status), page()]);
      expect(visibleText(mounted.root)).toContain(ONLY_CLOSED);
      expect(buttons(mounted.root, "Agendar o apagamento")).toHaveLength(0);
    }
  );

  it.each([
    ["an access request", { requestType: "access" }],
    ["a data subject", { requesterKind: "data_subject" }],
    ["a rejected decision", { decision: "reject" }],
    ["a scope without media", { scopeCategories: SCOPE.slice(0, 4) }],
    ["a scope with billing", { scopeCategories: [...SCOPE, "billing"] }],
  ])(
    "asks for an accepted case of the store for %s",
    async (_name, privacy) => {
      const mounted = await openClosed([], detail({ privacy }));
      const panel = panelOf(mounted.root);
      expect(visibleText(panel)).toContain(CASE_REQUIRED);
      expect(
        byTag(panel, "a").some(
          (link) => link.getAttribute("href") === "/privacidade"
        )
      ).toBe(true);
      expect(buttons(mounted.root, "Agendar o apagamento")).toHaveLength(0);
    }
  );

  it("stops the scheduling for a hold found on the second page, and marks a hold past its review", async () => {
    const mounted = await open([
      store("closed"),
      page([], "cursor-2"),
      page([hold()]),
    ]);
    expect(mounted.calls.map((call) => call.path).slice(-2)).toEqual([
      "/api/legal-holds?limit=50",
      "/api/legal-holds?limit=50&after=cursor-2",
    ]);
    const text = visibleText(mounted.root);
    expect(text).toContain(HOLD_STOPS_PURGE);
    expect(text).toContain("Vigente desde");
    expect(text).not.toContain(REVIEW_DUE);
    expect(buttons(mounted.root, "Agendar o apagamento")).toHaveLength(0);

    const due = await open([
      store("closed"),
      page([hold({ reviewDue: true })]),
    ]);
    expect(visibleText(due.root)).toContain(REVIEW_DUE);
    expect(buttons(due.root, "Agendar o apagamento")).toHaveLength(0);
  });

  it("shows the server's checks and computes no date of its own when the case may be scheduled", async () => {
    const mounted = await openClosed();
    const text = visibleText(panelOf(mounted.root));
    expect(text).toContain(SERVER_CHECKS);
    expect(text).not.toContain("2027");
    expect(posts(mounted.calls)).toHaveLength(0);
  });

  it("reads the problem of a case from its own fields", () => {
    expect(purgeCaseProblem(detail())).toBeNull();
    expect(
      purgeCaseProblem(detail({ privacy: { requestType: "access" } }))
    ).not.toBeNull();
  });
});

describe("Purge tab: scheduling", () => {
  it("reviews with the corte's words, the environment, the store's name and ID", async () => {
    expect(
      `${purgeErasedText("a partir de {data do servidor}")} ${PURGE_KEPT}`
    ).toBe(CORTE_WHAT_HAPPENS);
    expect(PURGE_UNDO).toBe(CORTE_UNDO);

    const mounted = await openClosed();
    await click(mounted.root, "Agendar o apagamento");
    const text = visibleText(panelOf(mounted.root));
    expect(text).toContain(purgeErasedText(NEXT_PURGE_CYCLE));
    expect(text).toContain(PURGE_KEPT);
    expect(text).toContain(PURGE_UNDO);
    expect(text).toContain(environmentText(CONTEXT));
    expect(text).toContain("Loja da Ana");
    expect(text).toContain(STORE);
    expect(posts(mounted.calls)).toHaveLength(0);
  });

  it("keeps the confirm button inert until the exact name is typed, and sends nothing before", async () => {
    const mounted = await openClosed();
    const confirm = await toReview(mounted, "");
    expect(
      confirm.textContent.startsWith("Agendar o apagamento da Loja da Ana (…")
    ).toBe(true);
    expect(confirm.textContent).toContain("0000a1)");
    expect(confirm.getAttribute("aria-disabled")).toBe("true");
    for (const wrong of ["", "loja da ana", "Loja da", "Loja da Ana!"]) {
      type(mounted.root, "purge-nome", wrong);
      expect(confirm.getAttribute("aria-disabled")).toBe("true");
      confirm.click();
    }
    await flush();
    expect(posts(mounted.calls)).toHaveLength(0);
    type(mounted.root, "purge-nome", " Loja da Ana ");
    expect(confirm.getAttribute("aria-disabled")).toBe("false");
  });

  it("matches a decomposed name with the same name typed precomposed", async () => {
    const mounted = await openClosed([], detail({ name: "Café" }));
    const confirm = await toReview(mounted, "Café");
    expect(confirm.getAttribute("aria-disabled")).toBe("false");
  });

  it.each(["", "   "])("never enables for a store named %j", async (name) => {
    const mounted = await openClosed([], detail({ name }));
    const confirm = await toReview(mounted, name);
    expect(confirm.getAttribute("aria-disabled")).toBe("true");
    await submit(mounted.root);
    expect(posts(mounted.calls)).toHaveLength(0);
  });

  it("compares names in NFC, trimmed at the ends only, case kept, and never an empty one", () => {
    expect(sameStoreName(" Loja da Ana ", "Loja da Ana")).toBe(true);
    expect(sameStoreName("Café", "Café")).toBe(true);
    expect(sameStoreName("loja da ana", "Loja da Ana")).toBe(false);
    expect(sameStoreName("Loja  da Ana", "Loja da Ana")).toBe(false);
    expect(sameStoreName("", "")).toBe(false);
    expect(sameStoreName("  ", "   ")).toBe(false);
  });

  it("sends one request for two clicks, with the store's ID and never its name, then reads the case again", async () => {
    const wait = pending();
    const mounted = await openClosed([
      wait.answer,
      json(
        detail({
          audit: [
            audit("organization.purge_scheduled", "2026-11-05T15:00:00.000Z"),
          ],
        })
      ),
      store("purge_pending"),
      page(),
    ]);
    await toReview(mounted);
    await submit(mounted.root);
    await submit(mounted.root);
    const sent = posts(mounted.calls);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.path).toBe(`/api/support-cases/${CASE}/purge`);
    expect(bodyOf(sent[0])).toEqual({ organizationId: STORE });

    wait.release(
      json({
        changed: true,
        notBefore: "2026-11-12T15:00:00.000Z",
        status: "purge_pending",
      })
    );
    await flush();
    expect(posts(mounted.calls)).toHaveLength(1);
    expect(mounted.calls.map((call) => call.path).slice(-3)).toEqual([
      `/api/privacy-cases/${CASE}`,
      `/api/organizations/${STORE}/diagnostics`,
      "/api/legal-holds?limit=50",
    ]);
    const text = visibleText(mounted.root);
    expect(text).toContain("Apagamento agendado");
    expect(text).toContain("12/11/2026");
  });

  it.each(Object.keys(PURGE_REFUSALS))(
    "says the sentence of %s and never the code, then reads the case again",
    async (code) => {
      const mounted = await openClosed([
        refusal(code, code === "renewal_status_unavailable" ? 503 : 409),
        ...reread(),
      ]);
      await toReview(mounted);
      await submit(mounted.root);
      expect(posts(mounted.calls)).toHaveLength(1);
      expect(mounted.calls).toHaveLength(8);
      const alert = alertOf(mounted.root);
      expect(alert?.textContent).toBe(purgeRefusalText(code));
      expect(alert?.textContent).not.toContain(code);
    }
  );

  it("says the other store for a mismatch, and does not call a code it does not know a refusal", async () => {
    const mismatch = await openClosed([
      refusal("organization_mismatch"),
      ...reread(),
    ]);
    await toReview(mismatch);
    await submit(mismatch.root);
    expect(alertOf(mismatch.root)?.textContent).toContain("outra loja");

    const unknown = await openClosed([refusal("something_new")]);
    await toReview(unknown);
    await submit(unknown.root);
    expect(alertOf(unknown.root)?.textContent).toBe(COMMAND_UNKNOWN);
    expect(alertOf(unknown.root)?.textContent).not.toBe(REFUSED_GENERIC);
    expect(unknown.calls).toHaveLength(5);
  });

  it.each([
    [
      "a 503 that only says the Admin is not set up",
      json({ error: "admin_not_configured" }, 503),
    ],
    [
      "a 503 of the Access check, not of the store's state",
      json({ error: "unavailable" }, 503),
    ],
    ["a network error", new Error("offline")],
  ])("offers only to read the case again after %s", async (_name, answer) => {
    const mounted = await openClosed([answer]);
    await toReview(mounted);
    await submit(mounted.root);
    expect(alertOf(mounted.root)?.textContent).toBe(COMMAND_UNKNOWN);
    expect(mounted.calls).toHaveLength(5);
    expect(panelButtons(mounted.root)).toEqual(["Reler o caso"]);
  });
});

describe("Purge tab: the states the store can be in", () => {
  it("shows a scheduled purge with the next cycle and the way to cancel", async () => {
    const first = detail({
      audit: [
        audit("organization.purge_scheduled", "2026-11-04T15:00:00.000Z"),
      ],
    });
    const mounted = await open([store("purge_pending"), page()], MAY, first);
    const text = visibleText(panelOf(mounted.root));
    expect(text).toContain("agendado");
    expect(text).toContain(NEXT_PURGE_CYCLE);
    expect(buttons(mounted.root, "Cancelar o agendamento")).toHaveLength(1);
  });

  it("says a cancelled schedule was cancelled", async () => {
    const first = detail({
      audit: [
        audit("organization.purge_scheduled", "2026-11-03T15:00:00.000Z"),
        audit("organization.purge_cancelled", "2026-11-04T15:00:00.000Z"),
      ],
    });
    const mounted = await open([store("closed"), page()], MAY, first);
    expect(visibleText(panelOf(mounted.root))).toContain("cancelado");
  });

  it("offers nothing to do for a purged store", async () => {
    const mounted = await open([store("purged"), page()]);
    expect(visibleText(panelOf(mounted.root))).toContain(PURGE_DONE);
    expect(panelButtons(mounted.root)).toEqual([]);
  });
});

describe("Purge tab: what a schedule says while it cannot run or after it ends", () => {
  it("says a scheduled purge does not run under a hold in force, without the sentence of when it erases", async () => {
    const mounted = await open([store("purge_pending"), page([hold()])]);
    const text = visibleText(panelOf(mounted.root));
    expect(text).toContain("não roda enquanto ela não for liberada");
    expect(text).not.toContain("Os dados serão apagados");
  });

  it("forgets the start the server gave once that schedule was cancelled", async () => {
    const mounted = await openClosed([
      json({
        changed: true,
        notBefore: "2026-11-12T15:00:00.000Z",
        status: "purge_pending",
      }),
      ...reread("purge_pending"),
    ]);
    await toReview(mounted);
    await submit(mounted.root);
    expect(visibleText(panelOf(mounted.root))).toContain("12/11/2026");
    mounted.queue.push(
      json({ changed: true, status: "closed" }),
      ...reread("closed"),
      ...reread("purge_pending")
    );
    await click(mounted.root, "Cancelar o agendamento");
    byId(mounted.root, "purge-cancelar-motivo").value = "pedido do dono";
    await click(mounted.root, "Revisar o cancelamento");
    await click(mounted.root, "Confirmar o cancelamento do agendamento");
    // another schedule, made elsewhere, is read when the operator goes back from a review
    await click(mounted.root, "Agendar o apagamento");
    await click(mounted.root, "Voltar");
    expect(visibleText(panelOf(mounted.root))).toContain(NEXT_PURGE_CYCLE);
    expect(visibleText(panelOf(mounted.root))).not.toContain("12/11/2026");
  });
});

describe("Purge tab: cancelling the schedule", () => {
  const scheduled = () =>
    open(
      [store("purge_pending"), page()],
      MAY,
      detail({
        audit: [
          audit("organization.purge_scheduled", "2026-11-04T15:00:00.000Z"),
        ],
      })
    );
  const submitReason = async (root: FakeElement, reason: string) => {
    byId(root, "purge-cancelar-motivo").value = reason;
    await click(root, "Revisar o cancelamento");
  };

  it.each([
    ["empty", ""],
    ["blank", "   "],
    ["501 characters", "a".repeat(501)],
  ])("refuses a reason that is %s and sends nothing", async (_name, reason) => {
    const mounted = await scheduled();
    await click(mounted.root, "Cancelar o agendamento");
    await submitReason(mounted.root, reason);
    expect(
      buttons(mounted.root, "Confirmar o cancelamento do agendamento")
    ).toHaveLength(0);
    expect(posts(mounted.calls)).toHaveLength(0);
    if (reason.trim() === "") {
      expect(visibleText(mounted.root)).toContain(
        "Escreva o motivo do cancelamento"
      );
    }
  });

  it.each(["x", "b".repeat(500)])(
    "reviews a reason of %#, then sends it trimmed in one request",
    async (reason) => {
      const mounted = await open(
        [
          store("purge_pending"),
          page(),
          json({ changed: true, status: "closed" }),
          ...reread(),
        ],
        MAY,
        detail({
          audit: [
            audit("organization.purge_scheduled", "2026-11-04T15:00:00.000Z"),
          ],
        })
      );
      await click(mounted.root, "Cancelar o agendamento");
      await submitReason(mounted.root, `  ${reason}  `);
      const text = visibleText(panelOf(mounted.root));
      expect(text).toContain(CANCEL_EFFECT);
      expect(text).toContain(CANCEL_UNDO);
      await click(mounted.root, "Confirmar o cancelamento do agendamento");
      const sent = posts(mounted.calls);
      expect(sent).toHaveLength(1);
      expect(sent[0]?.path).toBe(`/api/support-cases/${CASE}/purge/cancel`);
      expect(bodyOf(sent[0])).toEqual({ organizationId: STORE, reason });
    }
  );

  it.each(["purge_in_progress", "purge_storage_touched"])(
    "says %s in words",
    async (code) => {
      const mounted = await open(
        [
          store("purge_pending"),
          page(),
          refusal(code),
          ...reread("purge_pending"),
        ],
        MAY,
        detail({
          audit: [
            audit("organization.purge_scheduled", "2026-11-04T15:00:00.000Z"),
          ],
        })
      );
      await click(mounted.root, "Cancelar o agendamento");
      await submitReason(mounted.root, "motivo");
      await click(mounted.root, "Confirmar o cancelamento do agendamento");
      expect(alertOf(mounted.root)?.textContent).toBe(purgeRefusalText(code));
    }
  );
});

describe("Purge tab: the legal hold", () => {
  it("asks for the date, reviews it, and sends the end of the day in Brasília without any free text", async () => {
    const mounted = await openClosed([
      json({ changed: true, held: true }),
      ...reread(),
    ]);
    await click(mounted.root, "Pôr trava legal");
    await click(mounted.root, "Revisar a trava legal");
    expect(visibleText(mounted.root)).toContain("Escolha a data de revisão.");
    expect(posts(mounted.calls)).toHaveLength(0);

    byId(mounted.root, "purge-trava-data").value = "2026-12-01";
    await click(mounted.root, "Revisar a trava legal");
    const text = visibleText(panelOf(mounted.root));
    expect(text).toContain(holdEffectText("01/12/2026"));
    expect(text).toContain(HOLD_UNDO);
    await click(mounted.root, "Confirmar a trava legal");
    const sent = posts(mounted.calls);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.path).toBe(`/api/support-cases/${CASE}/legal-hold`);
    expect(bodyOf(sent[0])).toEqual({
      organizationId: STORE,
      reviewAt: "2026-12-01T23:59:59-03:00",
    });
  });

  it("says the sentence of a review date the server did not accept", async () => {
    const mounted = await openClosed([
      json({ error: "invalid_review_at" }, 400),
      ...reread(),
    ]);
    await click(mounted.root, "Pôr trava legal");
    byId(mounted.root, "purge-trava-data").value = "2026-12-01";
    await click(mounted.root, "Revisar a trava legal");
    await click(mounted.root, "Confirmar a trava legal");
    expect(alertOf(mounted.root)?.textContent).toBe(
      purgeRefusalText("invalid_review_at")
    );
    expect(mounted.calls).toHaveLength(8);
  });

  it("releases a hold in force after a review, with the store's ID alone", async () => {
    const mounted = await open([
      store("closed"),
      page([hold()]),
      json({ changed: true, held: false }),
      ...reread(),
    ]);
    await click(mounted.root, "Liberar trava legal");
    expect(visibleText(panelOf(mounted.root))).toContain(RELEASE_EFFECT);
    expect(posts(mounted.calls)).toHaveLength(0);
    await click(mounted.root, "Liberar trava legal");
    const sent = posts(mounted.calls);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.path).toBe(`/api/support-cases/${CASE}/legal-hold/release`);
    expect(bodyOf(sent[0])).toEqual({ organizationId: STORE });
  });

  it("puts nothing of the store's name, the reason or the date in an address", async () => {
    const mounted = await open(
      [
        store("purge_pending"),
        page(),
        json({ changed: true, status: "closed" }),
        ...reread(),
      ],
      MAY,
      detail({
        audit: [
          audit("organization.purge_scheduled", "2026-11-04T15:00:00.000Z"),
        ],
      })
    );
    await click(mounted.root, "Cancelar o agendamento");
    byId(mounted.root, "purge-cancelar-motivo").value = "motivo reservado";
    await click(mounted.root, "Revisar o cancelamento");
    await click(mounted.root, "Confirmar o cancelamento do agendamento");
    const addresses = mounted.calls.map((call) => call.path).join("\n");
    expect(addresses).not.toMatch(TRACE);
    expect(mounted.navigations).toEqual([]);
  });
});
