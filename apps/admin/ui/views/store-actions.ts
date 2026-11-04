import { type ApiFailure, PROBLEM_TEXT } from "../api";
import { environmentText, type ScreenTools } from "../app";
import { facts } from "../blocks";
import { labelName, storeName } from "../dom";
import {
  brasiliaMomentText,
  brasiliaTime,
  minutesText,
  storeStatusText,
} from "../format";
import { createNotice } from "../notice";
import type { OrganizationDiagnostics } from "../types";

export const SUSPEND_EFFECTS: readonly string[] = [
  "A loja deixa de abrir para os próprios usuários assim que você confirmar.",
  "Os aparelhos offline perdem a autorização (as concessões offline são revogadas) e o que estava guardado neles pode ser recusado ao sincronizar.",
  "A cobrança não muda.",
  "O cliente não é avisado.",
];
export const SUSPEND_UNDO =
  "Sim: Reativar, com um caso aberto desta loja. Reativar não devolve as concessões offline revogadas.";
const SUSPEND_AUDIT =
  "A suspensão fica na auditoria com o seu e-mail e o caso.";
export const REACTIVATE_EFFECT =
  "Reativar desfaz só a suspensão. Loja encerrada continua encerrada.";
export const REACTIVATE_UNDO =
  "Sim: suspender de novo, com um caso aberto desta loja.";
const REACTIVATE_AUDIT =
  "A reativação fica na auditoria com o seu e-mail e o caso.";
export const INTERNAL_EFFECT =
  "A loja sai do funil de ativação. Desmarcar a devolve ao funil.";
const INTERNAL_AUDIT = "A marcação fica na auditoria com o seu e-mail.";
export const INTERNAL_UNREAD =
  "Marca de loja interna: ainda não lida. A tela só a conhece depois que você marca ou desmarca.";
export const CLOSED_STORE = `Esta loja está encerrada. ${REACTIVATE_EFFECT}`;

type Operation = "reactivate" | "suspend";

interface OperationText {
  audit: string;
  confirm: string;
  done: string;
  effect: (tools: ScreenTools) => Node;
  open: string;
  review: string;
  route: (caseId: string) => string;
  undo: string;
  unknown: string;
}

const OPERATIONS: Readonly<Record<Operation, OperationText>> = {
  reactivate: {
    audit: REACTIVATE_AUDIT,
    confirm: "Confirmar reativação da loja",
    done: "Loja reativada",
    effect: ({ dom }) => dom.el("span", {}, REACTIVATE_EFFECT),
    open: "Reativar a loja",
    review: "Revise antes de reativar",
    route: (caseId) => `/api/support-cases/${caseId}/reactivate`,
    undo: REACTIVATE_UNDO,
    unknown:
      "Não deu para confirmar se a loja foi reativada. Releia a situação antes de tentar de novo.",
  },
  suspend: {
    audit: SUSPEND_AUDIT,
    confirm: "Confirmar suspensão da loja",
    done: "Loja suspensa",
    effect: ({ dom }) =>
      dom.el(
        "ul",
        { class: "effects" },
        ...SUSPEND_EFFECTS.map((line) => dom.el("li", {}, line))
      ),
    open: "Suspender a loja",
    review: "Revise antes de suspender",
    route: (caseId) => `/api/support-cases/${caseId}/suspend`,
    undo: SUSPEND_UNDO,
    unknown:
      "Não deu para confirmar se a loja foi suspensa. Releia a situação antes de tentar de novo.",
  },
};

export interface StoreActionsCase {
  id: string;
  openedAt: string;
  organizationId: string;
  organizationName: string;
  reason: string;
}

interface Answer {
  changed: boolean;
  revokedLeases?: number;
  status: string;
}

function isAnswer(data: unknown): data is Answer {
  return (
    typeof data === "object" &&
    data !== null &&
    "changed" in data &&
    typeof data.changed === "boolean" &&
    "status" in data &&
    typeof data.status === "string"
  );
}

function isClassification(
  data: unknown
): data is { changed: boolean; internal: boolean } {
  return (
    typeof data === "object" &&
    data !== null &&
    "changed" in data &&
    typeof data.changed === "boolean" &&
    "internal" in data &&
    typeof data.internal === "boolean"
  );
}

function limitText(failure: ApiFailure): string {
  return failure.retryAfterSeconds === undefined
    ? PROBLEM_TEXT.rate_limited
    : `Limite de consultas por hora atingido. Tente de novo em ${minutesText(failure.retryAfterSeconds)}.`;
}

/**
 * What a refused command says, in words. 400 here is the case that is no longer open (the page sends no input), 409
 * a state that moved; neither leaves a change behind. The three answers that may hide a write that happened
 * (network, 5xx, an answer the page cannot read) are not here: they have their own sentence and no retry.
 */
function refusalText(failure: ApiFailure): string {
  switch (failure.problem) {
    case "forbidden":
      return PROBLEM_TEXT.forbidden;
    case "not_found":
      return "Este caso não foi encontrado.";
    case "invalid":
      return "O caso não está aberto ou não é desta loja. Nada foi mudado. Recarregue o caso.";
    case "rate_limited":
      return limitText(failure);
    case "session":
      return PROBLEM_TEXT.session;
    default:
      return PROBLEM_TEXT.conflict;
  }
}

function writeMayHaveHappened(failure: ApiFailure): boolean {
  return (
    failure.problem === "network" ||
    failure.problem === "failed" ||
    failure.problem === "unavailable" ||
    failure.problem === "plan_catalog_incomplete"
  );
}

/**
 * Loja (corte admin-v2, Parte 3; AC-P3.1 to AC-P3.4): on the screen of an open support case of the store, suspend it,
 * reactivate it and mark it as a store of Polaris itself. Suspending and reactivating are reviewed in two steps and
 * send one request per click; the store's state is read when the panel opens and again, once, after each answer, so
 * what is shown is what the server says now. The mark has no read route: it is shown only once the server has said it.
 */
export function storeActionsView(
  tools: ScreenTools,
  item: StoreActionsCase
): HTMLElement {
  const { api, can, context, dom, now } = tools;
  const stateNotice = createNotice(dom);
  const notice = createNotice(dom);
  const suspensionBox = dom.el("div", { class: "suspension" });
  const internalBox = dom.el("div", { class: "internal" });
  let status: string | null = null;
  let internal: boolean | null = null;
  let reading = 0;
  let sending = false;

  const mayRead = can("organization:diagnose");
  const maySuspend = can("organization:suspend");
  const mayClassify = can("organization:classify");

  const reviewFacts = (text: OperationText) =>
    facts(dom, [
      ["Ambiente", environmentText(context)],
      ["Loja", storeName(dom, item.organizationName, item.organizationId)],
      [
        "Caso",
        `Aberto em ${brasiliaMomentText(item.openedAt)}: ${labelName(item.reason, 120)}`,
      ],
      ["O que acontece", text.effect(tools)],
      ["Dá para desfazer", text.undo],
      ["Fica na auditoria", text.audit],
    ]);

  const readState = async (): Promise<boolean> => {
    reading += 1;
    const mine = reading;
    status = null;
    renderSuspension();
    stateNotice.status("Lendo a situação da loja…");
    const answer = await api.get<OrganizationDiagnostics>(
      `/api/organizations/${encodeURIComponent(item.organizationId)}/diagnostics`
    );
    if (mine !== reading) {
      return true;
    }
    const read = answer.ok ? answer.data?.organization : undefined;
    if (
      !answer.ok ||
      read?.id !== item.organizationId ||
      typeof read.status !== "string"
    ) {
      stateNotice.alert(
        answer.ok
          ? PROBLEM_TEXT.failed
          : PROBLEM_TEXT[
              answer.problem === "invalid" ? "failed" : answer.problem
            ]
      );
      renderSuspension();
      return false;
    }
    ({ status } = read);
    stateNotice.status(
      `Situação da loja: ${storeStatusText(status)}. Lida às ${brasiliaTime(now())}.`
    );
    renderSuspension();
    return true;
  };

  const rereadButton = () => {
    const button = dom.el(
      "button",
      { class: "secondary", type: "button" },
      "Reler a situação"
    );
    button.addEventListener("click", () => {
      if (!sending) {
        readState();
      }
    });
    return button;
  };

  const sendOperation = async (
    operation: Operation,
    buttons: { back: HTMLElement; confirm: HTMLElement }
  ) => {
    const text = OPERATIONS[operation];
    sending = true;
    buttons.confirm.setAttribute("aria-disabled", "true");
    buttons.back.setAttribute("aria-disabled", "true");
    notice.status(
      operation === "suspend" ? "Suspendendo a loja…" : "Reativando a loja…"
    );
    const answer = await api.post<Answer>(
      text.route(encodeURIComponent(item.id)),
      {}
    );
    if (answer.ok && isAnswer(answer.data)) {
      await afterAnswer(text, answer.data);
      sending = false;
      return;
    }
    if (answer.ok || writeMayHaveHappened(answer)) {
      notice.alert(text.unknown);
      sending = false;
      status = null;
      dom.fill(suspensionBox, rereadButton());
      return;
    }
    sending = false;
    buttons.confirm.setAttribute("aria-disabled", "false");
    buttons.back.setAttribute("aria-disabled", "false");
    if (answer.problem === "conflict") {
      await readState();
      notice.alert(
        status === null
          ? refusalText(answer)
          : `Esta ação já não se aplica: a loja agora está ${storeStatusText(status).toLowerCase()}.`
      );
      return;
    }
    notice.alert(refusalText(answer));
  };

  const afterAnswer = async (text: OperationText, data: Answer) => {
    let said = `${text.done} às ${brasiliaTime(now())}.`;
    if (!data.changed) {
      said = `Nada mudou: a situação da loja é ${storeStatusText(data.status)}.`;
    } else if (typeof data.revokedLeases === "number") {
      said += ` ${data.revokedLeases === 1 ? "1 autorização offline revogada" : `${data.revokedLeases} autorizações offline revogadas`}.`;
    }
    notice.success(said);
    await readState();
  };

  const review = (operation: Operation) => {
    const text = OPERATIONS[operation];
    const heading = dom.el(
      "h4",
      { id: "loja-revisao", tabindex: "-1" },
      text.review
    );
    const confirm = dom.el("button", { type: "button" }, text.confirm);
    const back = dom.el(
      "button",
      { class: "secondary", type: "button" },
      "Voltar"
    );
    back.addEventListener("click", () => {
      if (!sending) {
        renderSuspension();
        suspensionBox.querySelector("button")?.focus();
      }
    });
    confirm.addEventListener("click", () => {
      if (!sending) {
        sendOperation(operation, { back, confirm });
      }
    });
    dom.fill(
      suspensionBox,
      heading,
      reviewFacts(text),
      dom.el("div", { class: "button-row" }, confirm, back)
    );
    heading.focus();
  };

  const startButton = (operation: Operation) => {
    const text = OPERATIONS[operation];
    const open = dom.el("button", { type: "button" }, text.open);
    open.addEventListener("click", () => {
      if (!sending) {
        notice.clear();
        review(operation);
      }
    });
    return open;
  };

  function renderSuspension() {
    if (!maySuspend) {
      dom.fill(suspensionBox);
      return;
    }
    if (!mayRead) {
      dom.fill(
        suspensionBox,
        dom.el(
          "p",
          { class: "hint" },
          "Para suspender ou reativar é preciso poder ver a situação da loja."
        )
      );
      return;
    }
    if (status === "active") {
      dom.fill(
        suspensionBox,
        dom.el(
          "p",
          {},
          "Suspender tira o acesso dos usuários da loja. Você revisa os efeitos antes de confirmar."
        ),
        startButton("suspend")
      );
    } else if (status === "suspended") {
      dom.fill(
        suspensionBox,
        dom.el("p", {}, REACTIVATE_EFFECT),
        startButton("reactivate")
      );
    } else if (status === "closed") {
      dom.fill(suspensionBox, dom.el("p", {}, CLOSED_STORE));
    } else {
      dom.fill(suspensionBox, rereadButton());
    }
  }

  const classify = async (target: boolean, button: HTMLElement) => {
    sending = true;
    button.setAttribute("aria-disabled", "true");
    notice.status("Gravando a marca da loja…");
    const answer = await api.post<{ changed: boolean; internal: boolean }>(
      `/api/organizations/${encodeURIComponent(item.organizationId)}/classification`,
      { internal: target }
    );
    sending = false;
    if (answer.ok && isClassification(answer.data)) {
      ({ internal } = answer.data);
      renderInternal();
      const marked = internal
        ? "A loja está marcada como interna e saiu do funil de ativação."
        : "A loja não está marcada como interna e voltou ao funil de ativação.";
      notice.success(
        answer.data.changed ? marked : `Nada mudou: já era assim. ${marked}`
      );
      return;
    }
    button.setAttribute("aria-disabled", "false");
    if (answer.ok || writeMayHaveHappened(answer)) {
      notice.alert(
        "Não deu para confirmar se a marca foi gravada. Repetir é seguro: tente de novo."
      );
    } else if (answer.problem === "invalid") {
      notice.alert("O pedido não foi aceito. Recarregue a página.");
    } else if (answer.problem === "not_found") {
      notice.alert("Esta loja não foi encontrada.");
    } else {
      notice.alert(refusalText(answer));
    }
  };

  const classifyButton = (target: boolean) => {
    const button = dom.el(
      "button",
      { class: "secondary", type: "button" },
      target ? "Marcar como loja interna do Polaris" : "Desmarcar loja interna"
    );
    button.addEventListener("click", () => {
      if (!sending) {
        classify(target, button);
      }
    });
    return button;
  };

  function renderInternal() {
    if (!mayClassify) {
      dom.fill(internalBox);
      return;
    }
    let stateText = INTERNAL_UNREAD;
    if (internal !== null) {
      stateText = internal
        ? "Esta loja está marcada como interna."
        : "Esta loja não está marcada como interna.";
    }
    dom.fill(
      internalBox,
      dom.el("h4", {}, "Loja interna"),
      dom.el("p", {}, stateText),
      dom.el("p", {}, INTERNAL_EFFECT),
      dom.el("p", { class: "hint" }, INTERNAL_AUDIT),
      dom.el(
        "div",
        { class: "button-row" },
        internal === true ? null : classifyButton(true),
        internal === false ? null : classifyButton(false)
      )
    );
  }

  renderSuspension();
  renderInternal();
  if (maySuspend && mayRead) {
    readState();
  }
  return dom.el(
    "section",
    { "aria-labelledby": "loja-acoes-titulo", class: "action-panel" },
    dom.el("h3", { id: "loja-acoes-titulo" }, "Loja"),
    maySuspend && mayRead ? stateNotice.element : null,
    suspensionBox,
    internalBox,
    notice.element
  );
}
