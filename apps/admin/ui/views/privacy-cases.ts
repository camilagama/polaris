import { PROBLEM_TEXT } from "../api";
import type { ScreenTools } from "../app";
import { tableRow } from "../blocks";
import type { Dom } from "../dom";
import { storeName } from "../dom";
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
  "Caso",
] as const;

const STATES = {
  abertos: {
    empty: "Nenhum caso de privacidade aberto.",
    label: "Abertos",
    value: "open",
  },
  fechados: {
    empty: "Nenhum caso de privacidade fechado.",
    label: "Fechados",
    value: "closed",
  },
} as const;

function countText(count: number, more: boolean, empty: string): string {
  if (count === 0) {
    return empty;
  }
  const found = count === 1 ? "1 caso." : `${count} casos.`;
  return more ? `${found} Há mais: use Carregar mais.` : found;
}

/**
 * The due date in words, from what the server returned (AC-P11.1, AC-P11.6): two days or less, or past, is a warning
 * said in words, never only by color; every due date carries "prazo provisório" (ADR 0077: 15 days, provisional).
 */
export function dueCell(
  dom: Dom,
  item: { dueAt: string; overdue: boolean },
  now: Date
): HTMLElement {
  const due = dueText(item.dueAt, item.overdue, now);
  return dom.el(
    "span",
    { class: due.warn ? "due due-warn" : "due" },
    dom.el(
      "span",
      { class: "due-text" },
      due.warn ? `Atenção: ${due.text}` : due.text
    ),
    ` (até ${due.day}, ${PROVISIONAL})`
  );
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
  const list = dom.el(
    "table",
    { class: "grid", hidden: "" },
    dom.el(
      "caption",
      { class: "sr-only" },
      `Casos de privacidade ${state.label.toLowerCase()}`
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

  const row = (item: PrivacyCaseSummary) => {
    const path = privacyCasePath(item.id);
    const open = item.status === "open";
    return tableRow(dom, HEADERS, [
      brasiliaMomentText(item.openedAt),
      storeName(dom, item.organizationName, item.organizationId),
      labelOf(REQUEST_TYPES, item.requestType),
      labelOf(REQUESTER_KINDS, item.requesterKind),
      labelOf(STAGES, item.stage),
      open ? dueCell(dom, item, now()) : "Caso fechado",
      path === null
        ? "—"
        : dom.el(
            "a",
            {
              "aria-label": `Ver caso de privacidade aberto em ${brasiliaMomentText(item.openedAt)}`,
              href: path,
            },
            "Ver caso"
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
    notice.status("Buscando casos de privacidade…");
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
      `Casos de privacidade ${state.label.toLowerCase()}`
    ),
    dom.el(
      "ul",
      { "aria-label": "Estado dos casos", class: "tabs" },
      tab("abertos", "/privacidade"),
      tab("fechados", "/privacidade?estado=fechados")
    ),
    dom.el(
      "p",
      { class: "action-link" },
      dom.el(
        "a",
        { class: "button-link", href: "/privacidade/novo" },
        "Abrir caso de privacidade"
      )
    ),
    dom.el(
      "p",
      { class: "hint" },
      "O prazo de resposta de cada caso é o que o servidor guardou ao abri-lo, contado do recebimento do pedido. É provisório até a revisão jurídica."
    ),
    notice.element,
    dom.el("div", { class: "results" }, list),
    moreButton
  );
}
