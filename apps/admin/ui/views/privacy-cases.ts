import { PROBLEM_TEXT } from "../api";
import type { ScreenTools } from "../app";
import { tableRow } from "../blocks";
import type { Dom } from "../dom";
import { storeNameInList } from "../dom";
import { brasiliaMomentText } from "../format";
import { createNotice } from "../notice";
import {
  dueText,
  labelOf,
  PROVISIONAL,
  privacyCasePath,
  REQUEST_TYPES,
  REQUESTER_KINDS,
  STAGES,
} from "../privacy";
import type { PrivacyCasePage, PrivacyCaseSummary } from "../types";

const PAGE_SIZE = "25";

const HEADERS = [
  "Aberto em",
  "Loja",
  "Pedido",
  "Quem pede",
  "Etapa",
  "Prazo",
  "Atendimento",
] as const;

const STATES = {
  abertos: {
    empty: "Nenhum atendimento de privacidade aberto.",
    label: "Abertos",
    value: "open",
  },
  fechados: {
    empty: "Nenhum atendimento de privacidade fechado.",
    label: "Fechados",
    value: "closed",
  },
} as const;

function emptyNextStep(
  dom: Dom,
  listState: keyof typeof STATES
): (HTMLElement | string)[] {
  if (listState === "fechados") {
    return [
      "Para ver os que estão em andamento, abra ",
      dom.el("a", { href: "/privacidade" }, "Pedidos de dados abertos"),
      ".",
    ];
  }
  return [
    "Quando um titular pedir os dados dele, registre o pedido em ",
    dom.el(
      "a",
      { href: "/privacidade/novo" },
      "Abrir atendimento de privacidade"
    ),
    ".",
  ];
}

function countText(count: number, more: boolean, empty: string): string {
  if (count === 0) {
    return empty;
  }
  const found = count === 1 ? "1 atendimento." : `${count} atendimentos.`;
  return more ? `${found} Há mais: use Carregar mais.` : found;
}

export interface DueView {
  element: HTMLElement;
  /** Says the due date again for another moment; the day, the provisional mark and the order of the page stay. */
  redraw: (now: Date) => void;
}

/**
 * The due date in words, from what the server returned (AC-P11.1, AC-P11.6): two days or less, or past, is a warning
 * said in words, never only by color; every due date carries "prazo provisório" (ADR 0077: 15 days, provisional).
 */
export function dueView(
  dom: Dom,
  item: { dueAt: string; overdue: boolean },
  now: Date
): DueView {
  const first = dueText(item.dueAt, item.overdue, now);
  const words = dom.el("span", { class: "due-text" });
  const element = dom.el(
    "span",
    {},
    words,
    ` (até ${first.day}, ${PROVISIONAL})`
  );
  const redraw = (at: Date) => {
    const due = dueText(item.dueAt, item.overdue, at);
    if (due.warn) {
      element.setAttribute("class", "due due-warn");
    } else {
      element.setAttribute("class", "due");
    }
    words.textContent = due.warn ? `Atenção: ${due.text}` : due.text;
  };
  redraw(now);
  return { element, redraw };
}

/**
 * Says the due dates again when the page comes back (tab visible, window focused), with the same wording rule and no
 * timer: a page left open and in view between those two events keeps the words of the last draw until one of them, or a
 * reload. The listeners stay for the life of the document: a page restored from the back-forward cache needs them.
 */
export function keepDuesCurrent(
  dom: Dom,
  now: () => Date,
  views: () => readonly DueView[]
): void {
  const redraw = () => {
    if (dom.document.hidden) {
      return;
    }
    const at = now();
    for (const view of views()) {
      view.redraw(at);
    }
  };
  dom.document.addEventListener("visibilitychange", redraw);
  dom.document.defaultView?.addEventListener("focus", redraw);
}

/**
 * Privacidade (corte admin-v2, Parte 11, AC-P11.1): the open or the resolved privacy cases, a page at a time, read
 * when the screen opens (the list is not audited). Each row says the store, the request, the stage and the due date
 * the server keeps, in words; the tabs are links with a fixed value, and nothing of a case goes to the URL but its
 * UUID.
 */
export function privacyCasesView(tools: ScreenTools): HTMLElement {
  const { api, context, dom, now } = tools;
  const state = STATES[context.listState];
  const notice = createNotice(dom);
  const moreButton = dom.el(
    "button",
    { class: "secondary", hidden: "", type: "button" },
    "Carregar mais"
  );
  const rows = dom.el("tbody");
  const nextStep = dom.el("p", { class: "hint", hidden: "" });
  const list = dom.el(
    "table",
    { class: "grid", hidden: "" },
    dom.el(
      "caption",
      { class: "sr-only" },
      `Atendimentos de privacidade ${state.label.toLowerCase()}`
    ),
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

  let next: string | null = null;
  let shown = 0;
  let loading = false;
  const dues: DueView[] = [];

  const row = (item: PrivacyCaseSummary) => {
    const path = privacyCasePath(item.id);
    const open = item.status === "open";
    let due: HTMLElement | string = "Atendimento fechado";
    if (open) {
      const view = dueView(dom, item, now());
      dues.push(view);
      due = view.element;
    }
    return tableRow(dom, HEADERS, [
      brasiliaMomentText(item.openedAt),
      storeNameInList(dom, item.organizationName, item.organizationId),
      labelOf(REQUEST_TYPES, item.requestType),
      labelOf(REQUESTER_KINDS, item.requesterKind),
      labelOf(STAGES, item.stage),
      due,
      path === null
        ? "—"
        : dom.el(
            "a",
            {
              "aria-label": `Ver atendimento de privacidade aberto em ${brasiliaMomentText(item.openedAt)}`,
              href: path,
            },
            "Ver atendimento"
          ),
    ]);
  };

  const load = async (after: string | null) => {
    const parameters = new URLSearchParams({
      filter: state.value,
      limit: PAGE_SIZE,
    });
    if (after !== null) {
      parameters.set("after", after);
    }
    loading = true;
    moreButton.setAttribute("aria-disabled", "true");
    notice.status("Buscando atendimentos de privacidade…");
    const answer = await api.get<PrivacyCasePage>(
      `/api/privacy-cases?${parameters.toString()}`
    );
    loading = false;
    moreButton.setAttribute("aria-disabled", "false");
    if (!answer.ok) {
      notice.alert(
        PROBLEM_TEXT[answer.problem === "invalid" ? "failed" : answer.problem]
      );
      return;
    }
    if (!Array.isArray(answer.data?.cases)) {
      notice.alert(PROBLEM_TEXT.failed);
      return;
    }
    const added = answer.data.cases.map(row);
    rows.append(...added);
    shown += added.length;
    next = typeof answer.data.next === "string" ? answer.data.next : null;
    if (shown === 0) {
      list.setAttribute("hidden", "");
      dom.fill(nextStep, ...emptyNextStep(dom, context.listState));
      nextStep.removeAttribute("hidden");
    } else {
      list.removeAttribute("hidden");
    }
    if (next === null) {
      moreButton.setAttribute("hidden", "");
    } else {
      moreButton.removeAttribute("hidden");
    }
    notice.status(countText(shown, next !== null, state.empty));
    if (after !== null) {
      added[0]?.querySelector("a")?.focus();
    }
  };

  moreButton.addEventListener("click", () => {
    if (!loading && next !== null) {
      load(next);
    }
  });

  keepDuesCurrent(dom, now, () => dues);

  const tab = (key: keyof typeof STATES, path: string) => {
    const attributes =
      key === context.listState
        ? { "aria-current": "page", href: path }
        : { href: path };
    return dom.el("li", {}, dom.el("a", attributes, STATES[key].label));
  };

  load(null);
  return dom.el(
    "section",
    { "aria-labelledby": "privacidade-titulo", class: "area" },
    dom.el(
      "h2",
      { id: "privacidade-titulo" },
      `Atendimentos de privacidade ${state.label.toLowerCase()}`
    ),
    dom.el(
      "ul",
      { "aria-label": "Estado dos atendimentos", class: "tabs" },
      tab("abertos", "/privacidade"),
      tab("fechados", "/privacidade?estado=fechados")
    ),
    dom.el(
      "p",
      { class: "action-link" },
      dom.el(
        "a",
        { class: "button-link", href: "/privacidade/novo" },
        "Abrir atendimento de privacidade"
      )
    ),
    dom.el(
      "p",
      { class: "hint" },
      "O prazo de resposta de cada atendimento é o que o servidor guardou ao abri-lo, contado do recebimento do pedido. É provisório até a revisão jurídica."
    ),
    notice.element,
    nextStep,
    dom.el("div", { class: "results" }, list),
    moreButton
  );
}
