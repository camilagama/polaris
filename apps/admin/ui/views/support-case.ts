import type { Api } from "../api";
import { PROBLEM_TEXT } from "../api";
import { tableRow } from "../blocks";
import { type Dom, hasControlCharacter, labelName } from "../dom";
import { brasiliaMomentText, caseKindText } from "../format";
import { createNotice } from "../notice";
import type {
  OpenedSupportCase,
  SupportCasePage,
  SupportCaseSummary,
} from "../types";

/** The server's limit for a case's reason (`MAX_CASE_REASON_LENGTH`), in characters as a person counts them. */
export const MAX_REASON_LENGTH = 500;
/** The most open cases of one store the list asks for; the server's page holds at most 50. */
const CASES_PAGE = "50";
const REASON_SHOWN = 120;

const HEADERS = ["Aberto em", "Tipo", "Motivo", "Ação"] as const;

export interface CaseChoice {
  id: string;
  openedAt: string;
  reason: string;
}

export interface SupportCasesView {
  /** Turns the cases' buttons off while a read of the window is on its way, so a double click asks once (AC-10). */
  busy: (on: boolean) => void;
  /** The cases of the store: the button that lists them, their sentence and the list. */
  element: HTMLElement;
  /** The form that opens a case, placed by the area after the window's answer. */
  form: HTMLElement;
  /** Starts over for another store: nothing of the one before stays, and nothing is read until asked. */
  show: (organizationId: string) => void;
}

function countText(count: number, more: boolean): string {
  if (count === 0) {
    return "Nenhum caso aberto desta loja. Abra um caso para consultar a janela.";
  }
  const found = count === 1 ? "1 caso aberto." : `${count} casos abertos.`;
  return more ? `${found} Mostrando os ${CASES_PAGE} mais recentes.` : found;
}

/** Why a reason typed here would be refused by the server, or null when it would be taken (AC-11). */
export function reasonProblem(reason: string): string | null {
  const trimmed = reason.trim();
  if (trimmed === "") {
    return "Escreva o motivo do caso.";
  }
  if ([...trimmed].length > MAX_REASON_LENGTH) {
    return `O motivo aceita até ${MAX_REASON_LENGTH} caracteres.`;
  }
  if (hasControlCharacter(trimmed)) {
    return "O motivo não aceita caracteres de controle nem quebra de linha.";
  }
  return null;
}

/**
 * The open support cases of the chosen store (AC-9): listed when the operator asks, or opened here with a reason of
 * 1 to 500 characters (no control character), sent as JSON in the body, never in the URL. Each case listed offers
 * the read of the refund window through `onRead`, when the operator may read it; without an open case of this store
 * there is nothing to click, so the window's route is never called.
 */
export function supportCasesView(
  dom: Dom,
  api: Api,
  options: {
    canRead: boolean;
    onRead: (choice: CaseChoice) => void;
    readHint: string;
  }
): SupportCasesView {
  const notice = createNotice(dom);
  const listButton = dom.el(
    "button",
    { class: "secondary", type: "button" },
    "Ver casos abertos desta loja"
  );
  const rows = dom.el("tbody");
  const list = dom.el(
    "table",
    { class: "grid", hidden: "" },
    dom.el("caption", { class: "sr-only" }, "Casos abertos desta loja"),
    dom.el(
      "thead",
      {},
      dom.el(
        "tr",
        {},
        ...HEADERS.map((header) => dom.el("th", { scope: "col" }, header))
      )
    ),
    rows
  );
  const reason = dom.el("input", {
    "aria-describedby": "motivo-contador motivo-dica",
    autocomplete: "off",
    id: "motivo",
    maxlength: String(MAX_REASON_LENGTH),
    name: "motivo",
    required: "",
    type: "text",
  });
  const counter = dom.el(
    "p",
    { class: "hint", id: "motivo-contador" },
    `0 de ${MAX_REASON_LENGTH} caracteres`
  );
  const openButton = dom.el("button", { type: "submit" }, "Abrir caso");
  const form = dom.el(
    "form",
    { class: "search", novalidate: "" },
    dom.el("label", { for: "motivo" }, "Motivo do novo caso"),
    dom.el("div", { class: "search-row" }, reason, openButton),
    counter,
    dom.el(
      "p",
      { class: "hint", id: "motivo-dica" },
      "Curto e sem dado pessoal do cliente: o motivo fica no registro do caso."
    )
  );

  let organizationId = "";
  let loading = false;
  let reading = false;
  let shown = 0;
  let turn = 0;
  const readButtons: HTMLButtonElement[] = [];

  const refreshButtons = () => {
    for (const button of [listButton, openButton]) {
      button.setAttribute("aria-disabled", String(loading));
    }
    for (const button of readButtons) {
      button.setAttribute("aria-disabled", String(loading || reading));
    }
  };

  const row = (supportCase: CaseChoice & { kind: string }) => {
    let action: Node | string = "—";
    if (options.canRead) {
      const read = dom.el(
        "button",
        {
          "aria-describedby": options.readHint,
          "aria-label": `Consultar janela: caso aberto em ${brasiliaMomentText(supportCase.openedAt)}`,
          type: "button",
        },
        "Consultar janela"
      );
      read.addEventListener("click", () => {
        if (!(loading || reading)) {
          options.onRead({
            id: supportCase.id,
            openedAt: supportCase.openedAt,
            reason: supportCase.reason,
          });
        }
      });
      readButtons.push(read);
      action = read;
    }
    return tableRow(dom, HEADERS, [
      brasiliaMomentText(supportCase.openedAt),
      caseKindText(supportCase.kind),
      dom.el(
        "span",
        { class: "reason", title: labelName(supportCase.reason, 500) },
        labelName(supportCase.reason, REASON_SHOWN)
      ),
      action,
    ]);
  };

  const showRows = () => {
    if (shown === 0) {
      list.setAttribute("hidden", "");
    } else {
      list.removeAttribute("hidden");
    }
  };

  const load = async () => {
    turn += 1;
    const mine = turn;
    loading = true;
    refreshButtons();
    notice.status("Buscando casos abertos…");
    const parameters = new URLSearchParams({
      limit: CASES_PAGE,
      organizationId,
      status: "open",
    });
    const answer = await api.get<SupportCasePage>(
      `/api/support-cases?${parameters.toString()}`
    );
    if (mine !== turn) {
      return;
    }
    loading = false;
    if (!answer.ok) {
      refreshButtons();
      notice.alert(PROBLEM_TEXT[answer.problem]);
      return;
    }
    // the server filters by store and state; a case of another store or not open is never offered, whatever came
    const cases = answer.data.cases.filter(
      (item: SupportCaseSummary) =>
        item.organizationId === organizationId && item.status === "open"
    );
    rows.replaceChildren();
    readButtons.length = 0;
    rows.append(...cases.map(row));
    shown = cases.length;
    showRows();
    refreshButtons();
    notice.status(countText(shown, answer.data.next !== null));
  };

  const open = async () => {
    const problem = reasonProblem(reason.value);
    if (problem !== null) {
      notice.alert(problem);
      return;
    }
    turn += 1;
    const mine = turn;
    loading = true;
    refreshButtons();
    notice.status("Abrindo o caso…");
    const answer = await api.post<OpenedSupportCase>("/api/support-cases", {
      kind: "support",
      organizationId,
      reason: reason.value,
    });
    if (mine !== turn) {
      return;
    }
    loading = false;
    if (!answer.ok) {
      refreshButtons();
      notice.alert(
        answer.problem === "invalid"
          ? `O motivo não foi aceito: use de 1 a ${MAX_REASON_LENGTH} caracteres, sem caracteres de controle.`
          : PROBLEM_TEXT[answer.problem]
      );
      return;
    }
    // the route answers the case it opened; anything else is not shown as one
    if (typeof answer.data?.id !== "string") {
      refreshButtons();
      notice.alert(PROBLEM_TEXT.failed);
      return;
    }
    const added = row(answer.data);
    rows.prepend(added);
    shown += 1;
    showRows();
    refreshButtons();
    reason.value = "";
    counter.textContent = `0 de ${MAX_REASON_LENGTH} caracteres`;
    notice.status(
      options.canRead
        ? "Caso aberto. Ele está na lista; use Consultar janela."
        : "Caso aberto. Ele está na lista."
    );
    added.querySelector("button")?.focus();
  };

  listButton.addEventListener("click", () => {
    if (!loading) {
      load();
    }
  });
  reason.addEventListener("input", () => {
    counter.textContent = `${[...reason.value].length} de ${MAX_REASON_LENGTH} caracteres`;
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!loading) {
      open();
    }
  });

  return {
    busy: (on) => {
      reading = on;
      refreshButtons();
    },
    element: dom.el(
      "div",
      { class: "cases" },
      dom.el("h3", {}, "Caso de suporte"),
      listButton,
      notice.element,
      dom.el("div", { class: "results" }, list)
    ),
    form,
    show: (id) => {
      turn += 1;
      organizationId = id;
      loading = false;
      reading = false;
      shown = 0;
      rows.replaceChildren();
      readButtons.length = 0;
      reason.value = "";
      counter.textContent = `0 de ${MAX_REASON_LENGTH} caracteres`;
      notice.clear();
      showRows();
      refreshButtons();
    },
  };
}
