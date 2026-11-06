import { PROBLEM_TEXT } from "../api";
import type { ScreenTools } from "../app";
import { facts } from "../blocks";
import { type Dom, labelName, storeName } from "../dom";
import {
  billingStateText,
  brasiliaMomentText,
  methodText,
  moneyText,
} from "../format";
import { createNotice } from "../notice";
import {
  AMOUNT_CHANGED_AWAY,
  AUDIT_TEXT,
  amountMismatchText,
  CURRENT_CHARGE_AMOUNT_LABEL,
  CURRENT_CHARGE_NOT_RECORDED,
  FIRST_CHARGE_AMOUNT_LABEL,
  RENEWAL_LABEL,
  SEPARATE_ACTIONS,
} from "../refund-words";
import type { RefundWindowView } from "../types";
import {
  type After,
  type BillingActions,
  billingActionsView,
  renewalLine,
} from "./billing-actions";
import { openCaseLink } from "./case-links";
import { type CaseChoice, supportCasesView } from "./support-case";

export interface RefundWindowArea {
  element: HTMLElement;
  /** Another store was chosen: the cases and the window of the one before are gone. */
  show: (organization: { id: string; name: string }) => void;
}

/** What an answer says once another store is shown: the new read is not made, so a text that needs it is not used. */
function awayText(after: After): string {
  const { holdRefund, text } = after;
  if (typeof text === "string") {
    return text;
  }
  return holdRefund ? amountMismatchText(null) : AMOUNT_CHANGED_AWAY;
}

/** Whether the refund's confirmation opens again after the read that followed `after`, and whether it is held. */
function afterRead(
  after: After | null,
  fresh: RefundWindowView
): { hold: boolean; reopen: boolean } {
  const reopenRefund = after?.reopenRefund;
  // the same amount read again would only spend another of the 3 refunds an hour on the same refusal: the refund is
  // held, as after a divergence the server found
  const reopen =
    reopenRefund !== undefined &&
    fresh.currentChargeAmount !== reopenRefund.from;
  return {
    hold: after?.holdRefund === true || (reopenRefund !== undefined && !reopen),
    reopen,
  };
}

/** The read after an action failed: what the action did is still said, since it was done whatever the read says. */
function readFailureText(problem: string, after: After | null): string {
  return after !== null && typeof after.text === "string"
    ? `${after.text} Não foi possível ler a cobrança de novo: ${problem}`
    : problem;
}

function windowText(window: RefundWindowView["window"]): string {
  if (window === null) {
    return "Sem primeira cobrança: não há janela de arrependimento.";
  }
  return window.open ? "Dentro do prazo" : "Fora do prazo";
}

function requestText(request: RefundWindowView["request"]): string {
  if (request === null) {
    return "Nenhum";
  }
  const until = `pode ser concluído pelo app até ${brasiliaMomentText(request.completableUntil)}`;
  return request.completable
    ? `Feito em ${brasiliaMomentText(request.at)}; ${until}`
    : `Feito em ${brasiliaMomentText(request.at)}; ${until} (prazo passou)`;
}

/** The window as the server computed it, field by field: no date, deadline or verdict is worked out here (AC-9). */
function windowFacts(dom: Dom, view: RefundWindowView, choice: CaseChoice) {
  return facts(dom, [
    ["Assinatura", billingStateText(view.state)],
    [RENEWAL_LABEL, renewalLine(view.renewal)],
    ["Forma de pagamento", methodText(view.method)],
    [
      CURRENT_CHARGE_AMOUNT_LABEL,
      view.currentChargeAmount === null
        ? CURRENT_CHARGE_NOT_RECORDED
        : moneyText(view.currentChargeAmount),
    ],
    [FIRST_CHARGE_AMOUNT_LABEL, moneyText(view.firstChargeAmount)],
    ["Primeira cobrança", brasiliaMomentText(view.firstChargeAt)],
    ["Janela de arrependimento", windowText(view.window)],
    ["Prazo até", brasiliaMomentText(view.window?.until ?? null)],
    [
      "A regra do Polaris ainda permite o reembolso",
      view.refundable ? "Sim" : "Não",
    ],
    ["Pedido de reembolso do dono", requestText(view.request)],
    [
      "Consulta feita em",
      `${brasiliaMomentText(view.now)} (relógio do servidor)`,
    ],
    [
      "Atendimento usado",
      `Aberto em ${brasiliaMomentText(choice.openedAt)}: ${labelName(choice.reason, 120)}`,
    ],
  ]);
}

/**
 * Cobrança da loja (AC-9, AC-10, AC-P10.4): for the chosen store, an open case of it first, then the
 * billing's read. The read is a POST from this origin that the server audits, so it happens only on an explicit click
 * next to the sentence that says so, once per click (the buttons are off while it answers), and never again by itself
 * but after an action the operator confirmed, which reads again so the page shows what the server holds. The two
 * actions come only after the read (`billing-actions.ts`). A refusal does not say whether the case was closed or of
 * another store.
 */
export function refundWindowView(tools: ScreenTools): RefundWindowArea {
  const { api, can, dom } = tools;
  const capabilities = {
    manageCases: can("support_case:manage"),
    readWindow: can("billing:operate"),
  };
  const notice = createNotice(dom);
  const title = dom.el(
    "h2",
    { id: "reembolso-titulo", tabindex: "-1" },
    "Cancelar renovação e reembolsar"
  );
  const result = dom.el("div", { class: "report" });
  let organization = { id: "", name: "" };
  let reading = false;
  let turn = 0;
  let locked = false;
  /** Stores whose refund is held until the page is loaded again (`After.holdRefund`). */
  const held = new Set<string>();

  const cases = supportCasesView(dom, api, {
    canRead: capabilities.readWindow,
    onRead: (choice) => {
      read(choice);
    },
    readHint: capabilities.readWindow
      ? dom.el(
          "p",
          { class: "audit", hidden: "", id: "reembolso-auditoria" },
          AUDIT_TEXT
        )
      : null,
  });

  const say = (after: After, view: RefundWindowView) => {
    const text = typeof after.text === "string" ? after.text : after.text(view);
    if (after.kind === "success") {
      notice.success(text);
    } else {
      notice.alert(text);
    }
  };

  const show = (
    choice: CaseChoice,
    view: RefundWindowView
  ): BillingActions | null => {
    const builtFor = turn;
    const away = organization;
    const sayAway = (next: After) => {
      if (next.holdRefund) {
        held.add(away.id);
      }
      notice.alert(`Loja ${labelName(away.name)}: ${awayText(next)}`);
    };
    try {
      const shown = windowFacts(dom, view, choice);
      const actions = billingActionsView(tools, {
        busy: (on) => {
          locked = on;
          cases.busy(on);
        },
        choice,
        notice,
        organization,
        refundHeld: held.has(organization.id),
        settled: (next) => {
          if (builtFor === turn) {
            read(choice, next);
          } else {
            sayAway(next);
          }
        },
        view,
      });
      dom.fill(
        result,
        dom.el("h3", {}, "Cobrança lida"),
        shown,
        dom.el("p", { class: "hint" }, SEPARATE_ACTIONS),
        actions.element
      );
      return actions;
    } catch {
      return null;
    }
  };

  const read = async (choice: CaseChoice, after: After | null = null) => {
    if (reading) {
      return;
    }
    const mine = turn;
    reading = true;
    cases.busy(true);
    result.replaceChildren();
    notice.status(
      after === null ? "Consultando a cobrança…" : "Lendo a cobrança de novo…"
    );
    const answer = await api.post<RefundWindowView>(
      `/api/support-cases/${encodeURIComponent(choice.id)}/refund-window`,
      { organizationId: organization.id }
    );
    if (mine !== turn) {
      return;
    }
    reading = false;
    cases.busy(locked);
    if (!answer.ok) {
      // the page sends the store it shows: a 400 is the Admin's error, not something the operator typed
      notice.alert(
        readFailureText(
          PROBLEM_TEXT[
            answer.problem === "invalid" ? "failed" : answer.problem
          ],
          after
        )
      );
      return;
    }
    const next = afterRead(after, answer.data);
    if (next.hold) {
      held.add(organization.id);
    }
    const actions = show(choice, answer.data);
    if (actions === null) {
      // an answer of another shape is not shown as a window (the read was made and audited all the same)
      notice.alert(PROBLEM_TEXT.failed);
      return;
    }
    if (after === null) {
      notice.status("Cobrança lida. A consulta ficou registrada na auditoria.");
      return;
    }
    if (next.reopen && after.reopenRefund) {
      actions.openRefund(after.reopenRefund.reason);
    }
    say(after, answer.data);
  };

  const openCase = dom.el("p", { class: "hint" });
  if (tools.context.id !== null) {
    dom.fill(openCase, openCaseLink(dom, tools.context.id));
  }
  let body: (Node | string)[];
  if (capabilities.manageCases) {
    body = [
      dom.el(
        "p",
        { class: "hint" },
        "Ler a cobrança exige um atendimento de suporte aberto desta loja."
      ),
      ...(capabilities.readWindow
        ? []
        : [dom.el("p", {}, "Sem permissão para ler a cobrança.")]),
      cases.element,
      openCase,
      notice.element,
      result,
    ];
  } else {
    body = [dom.el("p", {}, PROBLEM_TEXT.forbidden)];
  }

  const element = dom.el(
    "section",
    { "aria-labelledby": "reembolso-titulo", class: "area", hidden: "" },
    title,
    ...body
  );

  return {
    element,
    show: (next) => {
      turn += 1;
      organization = next;
      reading = false;
      locked = false;
      element.removeAttribute("hidden");
      dom.fill(
        title,
        "Cancelar renovação e reembolsar: ",
        storeName(dom, next.name, next.id)
      );
      notice.clear();
      result.replaceChildren();
      dom.fill(openCase, openCaseLink(dom, next.id));
      cases.show(next.id);
    },
  };
}
