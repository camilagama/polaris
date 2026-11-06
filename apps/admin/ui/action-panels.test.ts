import { describe, expect, it } from "vitest";
import { DISMISS_UNDO, REISSUE_UNDO } from "./closure-notice-words";
import {
  EFFECT_LINES,
  type EffectKey,
  MAX_EFFECT_LENGTH,
} from "./effect-lines";
import {
  CANCEL_RULE,
  CANCEL_UNDO,
  HOLD_UNDO,
  RELEASE_UNDO,
} from "./purge-words";
import { REFUND_UNDO } from "./refund-words";
import {
  allElements,
  buttons,
  byTag,
  type FakeElement,
  visibleText,
} from "./test-dom";
import {
  type Answer,
  diagnostics,
  flush,
  json,
  mount,
  OWNER,
  screenContext,
} from "./test-page";
import type { PrivacyCaseDetail, SupportCaseDetail } from "./types";
import { END_ACCESS_UNDO } from "./views/access";
import { CLOSE_UNDO } from "./views/case";
import { END_UNDO, GRANT_UNDO } from "./views/entitlements";
import { RETRY_EFFECT } from "./views/incident";
import { STEP_UNDO } from "./views/privacy-case";
import { REACTIVATE_UNDO, SUSPEND_UNDO } from "./views/store-actions";
import { REVEAL_SECONDS } from "./views/reveal";

/**
 * The anatomy of the Admin's action panels (AC-CP1, AC-CP3, AC-CP4, AC-CP8) and the sentence of effect above the first
 * button of every action of the list (AC-CL2), read from the screens in a small DOM: heading, situation, effect, fields,
 * button, record, in that order; at most one ink button; the panels of a case in the order of the cut.
 */

const CASE = "0199a0a0-0000-7000-8000-00000000c0de";
const STORE = "0199a0a0-0000-7000-8000-0000000000a1";
const GRANT = "0199a0a0-0000-7000-8000-0000000000b1";
const CUSTOMER = "0199a0a0-0000-7000-8000-0000000000c1";
const OPENED_AT = "2026-10-28T13:05:00.000Z";
const NOW = new Date("2026-10-28T15:07:00.000Z");
const PRIVACY_NOW = new Date("2026-11-05T15:00:00.000Z");
const UNDOES = /dá para/i;
const HEADING = /^h[34]$/;

const classesOf = (element: FakeElement) =>
  (element.getAttribute("class") ?? "").split(" ").filter(Boolean);
const hasClass = (element: FakeElement, name: string) =>
  classesOf(element).includes(name);

const isShown = (element: FakeElement): boolean => {
  for (
    let current: FakeElement | null = element;
    current !== null;
    current = current.parent
  ) {
    if (current.hasAttribute("hidden")) {
      return false;
    }
  }
  return true;
};

const isInk = (button: FakeElement) =>
  !(hasClass(button, "secondary") || hasClass(button, "ghost"));

const inkButtons = (scope: FakeElement) =>
  byTag(scope, "button").filter(isShown).filter(isInk);

const panelsOf = (root: FakeElement) =>
  allElements(root).filter(
    (element) =>
      element.tagName === "section" && hasClass(element, "action-panel")
  );

const headingOf = (panel: FakeElement) =>
  allElements(panel).find((element) => HEADING.test(element.tagName));

/** The order of a panel's parts, by position in the document; -1 where a part is missing. */
function anatomy(panel: FakeElement) {
  const order = allElements(panel).filter(isShown);
  const first = (test: (element: FakeElement) => boolean) =>
    order.findIndex(test);
  const heading = first((element) => HEADING.test(element.tagName));
  const situation = first(
    (element) =>
      (hasClass(element, "hint") || hasClass(element, "status")) &&
      !hasClass(element, "record") &&
      element.textContent !== ""
  );
  const effect = first((element) => hasClass(element, "effect"));
  const button = first((element) => element.tagName === "button");
  const record = order.findIndex(
    (element, index) => index > button && hasClass(element, "record")
  );
  return { button, effect, heading, record, situation };
}

function expectAnatomy(panel: FakeElement) {
  const at = anatomy(panel);
  const name = headingOf(panel)?.textContent ?? "(no heading)";
  expect(at.heading, `${name}: heading first`).toBe(1);
  expect(at.situation, `${name}: situation after the heading`).toBeGreaterThan(
    at.heading
  );
  expect(at.effect, `${name}: effect after the situation`).toBeGreaterThan(
    at.situation
  );
  expect(at.button, `${name}: button after the effect`).toBeGreaterThan(
    at.effect
  );
  expect(at.record, `${name}: record after the button`).toBeGreaterThan(
    at.button
  );
  for (const effect of allElements(panel).filter((element) =>
    hasClass(element, "effect")
  )) {
    expect(effect.textContent.length, effect.textContent).toBeLessThanOrEqual(
      MAX_EFFECT_LENGTH
    );
    expect(effect.textContent).toMatch(UNDOES);
  }
}

const click = async (root: FakeElement, text: string) => {
  const [target] = buttons(root, text);
  if (target === undefined) {
    throw new Error(`no button ${text}`);
  }
  target.click();
  await flush();
};

const effectBefore = (
  root: FakeElement,
  buttonText: string,
  key: EffectKey
) => {
  const order = allElements(root);
  const button = order.findIndex(
    (element) =>
      element.tagName === "button" && element.textContent === buttonText
  );
  expect(button, `button ${buttonText}`).toBeGreaterThan(-1);
  const effect = order.findIndex(
    (element) =>
      hasClass(element, "effect") && element.textContent === EFFECT_LINES[key]
  );
  expect(effect, `effect ${key}`).toBeGreaterThan(-1);
  expect(effect).toBeLessThan(button);
};

describe("the sentences of effect", () => {
  it.each(Object.entries(EFFECT_LINES))(
    "%s fits in 120 characters and says it can be undone or not",
    (_key, text) => {
      expect(text.length).toBeLessThanOrEqual(MAX_EFFECT_LENGTH);
      expect(text).toMatch(UNDOES);
    }
  );

  it.each([
    ["grantEnd", END_UNDO],
    ["reissueNotice", REISSUE_UNDO],
    ["dismissNotice", DISMISS_UNDO],
    ["closeCase", CLOSE_UNDO],
    ["refund", REFUND_UNDO],
    ["suspend", SUSPEND_UNDO],
    ["reactivate", REACTIVATE_UNDO],
    ["purgeCancel", CANCEL_UNDO],
    ["holdPlace", HOLD_UNDO],
    ["holdPlaced", RELEASE_UNDO],
    ["grantGive", GRANT_UNDO],
    ["accessEndOnly", END_ACCESS_UNDO],
    ["stepScope", STEP_UNDO],
    ["stepRole", STEP_UNDO],
    ["stepIdentity", STEP_UNDO],
    ["stepActions", STEP_UNDO],
    ["stepDecision", STEP_UNDO],
  ] as const)(
    "%s answers 'dá para desfazer' the way the review of the same action does",
    (key, undo) => {
      expect(EFFECT_LINES[key].includes("Não dá para")).toBe(
        undo.startsWith("Não")
      );
    }
  );

  it("does not promise a cancellation the server refuses, and does not hide that the refund ends the Pro at once", () => {
    expect(CANCEL_RULE).toContain("enquanto nenhuma execução estiver em curso");
    expect(EFFECT_LINES.purgeSchedule).toContain(
      "enquanto o apagamento não começar"
    );
    expect(EFFECT_LINES.purgeSchedule).not.toContain("primeiro arquivo");
    expect(EFFECT_LINES.refund).toContain(
      "quando ele confirmar, o Pro da loja acaba na hora, sem carência"
    );
    expect(EFFECT_LINES.refund.toLowerCase()).not.toContain("o valor volta");
  });

  it("keeps the reveal time and the retry sentence in step with the code that does them", () => {
    expect(EFFECT_LINES.reveal).toContain(`${REVEAL_SECONDS} segundos`);
    expect(RETRY_EFFECT.length).toBeLessThanOrEqual(MAX_EFFECT_LENGTH);
    expect(RETRY_EFFECT).toContain("é seguro");
  });
});

const CASE_CAPABILITIES = {
  ...OWNER,
  capabilities: [
    ...OWNER.capabilities,
    "organization:suspend",
    "organization:classify",
    "tenant_access:grant",
    "tenant_data:read",
    "pii:reveal",
  ],
};

const supportDetail = (grants: SupportCaseDetail["grants"] = []) =>
  ({
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
    },
    grants,
  }) satisfies SupportCaseDetail;

const OWN_ACCESS = {
  active: true,
  expiresAt: "2026-10-28T16:00:00.000Z",
  id: GRANT,
  principalId: OWNER.principal.id,
  revokedAt: null,
  startsAt: "2026-10-28T14:00:00.000Z",
};

const openCase = (
  answers: Answer[],
  grants: SupportCaseDetail["grants"] = []
) =>
  mount(
    [json(supportDetail(grants)), ...answers],
    json(CASE_CAPABILITIES),
    () => NOW,
    screenContext({ id: CASE, screen: "caso" })
  );

const storeState = (status: string) => json(diagnostics({ id: STORE, status }));

const SEQUENCE = [
  "Suspender ou reativar a loja",
  "Dar plano ou limite temporário",
  "Ver clientes da loja",
  "Loja interna",
  "Fechar atendimento",
  "O que foi feito neste atendimento",
];

describe("the screen of a support case", () => {
  it.each([
    [
      "with no access to customers",
      [] as SupportCaseDetail["grants"],
      "active",
    ],
    ["with an access in use, on a suspended store", [OWN_ACCESS], "suspended"],
  ] as const)(
    "lists its panels in the order of the cut, %s",
    async (_name, grants, status) => {
      const { root } = await openCase([storeState(status)], [...grants]);

      const titles = byTag(root, "h3").map((heading) => heading.textContent);
      expect(titles).toEqual(SEQUENCE);
      expect(byTag(root, "h2")[0]?.textContent).toBe("Dados do atendimento");
    }
  );

  it.each([
    [
      "with no access to customers",
      [] as SupportCaseDetail["grants"],
      "active",
    ],
    ["with an access in use, on a suspended store", [OWN_ACCESS], "suspended"],
  ] as const)(
    "gives every panel the same anatomy and at most one ink button, %s",
    async (_name, grants, status) => {
      const { root } = await openCase([storeState(status)], [...grants]);

      const panels = panelsOf(root);
      expect(panels).toHaveLength(5);
      for (const panel of panels) {
        expectAnatomy(panel);
        expect(inkButtons(panel).length).toBeLessThanOrEqual(1);
      }
    }
  );

  it("makes Fechar atendimento a button of outline, so the ink stays with the actions on the store", async () => {
    const { root } = await openCase([storeState("active")]);

    const [close] = buttons(root, "Fechar atendimento");
    expect(close && hasClass(close, "secondary")).toBe(true);
    expect(inkButtons(root).map((button) => button.textContent)).toEqual([
      "Suspender a loja",
      "Dar uma liberação temporária",
      "Dar acesso aos clientes",
    ]);
  });

  it("says the effect above the first button of each action of the case", async () => {
    const { root } = await openCase([storeState("active")]);

    effectBefore(root, "Suspender a loja", "suspend");
    effectBefore(root, "Dar uma liberação temporária", "grantGive");
    effectBefore(root, "Dar acesso aos clientes", "accessGrant");
    effectBefore(
      root,
      "Marcar como loja interna do Polaris",
      "internalMarkOrUnmark"
    );
    effectBefore(root, "Fechar atendimento", "closeCase");
  });

  it("says the effect of reactivating, and of ending an access that is in use", async () => {
    const { root } = await openCase([storeState("suspended")], [OWN_ACCESS]);

    effectBefore(root, "Reativar a loja", "reactivate");
    effectBefore(root, "Encerrar acesso agora", "accessInUse");
    effectBefore(root, "Ver clientes", "accessInUse");
  });

  it("says the effect of ending a grant above the button that ends it, and of revealing a field above the list", async () => {
    const grant = {
      expiresAt: "2026-11-02T15:00:00.000Z",
      flagValue: null,
      id: GRANT,
      key: "variants.active.max",
      limitValue: 2000,
      revokedAt: null,
      startsAt: "2026-10-28T12:00:00.000Z",
    };
    const { root } = await openCase(
      [
        storeState("active"),
        json({ ...diagnostics({ id: STORE }), grants: [grant] }),
        json({
          customers: [
            {
              archived: false,
              email: "m***@e***.br",
              hasNotes: true,
              id: CUSTOMER,
              name: "M***",
              phone: "***",
            },
          ],
          next: null,
        }),
      ],
      [OWN_ACCESS]
    );
    await click(root, "Ver liberações temporárias em vigor");
    await click(root, "Ver clientes");

    effectBefore(root, "Encerrar liberação temporária", "grantEnd");
    effectBefore(root, "Revelar ▾", "reveal");
  });

  it("puts the sentence of ending a grant on the list, right above the grant that ends it, and not before there is a grant", async () => {
    const grant = {
      expiresAt: "2026-11-02T15:00:00.000Z",
      flagValue: null,
      id: GRANT,
      key: "variants.active.max",
      limitValue: 2000,
      revokedAt: null,
      startsAt: "2026-10-28T12:00:00.000Z",
    };
    const unread = await openCase([
      storeState("active"),
      json({ ...diagnostics({ id: STORE }), grants: [grant] }),
    ]);
    expect(visibleText(unread.root)).not.toContain(EFFECT_LINES.grantEnd);

    const empty = await openCase([
      storeState("active"),
      json({ ...diagnostics({ id: STORE }), grants: [] }),
    ]);
    await click(empty.root, "Ver liberações temporárias em vigor");
    expect(visibleText(empty.root)).not.toContain(EFFECT_LINES.grantEnd);

    const read = await openCase([
      storeState("active"),
      json({ ...diagnostics({ id: STORE }), grants: [grant] }),
    ]);
    await click(read.root, "Ver liberações temporárias em vigor");
    const order = allElements(read.root);
    const effect = order.findIndex(
      (element) =>
        hasClass(element, "effect") &&
        element.textContent === EFFECT_LINES.grantEnd
    );
    const end = order.findIndex(
      (element) =>
        element.tagName === "button" &&
        element.textContent === "Encerrar liberação temporária"
    );
    expect(effect).toBeGreaterThan(-1);
    const between = order
      .slice(effect, end)
      .filter((element) => element.tagName === "button");
    expect(between).toEqual([]);
  });

  it("says nothing before the click that the review does not say after it, and sends nothing for the sentence", async () => {
    const { calls } = await openCase([storeState("active")]);

    expect(
      calls.filter(
        (call) => call.init.method === "POST" || call.init.method === "DELETE"
      )
    ).toEqual([]);
  });
});

const privacyDetail = (stage: string): PrivacyCaseDetail =>
  ({
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
      scopeCategories: [
        "organization_profile",
        "customers",
        "sales",
        "inventory_catalog",
        "media",
      ],
      stage,
      subjectReference: null,
    },
  }) as PrivacyCaseDetail;

const PRIVACY_WHO = {
  ...OWNER,
  capabilities: [
    ...OWNER.capabilities,
    "privacy_case:manage",
    "organization:purge",
    "organization:legal_hold",
  ],
};

const openPrivacy = (stage: string, answers: Answer[] = [], action?: "purge") =>
  mount(
    [json(privacyDetail(stage)), ...answers],
    json(PRIVACY_WHO),
    () => PRIVACY_NOW,
    screenContext({
      ...(action === undefined ? {} : { action }),
      id: CASE,
      screen: "privacidade-caso",
    })
  );

const closedStore = () =>
  json(diagnostics({ id: STORE, name: "Loja da Ana", status: "closed" }));

const hold = {
  id: GRANT,
  organizationId: STORE,
  placedAt: "2026-10-31T15:00:00.000Z",
  placedBy: OWNER.principal.id,
  reviewAt: "2026-12-15T15:00:00.000Z",
  reviewDue: false,
  supportCaseId: CASE,
};

const holds = (list: (typeof hold)[]) =>
  json({ dueForReview: 0, holds: list, next: null });

const STEP_TITLES: readonly (readonly [string, string])[] = [
  ["requested", "1. Identidade"],
  ["identity_checked", "2. Papel do Polaris"],
  ["role_determined", "3. Escopo"],
  ["scoped", "4. Decisão"],
  ["decided", "5. Ações"],
  ["executed", "6. Resolução"],
];

describe("the screen of a privacy case", () => {
  it.each(STEP_TITLES)(
    "gives the open step after %s the anatomy of an action panel",
    async (stage, title) => {
      const { root } = await openPrivacy(stage, [closedStore()]);

      const step = panelsOf(root).find((panel) =>
        hasClass(panel, "step-panel")
      );
      expect(headingOf(step as FakeElement)?.textContent).toBe(title);
      expectAnatomy(step as FakeElement);
    }
  );

  it("has at most one ink button on the tab of the steps, the closure notice included", async () => {
    const { root } = await openPrivacy("requested", [closedStore()]);

    const closure = panelsOf(root).find((panel) =>
      hasClass(panel, "closure-notice")
    );
    expect(closure).toBeDefined();
    expectAnatomy(closure as FakeElement);
    expect(inkButtons(root).map((button) => button.textContent)).toEqual([
      "Revisar identidade",
    ]);
  });

  it("puts the two tabs of the acts in the same list of tabs as Atendimentos", async () => {
    const { root } = await openPrivacy("decided", [closedStore()]);

    const tabs = allElements(root).filter(
      (element) => element.tagName === "ul" && hasClass(element, "tabs")
    );
    expect(tabs).toHaveLength(1);
    expect(
      byTag(tabs[0] as FakeElement, "a").map((link) => link.textContent)
    ).toEqual(["Etapas e aviso", "Apagamento e trava legal"]);
  });

  it.each([
    ["a closed store with no hold", [closedStore(), holds([])]],
    ["a closed store with a hold", [closedStore(), holds([hold])]],
    [
      "a store with the purge scheduled",
      [
        json(
          diagnostics({
            id: STORE,
            name: "Loja da Ana",
            status: "purge_pending",
          })
        ),
        holds([]),
      ],
    ],
  ] as const)(
    "gives each part of Apagamento e trava legal its effect above the button and its record below it, for %s",
    async (_name, answers) => {
      const { root } = await openPrivacy("decided", [...answers], "purge");

      const parts = allElements(root).filter((element) =>
        hasClass(element, "purge-part")
      );
      const acting = parts.filter((part) => byTag(part, "button").length > 0);
      expect(acting.length).toBeGreaterThan(0);
      for (const part of acting) {
        const order = allElements(part).filter(isShown);
        const button = order.findIndex(
          (element) => element.tagName === "button"
        );
        const effect = order.findIndex((element) =>
          hasClass(element, "effect")
        );
        const record = order.findIndex(
          (element, index) => index > button && hasClass(element, "record")
        );
        expect(button).toBeGreaterThan(-1);
        expect(effect).toBeGreaterThan(0);
        expect(effect).toBeLessThan(button);
        expect(record).toBeGreaterThan(button);
      }
      expect(inkButtons(root).length).toBeLessThanOrEqual(1);
      for (const effect of allElements(root).filter((element) =>
        hasClass(element, "effect")
      )) {
        expect(effect.textContent.length).toBeLessThanOrEqual(
          MAX_EFFECT_LENGTH
        );
        expect(effect.textContent).toMatch(UNDOES);
      }
    }
  );

  it("says the effect of scheduling and of cancelling the purge, and of placing and releasing the hold", async () => {
    const closed = await openPrivacy(
      "decided",
      [closedStore(), holds([])],
      "purge"
    );
    effectBefore(closed.root, "Agendar o apagamento", "purgeSchedule");
    effectBefore(closed.root, "Pôr trava legal", "holdPlace");

    const scheduled = await openPrivacy(
      "decided",
      [
        json(
          diagnostics({
            id: STORE,
            name: "Loja da Ana",
            status: "purge_pending",
          })
        ),
        holds([]),
      ],
      "purge"
    );
    effectBefore(scheduled.root, "Cancelar o agendamento", "purgeCancel");

    const held = await openPrivacy(
      "decided",
      [closedStore(), holds([hold])],
      "purge"
    );
    effectBefore(held.root, "Liberar trava legal", "holdPlaced");
    expect(visibleText(held.root)).toContain(EFFECT_LINES.holdPlaced);
  });
});

describe("the effect of the closure notice", () => {
  it("is said above Reemitir o aviso and Dispensar o aviso", async () => {
    const { root } = await openPrivacy("requested", [closedStore()]);

    effectBefore(root, "Reemitir o aviso", "reissueNotice");
    effectBefore(root, "Dispensar o aviso", "dismissNotice");
  });
});
