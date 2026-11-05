import { describe, expect, it } from "vitest";
import { CLOSURE_NOTICE_DISMISSALS } from "./privacy";
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
import {
  DISMISS_EFFECT,
  DISMISS_UNDO,
  NOTICE_READ_FAILED,
  NOTICE_REFUSALS,
  NOTICE_REFUSED_GENERIC,
  NOTICE_UNKNOWN,
  REISSUE_EFFECT,
  REISSUE_UNDO,
  refusalText,
} from "./closure-notice-words";

/**
 * "Aviso de encerramento" in the privacy case (corte admin-v2, Parte 12): the section exists only for the case of a
 * closed store and an operator who may purge and read the store; reissue and dismiss are each reviewed in two steps
 * and sent once; the refusals of the server are said in words; the case, and so the section, is read again after an
 * answer; and no purge is scheduled or cancelled from here (AC-P12.1 to AC-P12.3, AC-C2 to AC-C4).
 */

const CASE = "0199a0a0-0000-7000-8000-00000000c0de";
const STORE = "0199a0a0-0000-7000-8000-0000000000a1";
const NOW = new Date("2026-11-05T15:00:00.000Z");
const TECHNICAL =
  /closure_notice|organization_|privacy_|invalid_|\b40\d\b|\b50\d\b/;

const MAY_ACT = {
  ...OWNER,
  capabilities: [
    ...OWNER.capabilities,
    "privacy_case:manage",
    "organization:purge",
  ],
};
const WITHOUT_PURGE = {
  ...OWNER,
  capabilities: [...OWNER.capabilities, "privacy_case:manage"],
};
const WITHOUT_DIAGNOSE = {
  ...OWNER,
  capabilities: ["platform:read", "privacy_case:manage", "organization:purge"],
};

function detail(
  overrides: Partial<PrivacyCaseDetail["case"]> = {}
): PrivacyCaseDetail {
  return {
    actions: [],
    audit: [],
    case: {
      closedAt: null,
      id: CASE,
      openedAt: "2026-10-30T15:00:00.000Z",
      organizationId: STORE,
      organizationName: "Loja da Ana",
      resolution: null,
      status: "open",
      ...overrides,
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
      scopeCategories: ["customers"],
      stage: "decided",
      subjectReference: null,
    },
  } as PrivacyCaseDetail;
}

const closedStore = () =>
  json(diagnostics({ id: STORE, name: "Loja da Ana", status: "closed" }));

const openCase = (answers: Answer[], who = MAY_ACT, first = detail()) =>
  mount(
    [json(first), ...answers],
    json(who),
    () => NOW,
    screenContext({ id: CASE, screen: "privacidade-caso" })
  );

const posts = (calls: Call[]) =>
  calls.filter((call) => call.init.method === "POST");
const bodyOf = (call: Call | undefined) =>
  JSON.parse(String(call?.init.body ?? "null"));

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

const sectionOf = (root: FakeElement) =>
  allElements(root).find(
    (element) => element.getAttribute("id") === "aviso-encerramento-titulo"
  );

const panelOf = (root: FakeElement) =>
  allElements(root).find((element) =>
    (element.getAttribute("class") ?? "").startsWith("closure-notice ")
  );

function pending() {
  let release: (response: Response) => void = () => undefined;
  const answer: Answer = () =>
    new Promise<Response>((resolve) => {
      release = resolve;
    });
  return { answer, release: (response: Response) => release(response) };
}

const IN_ADDRESS = /motivo|reason|email_|aviso/;
const DONE = { dismissed: false, noticeId: "n-1", reissue: 1 };
const refusal = (code: string) => json({ error: code, message: "x" }, 409);

describe("Aviso de encerramento: where the section exists (AC-P12.1)", () => {
  it("is in the case of a closed store, for an operator who may purge and read the store, with the store and the case in view", async () => {
    const mounted = await openCase([closedStore()]);
    expect(mounted.calls.map((call) => call.path)).toEqual([
      "/api/whoami",
      `/api/privacy-cases/${CASE}`,
      `/api/organizations/${STORE}/diagnostics`,
    ]);
    expect(sectionOf(mounted.root)).toBeDefined();
    const text = visibleText(mounted.root);
    expect(text).toContain("Aviso de encerramento");
    expect(text).toContain("Loja da Ana");
    expect(text).toContain(STORE);
    expect(buttons(mounted.root, "Reemitir o aviso").length).toBeGreaterThan(0);
    expect(buttons(mounted.root, "Dispensar o aviso").length).toBeGreaterThan(
      0
    );
  });

  it("is not in the page without the capability to purge, and the store is not even read", async () => {
    const mounted = await openCase([], WITHOUT_PURGE);
    expect(mounted.calls.map((call) => call.path)).toEqual([
      "/api/whoami",
      `/api/privacy-cases/${CASE}`,
    ]);
    expect(sectionOf(mounted.root)).toBeUndefined();
    expect(visibleText(mounted.root)).not.toContain("Aviso de encerramento");
    expect(buttons(mounted.root, "Reemitir").length).toBe(0);
    expect(buttons(mounted.root, "Dispensar").length).toBe(0);
  });

  it("is not in the page without the capability to read the store, which is the only place the state of the store is", async () => {
    const mounted = await openCase([], WITHOUT_DIAGNOSE);
    expect(mounted.calls).toHaveLength(2);
    expect(sectionOf(mounted.root)).toBeUndefined();
  });

  it.each(["active", "suspended", "closing", "purge_pending", "purged"])(
    "is not in the page when the store is %s",
    async (status) => {
      const mounted = await openCase([
        json(diagnostics({ id: STORE, status })),
      ]);
      expect(mounted.calls).toHaveLength(3);
      expect(sectionOf(mounted.root)).toBeUndefined();
      expect(visibleText(mounted.root)).not.toContain("Aviso de encerramento");
      expect(buttons(mounted.root, "Reemitir").length).toBe(0);
    }
  );

  it("is not in the page for a case that is already closed, and the store is not read", async () => {
    const mounted = await openCase(
      [],
      MAY_ACT,
      detail({ closedAt: "2026-11-01T15:00:00.000Z", status: "closed" })
    );
    expect(mounted.calls).toHaveLength(2);
    expect(sectionOf(mounted.root)).toBeUndefined();
  });

  it("says the store could not be read, and shows no act, when the read fails or answers another store", async () => {
    const mounts = await Promise.all(
      [
        json({ error: "x" }, 500),
        json(diagnostics({ id: "another-store", status: "closed" })),
      ].map((answer) => openCase([answer]))
    );
    for (const mounted of mounts) {
      expect(visibleText(mounted.root)).toContain(NOTICE_READ_FAILED);
      expect(sectionOf(mounted.root)).toBeUndefined();
      expect(buttons(mounted.root, "Reemitir").length).toBe(0);
    }
  });

  it("writes the store's name as text, never as HTML", async () => {
    const hostile = "<img src=x onerror=alert(1)>";
    const mounted = await openCase(
      [json(diagnostics({ id: STORE, status: "closed" }))],
      MAY_ACT,
      detail({ organizationName: hostile })
    );
    expect(byTag(mounted.root, "img")).toHaveLength(0);
    expect(visibleText(mounted.root)).toContain(hostile);
  });
});

describe("Aviso de encerramento: reissue (AC-P12.1, AC-C2, AC-C4)", () => {
  it("reviews in two steps with the effect said, and sends nothing until the confirmation", async () => {
    const mounted = await openCase([closedStore()]);
    await click(mounted.root, "Reemitir o aviso");
    const text = visibleText(mounted.root);
    expect(text).toContain("Revise antes de reemitir o aviso");
    expect(text).toContain("STAGING");
    expect(text).toContain("Loja da Ana");
    expect(text).toContain("Caso de privacidade aberto em 30/10/2026");
    expect(text).toContain(
      "Um aviso novo é enviado ao dono atual. O aviso anterior não é alterado."
    );
    expect(text).toContain(REISSUE_EFFECT);
    expect(text).toContain(REISSUE_UNDO);
    expect(text).toContain("Dá para desfazer");
    expect(text).toContain("Fica no registro");
    expect(posts(mounted.calls)).toHaveLength(0);
    const heading = allElements(mounted.root).find(
      (element) => element.getAttribute("id") === "aviso-encerramento-revisao"
    );
    expect(heading?.getAttribute("tabindex")).toBe("-1");
    await click(mounted.root, "Voltar");
    expect(buttons(mounted.root, "Reemitir o aviso").length).toBeGreaterThan(0);
    expect(posts(mounted.calls)).toHaveLength(0);
  });

  it("sends one request with only the store named, on a double click, and then reads the case and the store again", async () => {
    const wait = pending();
    const mounted = await openCase([
      closedStore(),
      wait.answer,
      json(detail()),
      closedStore(),
    ]);
    await click(mounted.root, "Reemitir o aviso");
    const confirm = firstButton(mounted.root, "Confirmar reemissão do aviso");
    confirm.click();
    confirm.click();
    await flush();
    expect(confirm.getAttribute("aria-disabled")).toBe("true");
    expect(posts(mounted.calls)).toHaveLength(1);
    expect(posts(mounted.calls)[0]?.path).toBe(
      `/api/support-cases/${CASE}/closure-notice/reissue`
    );
    expect(bodyOf(posts(mounted.calls)[0])).toEqual({
      organizationId: STORE,
    });
    wait.release(json(DONE));
    await flush();
    expect(mounted.calls.map((call) => call.path).slice(3)).toEqual([
      `/api/support-cases/${CASE}/closure-notice/reissue`,
      `/api/privacy-cases/${CASE}`,
      `/api/organizations/${STORE}/diagnostics`,
    ]);
    expect(visibleText(mounted.root)).toContain("Aviso reemitido.");
    expect(buttons(mounted.root, "Reemitir o aviso").length).toBeGreaterThan(0);
    expect(posts(mounted.calls)).toHaveLength(1);
  });

  it("says a refusal in words, with no code, and reads the case again", async () => {
    const mounted = await openCase([
      closedStore(),
      refusal("closure_notice_delivered"),
      json(detail()),
      closedStore(),
    ]);
    await click(mounted.root, "Reemitir o aviso");
    await click(mounted.root, "Confirmar reemissão do aviso");
    const alert = alertOf(mounted.root);
    expect(alert?.textContent).toBe(refusalText("closure_notice_delivered"));
    expect(alert?.textContent).not.toMatch(TECHNICAL);
    expect(mounted.calls).toHaveLength(6);
  });

  it("does not confirm a write whose outcome it cannot see: it offers only to read the case again, and sends nothing more", async () => {
    const mounted = await openCase([
      closedStore(),
      new Error("network"),
      json(detail()),
      closedStore(),
    ]);
    await click(mounted.root, "Reemitir o aviso");
    await click(mounted.root, "Confirmar reemissão do aviso");
    expect(alertOf(mounted.root)?.textContent).toBe(NOTICE_UNKNOWN);
    expect(
      firstButton(mounted.root, "Confirmar reemissão do aviso").getAttribute(
        "hidden"
      )
    ).toBe("");
    await click(mounted.root, "Reler o caso");
    expect(posts(mounted.calls)).toHaveLength(1);
    expect(mounted.calls).toHaveLength(6);
  });
});

describe("Aviso de encerramento: dismiss (AC-P12.2)", () => {
  it("offers only the three reasons of the list, with none chosen and no free text", async () => {
    const mounted = await openCase([closedStore()]);
    await click(mounted.root, "Dispensar o aviso");
    const select = byId(mounted.root, "aviso-encerramento-motivo");
    expect(select.value).toBe("");
    const options = byTag(select, "option").map((option) => [
      option.getAttribute("value"),
      option.textContent,
    ]);
    expect(options).toEqual([
      ["", "Escolha…"],
      ...CLOSURE_NOTICE_DISMISSALS.map(([code, words]) => [code, words]),
    ]);
    expect(CLOSURE_NOTICE_DISMISSALS.map(([code]) => code)).toEqual([
      "owner_account_deleted",
      "email_not_verified",
      "email_undeliverable",
    ]);
    const section = panelOf(mounted.root);
    expect(section).toBeDefined();
    expect(byTag(section as FakeElement, "input")).toHaveLength(0);
    expect(byTag(section as FakeElement, "textarea")).toHaveLength(0);
  });

  it("asks for a reason when none is chosen, and sends nothing", async () => {
    const mounted = await openCase([closedStore()]);
    await click(mounted.root, "Dispensar o aviso");
    await click(mounted.root, "Revisar a dispensa");
    expect(
      byId(mounted.root, "aviso-encerramento-motivo-erro").textContent
    ).toBe("Escolha o motivo da dispensa.");
    expect(visibleText(mounted.root)).not.toContain(
      "Revise antes de dispensar o aviso"
    );
    expect(posts(mounted.calls)).toHaveLength(0);
  });

  it("refuses a value outside the list: only the codes of the list are sent", async () => {
    const mounted = await openCase([closedStore()]);
    await click(mounted.root, "Dispensar o aviso");
    const select = byId(mounted.root, "aviso-encerramento-motivo");
    select.value = "outro motivo";
    select.dispatch("change");
    await click(mounted.root, "Revisar a dispensa");
    expect(posts(mounted.calls)).toHaveLength(0);
    expect(visibleText(mounted.root)).not.toContain(
      "Revise antes de dispensar o aviso"
    );
  });

  it.each(CLOSURE_NOTICE_DISMISSALS)(
    "reviews and sends the reason %s as its code, once, with the effect said",
    async (code, words) => {
      const wait = pending();
      const mounted = await openCase([
        closedStore(),
        wait.answer,
        json(detail()),
        closedStore(),
      ]);
      await click(mounted.root, "Dispensar o aviso");
      const select = byId(mounted.root, "aviso-encerramento-motivo");
      select.value = code;
      select.dispatch("change");
      await click(mounted.root, "Revisar a dispensa");
      const text = visibleText(mounted.root);
      expect(text).toContain("Revise antes de dispensar o aviso");
      expect(text).toContain("Loja da Ana");
      expect(text).toContain(words);
      expect(text).toContain(
        "A dispensa conta como entregue para o apagamento, que ainda espera 7 dias. Isso não poderá ser desfeito."
      );
      expect(text).toContain(DISMISS_EFFECT);
      expect(text).toContain(DISMISS_UNDO);
      expect(posts(mounted.calls)).toHaveLength(0);
      const confirm = firstButton(mounted.root, "Confirmar dispensa do aviso");
      confirm.click();
      confirm.click();
      await flush();
      expect(posts(mounted.calls)).toHaveLength(1);
      expect(posts(mounted.calls)[0]?.path).toBe(
        `/api/support-cases/${CASE}/closure-notice/dismiss`
      );
      expect(bodyOf(posts(mounted.calls)[0])).toEqual({
        organizationId: STORE,
        reason: code,
      });
      wait.release(json({ ...DONE, dismissed: true }));
      await flush();
      expect(visibleText(mounted.root)).toContain("Aviso dispensado.");
      expect(mounted.calls).toHaveLength(6);
    }
  );

  it("goes back from the review to the choice, keeping the page", async () => {
    const mounted = await openCase([closedStore()]);
    await click(mounted.root, "Dispensar o aviso");
    const select = byId(mounted.root, "aviso-encerramento-motivo");
    select.value = "owner_account_deleted";
    select.dispatch("change");
    await click(mounted.root, "Revisar a dispensa");
    await click(mounted.root, "Voltar");
    expect(byId(mounted.root, "aviso-encerramento-motivo")).toBeDefined();
    expect(posts(mounted.calls)).toHaveLength(0);
  });

  it.each(Object.entries(NOTICE_REFUSALS))(
    "says the refusal %s in words, without the code, and reads the case again",
    async (code, sentence) => {
      const mounted = await openCase([
        closedStore(),
        refusal(code),
        json(detail()),
        closedStore(),
      ]);
      await click(mounted.root, "Dispensar o aviso");
      const select = byId(mounted.root, "aviso-encerramento-motivo");
      select.value = "email_not_verified";
      select.dispatch("change");
      await click(mounted.root, "Revisar a dispensa");
      await click(mounted.root, "Confirmar dispensa do aviso");
      const alert = alertOf(mounted.root);
      expect(alert?.textContent).toBe(sentence);
      expect(alert?.textContent).not.toMatch(TECHNICAL);
      expect(mounted.calls).toHaveLength(6);
      expect(posts(mounted.calls)).toHaveLength(1);
    }
  );

  it("says a refusal it does not know in a generic sentence, never the code", async () => {
    const mounted = await openCase([
      closedStore(),
      refusal("something_new_of_the_server"),
      json(detail()),
      closedStore(),
    ]);
    await click(mounted.root, "Reemitir o aviso");
    await click(mounted.root, "Confirmar reemissão do aviso");
    expect(alertOf(mounted.root)?.textContent).toBe(NOTICE_REFUSED_GENERIC);
    expect(visibleText(mounted.root)).not.toContain("something_new");
  });

  it.each([
    [403, "Sem permissão para isto."],
    [404, "Este caso não foi encontrado."],
  ])(
    "says a %s as the page's sentence and reads the case again",
    async (status, sentence) => {
      const mounted = await openCase([
        closedStore(),
        json({ error: "x" }, status),
        json(detail()),
        closedStore(),
      ]);
      await click(mounted.root, "Reemitir o aviso");
      await click(mounted.root, "Confirmar reemissão do aviso");
      expect(alertOf(mounted.root)?.textContent).toBe(sentence);
      expect(mounted.calls).toHaveLength(6);
    }
  );

  it("keeps the confirmation open after a 429, for a later try, and does not read again", async () => {
    const mounted = await openCase([
      closedStore(),
      json({ error: "rate_limited" }, 429),
    ]);
    await click(mounted.root, "Reemitir o aviso");
    await click(mounted.root, "Confirmar reemissão do aviso");
    expect(alertOf(mounted.root)?.textContent).toContain("Muitas consultas");
    expect(
      firstButton(mounted.root, "Confirmar reemissão do aviso").getAttribute(
        "aria-disabled"
      )
    ).toBe("false");
    expect(mounted.calls).toHaveLength(4);
  });
});

describe("Aviso de encerramento: it is not the purge (AC-P12.3, AC-C6)", () => {
  it("calls no purge route and names no purge in its words", async () => {
    const mounted = await openCase([
      closedStore(),
      json(DONE),
      json(detail()),
      closedStore(),
    ]);
    await click(mounted.root, "Reemitir o aviso");
    await click(mounted.root, "Confirmar reemissão do aviso");
    for (const call of mounted.calls) {
      expect(call.path).not.toContain("purge");
      expect(call.path).not.toContain("legal-hold");
    }
    const section = panelOf(mounted.root);
    expect(section).toBeDefined();
    expect(visibleText(section as FakeElement).toLowerCase()).not.toContain(
      "purge"
    );
    expect(buttons(section as FakeElement, "Agendar").length).toBe(0);
    expect(buttons(section as FakeElement, "Cancelar").length).toBe(0);
  });

  it("puts nothing about the store, the case or the reason in an address, and no reason in a field name or a link", async () => {
    const mounted = await openCase([closedStore()]);
    for (const call of mounted.calls) {
      expect(call.path).not.toMatch(IN_ADDRESS);
    }
    const links = byTag(mounted.root, "a").map(
      (link) => link.getAttribute("href") ?? ""
    );
    for (const href of links) {
      expect(href).not.toMatch(IN_ADDRESS);
    }
  });
});
