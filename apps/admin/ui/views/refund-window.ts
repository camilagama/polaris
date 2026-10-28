import type { Api } from "../api";
import { PROBLEM_TEXT } from "../api";
import { facts } from "../blocks";
import { type Dom, labelName, storeName } from "../dom";
import {
  billingStateText,
  brasiliaMomentText,
  methodText,
  moneyText,
} from "../format";
import { createNotice } from "../notice";
import type { RefundWindowView } from "../types";
import { type CaseChoice, supportCasesView } from "./support-case";

export const READ_ONLY_TEXT =
  "Esta tela só mostra a janela. Ela não devolve dinheiro.";
export const AUDIT_TEXT = "Esta consulta fica registrada na auditoria.";

export interface RefundWindowArea {
  element: HTMLElement;
  /** Another store was chosen: the cases and the window of the one before are gone. */
  show: (organization: { id: string; name: string }) => void;
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
    ["Janela de arrependimento", windowText(view.window)],
    ["Prazo até", brasiliaMomentText(view.window?.until ?? null)],
    [
      "A regra do Polaris ainda permite o reembolso",
      view.refundable ? "Sim" : "Não",
    ],
    ["Primeira cobrança", brasiliaMomentText(view.firstChargeAt)],
    ["Valor da primeira cobrança", moneyText(view.firstChargeAmount)],
    ["Forma de pagamento", methodText(view.method)],
    ["Assinatura", billingStateText(view.state)],
    ["Pedido de reembolso do dono", requestText(view.request)],
    [
      "Consulta feita em",
      `${brasiliaMomentText(view.now)} (relógio do servidor)`,
    ],
    [
      "Caso usado",
      `Aberto em ${brasiliaMomentText(choice.openedAt)}: ${labelName(choice.reason, 120)}`,
    ],
  ]);
}

/**
 * Reembolso (AC-9, AC-10): for the chosen store, an open case of it first, then the window's read. The read is a
 * POST from this origin that the server audits, so it happens only on an explicit click next to the sentence that
 * says so, once per click (the buttons are off while it answers), and never again by itself. The page refunds
 * nothing; it shows the window the server computed on the database clock. A refusal does not say whether the case
 * was closed or of another store.
 */
export function refundWindowView(
  dom: Dom,
  api: Api,
  capabilities: { manageCases: boolean; readWindow: boolean }
): RefundWindowArea {
  const notice = createNotice(dom);
  const title = dom.el(
    "h2",
    { id: "reembolso-titulo", tabindex: "-1" },
    "Reembolso"
  );
  const result = dom.el("div", { class: "report" });
  let organizationId = "";
  let reading = false;
  let turn = 0;

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

  const read = async (choice: CaseChoice) => {
    if (reading) {
      return;
    }
    const mine = turn;
    reading = true;
    cases.busy(true);
    result.replaceChildren();
    notice.status("Consultando a janela…");
    const answer = await api.post<RefundWindowView>(
      `/api/support-cases/${encodeURIComponent(choice.id)}/refund-window`,
      { organizationId }
    );
    if (mine !== turn) {
      return;
    }
    reading = false;
    cases.busy(false);
    if (!answer.ok) {
      // the page sends the store it shows: a 400 is the Admin's error, not something the operator typed
      notice.alert(
        PROBLEM_TEXT[answer.problem === "invalid" ? "failed" : answer.problem]
      );
      return;
    }
    let shownWindow: HTMLElement;
    try {
      shownWindow = windowFacts(dom, answer.data, choice);
    } catch {
      // an answer of another shape is not shown as a window (the read was made and audited all the same)
      notice.alert(PROBLEM_TEXT.failed);
      return;
    }
    dom.fill(result, dom.el("h3", {}, "Janela de reembolso"), shownWindow);
    notice.status("Janela lida. A consulta ficou registrada na auditoria.");
  };

  let body: (Node | string)[];
  if (capabilities.manageCases) {
    body = [
      dom.el("p", { class: "warning" }, READ_ONLY_TEXT),
      dom.el(
        "p",
        { class: "hint" },
        "A consulta da janela exige um caso de suporte aberto desta loja."
      ),
      ...(capabilities.readWindow
        ? []
        : [dom.el("p", {}, "Sem permissão para consultar a janela.")]),
      cases.element,
      notice.element,
      result,
      cases.form,
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
    show: (organization) => {
      turn += 1;
      organizationId = organization.id;
      reading = false;
      element.removeAttribute("hidden");
      dom.fill(
        title,
        "Reembolso: ",
        storeName(dom, organization.name, organization.id)
      );
      notice.clear();
      result.replaceChildren();
      cases.show(organization.id);
    },
  };
}
