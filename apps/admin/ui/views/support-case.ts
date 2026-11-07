import type { Api, Problem } from "../api";
import { PROBLEM_TEXT } from "../api";
import { tableRow } from "../blocks";
import { type Dom, hasControlCharacter, labelName } from "../dom";
import { brasiliaMomentText, caseKindText } from "../format";
import { createNotice } from "../notice";
import type { SupportCasePage, SupportCaseSummary } from "../types";

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
  /** Starts over for another store: nothing of the one before stays, and nothing is read until asked. */
  show: (organizationId: string) => void;
}

function countText(count: number, more: boolean): string {
  if (count === 0) {
    return "Nenhum atendimento aberto desta loja. Abra um atendimento para ler a cobrança.";
  }
  const found =
    count === 1 ? "1 atendimento aberto." : `${count} atendimentos abertos.`;
  return more ? `${found} Mostrando os ${CASES_PAGE} mais recentes.` : found;
}

/**
 * What a failed opening says. Without an answer the case may have been opened all the same (the request may have
 * reached the server): the operator looks at the list before asking again, so a case is not opened twice.
 */
export function openProblemText(problem: Problem): string {
  if (problem === "invalid") {
    return `O motivo não foi aceito: use de 1 a ${MAX_REASON_LENGTH} caracteres, sem caracteres de controle.`;
  }
  if (
    problem === "network" ||
    problem === "failed" ||
    problem === "unavailable"
  ) {
    return "Não foi possível confirmar se o atendimento foi aberto. Veja os atendimentos abertos desta loja antes de tentar de novo.";
  }
  return PROBLEM_TEXT[problem];
}

/** Why a reason typed here would be refused by the server, or null when it would be taken (AC-11). */
export function reasonProblem(reason: string): string | null {
  const trimmed = reason.trim();
  if (trimmed === "") {
    return "Escreva o motivo do atendimento.";
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
 * The open support cases of the chosen store (AC-9): listed when the operator asks; a case is opened in Atendimentos,
 * not here, so the store's screen has one way to open it. Each case listed offers
 * the read of the refund window through `onRead`, when the operator may read it; without an open case of this store
 * there is nothing to click, so the window's route is never called.
 */
export function supportCasesView(
  dom: Dom,
  api: Api,
  options: {
    canRead: boolean;
    onRead: (choice: CaseChoice) => void;
    /** The sentence that says what a read leaves behind: shown right above the list whose buttons make the read. */
    readHint: HTMLElement | null;
  }
): SupportCasesView {
  const notice = createNotice(dom);
  const listButton = dom.el(
    "button",
    { class: "secondary", type: "button" },
    "Ver atendimentos abertos desta loja"
  );
  const rows = dom.el("tbody");
  const list = dom.el(
    "table",
    { class: "grid", hidden: "" },
    dom.el("caption", { class: "sr-only" }, "Atendimentos abertos desta loja"),
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
  let organizationId = "";
  let loading = false;
  let reading = false;
  let shown = 0;
  let turn = 0;
  const readButtons: HTMLButtonElement[] = [];

  const refreshButtons = () => {
    listButton.setAttribute("aria-disabled", String(loading));
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
          "aria-describedby": options.readHint?.getAttribute("id") ?? "",
          "aria-label": `Ler a cobrança: atendimento aberto em ${brasiliaMomentText(supportCase.openedAt)}`,
          class: "secondary",
          type: "button",
        },
        "Ler a cobrança"
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
    for (const element of [list, options.readHint]) {
      if (element === null) {
        continue;
      }
      if (shown === 0) {
        element.setAttribute("hidden", "");
      } else {
        element.removeAttribute("hidden");
      }
    }
  };

  const load = async () => {
    turn += 1;
    const mine = turn;
    loading = true;
    refreshButtons();
    notice.status("Buscando atendimentos abertos…");
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
    refreshButtons();
    if (!answer.ok) {
      // the page asks with its own store and state: a 400 is the Admin's error, not something the operator typed
      notice.alert(
        PROBLEM_TEXT[answer.problem === "invalid" ? "failed" : answer.problem]
      );
      return;
    }
    if (!Array.isArray(answer.data?.cases)) {
      notice.alert(PROBLEM_TEXT.failed);
      return;
    }
    // the server filters by store and state; a case of another store or not open is never offered, whatever came.
    // A privacy case has its own workflow and capability: its reason is not shown here, nor is it offered for the read
    const cases = answer.data.cases.filter(
      (item: SupportCaseSummary) =>
        item.organizationId === organizationId &&
        item.status === "open" &&
        item.kind === "support"
    );
    rows.replaceChildren();
    readButtons.length = 0;
    rows.append(...cases.map(row));
    shown = cases.length;
    showRows();
    refreshButtons();
    notice.status(countText(shown, answer.data.next !== null));
  };

  listButton.addEventListener("click", () => {
    if (!loading) {
      load();
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
      dom.el("h3", {}, "Atendimento de suporte"),
      listButton,
      notice.element,
      dom.el("div", { class: "results" }, options.readHint, list)
    ),
    show: (id) => {
      turn += 1;
      organizationId = id;
      loading = false;
      reading = false;
      shown = 0;
      rows.replaceChildren();
      readButtons.length = 0;
      notice.clear();
      showRows();
      refreshButtons();
    },
  };
}
