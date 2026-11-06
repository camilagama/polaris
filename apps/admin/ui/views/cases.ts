import { PROBLEM_TEXT } from "../api";
import type { ScreenTools } from "../app";
import { tableRow } from "../blocks";
import { hasControlCharacter, labelName, storeName } from "../dom";
import { brasiliaMomentText, caseKindText } from "../format";
import { createNotice } from "../notice";
import type { SupportCasePage, SupportCaseSummary } from "../types";
import { caseLink, newCaseLink } from "./case-links";

/** The server's limits for the store filter of `GET /api/support-cases` (`MAX_ID_LENGTH`) and its page. */
const MAX_STORE_LENGTH = 128;
const PAGE_SIZE = "25";
const REASON_SHOWN = 120;

const HEADERS = [
  "Aberto em",
  "Loja",
  "Tipo",
  "Motivo",
  "Estado",
  "Atendimento",
] as const;

const STATES = {
  abertos: {
    empty: "Nenhum atendimento aberto.",
    label: "Abertos",
    value: "open",
  },
  fechados: {
    empty: "Nenhum atendimento fechado.",
    label: "Fechados",
    value: "closed",
  },
} as const;

function countText(count: number, more: boolean, empty: string): string {
  if (count === 0) {
    return empty;
  }
  const found = count === 1 ? "1 atendimento." : `${count} atendimentos.`;
  return more ? `${found} Há mais: use Carregar mais.` : found;
}

function stateText(item: SupportCaseSummary): string {
  if (item.status === "open") {
    return "Aberto";
  }
  if (item.status === "closed") {
    return `Fechado em ${brasiliaMomentText(item.closedAt)}`;
  }
  return `estado desconhecido: ${item.status}`;
}

/**
 * Atendimentos (AC-P1.4): the open or the closed cases, of every store or of one, a page at a time, read when the
 * screen opens (the list is not audited). The store filter goes to the server as it was typed, never trimmed or
 * rewritten, and stays out of the URL; the tabs are links with a fixed value. A privacy case is listed for reading
 * only: its reason and its steps belong to the privacy workflow.
 */
export function casesView(tools: ScreenTools): HTMLElement {
  const { api, can, context, dom } = tools;
  const state = STATES[context.listState];
  const notice = createNotice(dom);
  const storeInput = dom.el("input", {
    "aria-describedby": "casos-loja-dica",
    autocomplete: "off",
    id: "casos-loja",
    maxlength: String(MAX_STORE_LENGTH),
    name: "loja",
    spellcheck: "false",
    type: "search",
  });
  storeInput.value = context.store ?? "";
  const filterButton = dom.el(
    "button",
    { class: "secondary", type: "submit" },
    "Filtrar"
  );
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
    dom.el("caption", { class: "sr-only" }, `Atendimentos ${state.label}`),
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

  let store = storeInput.value;
  let next: string | null = null;
  let shown = 0;
  let loading = false;
  let turn = 0;

  const busy = (on: boolean) => {
    loading = on;
    for (const button of [filterButton, moreButton]) {
      button.setAttribute("aria-disabled", String(on));
    }
  };

  const row = (item: SupportCaseSummary) => {
    const support = item.kind === "support";
    const reason = support
      ? dom.el(
          "span",
          { class: "reason", title: labelName(item.reason, 500) },
          labelName(item.reason, REASON_SHOWN)
        )
      : "Fica no fluxo de privacidade.";
    const link = support ? caseLink(dom, item) : null;
    return tableRow(dom, HEADERS, [
      brasiliaMomentText(item.openedAt),
      storeName(dom, item.organizationName, item.organizationId),
      caseKindText(item.kind),
      reason,
      stateText(item),
      link ?? "Só leitura",
    ]);
  };

  const load = async (after: string | null) => {
    turn += 1;
    const mine = turn;
    const parameters = new URLSearchParams({
      limit: PAGE_SIZE,
      status: state.value,
    });
    if (store !== "") {
      parameters.set("organizationId", store);
    }
    if (after === null) {
      rows.replaceChildren();
      shown = 0;
      next = null;
      list.setAttribute("hidden", "");
      moreButton.setAttribute("hidden", "");
      nextStep.setAttribute("hidden", "");
    } else {
      parameters.set("after", after);
    }
    busy(true);
    notice.status("Buscando atendimentos…");
    const answer = await api.get<SupportCasePage>(
      `/api/support-cases?${parameters.toString()}`
    );
    if (mine !== turn) {
      return;
    }
    busy(false);
    if (!answer.ok) {
      notice.alert(
        answer.problem === "invalid"
          ? "O filtro não foi aceito: use o ID da loja, até 128 caracteres."
          : PROBLEM_TEXT[answer.problem]
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
      dom.fill(nextStep, ...emptyNextStep());
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

  const emptyNextStep = (): (HTMLElement | string)[] => {
    if (store !== "") {
      return [
        "Confira o ID da loja ou deixe o campo vazio para ver os atendimentos de todas as lojas.",
      ];
    }
    if (context.listState === "fechados") {
      return [
        "Para ver os que estão em andamento, abra ",
        dom.el("a", { href: "/casos" }, "Atendimentos abertos"),
        ".",
      ];
    }
    return can("organization:diagnose")
      ? [
          "Para mexer em uma loja, abra um em ",
          dom.el("a", { href: "/lojas" }, "Lojas"),
          ".",
        ]
      : [
          "Para mexer em uma loja, use ",
          dom.el("a", { href: "/casos/novo" }, "Abrir atendimento"),
          ".",
        ];
  };

  const form = dom.el(
    "form",
    { class: "search", novalidate: "" },
    dom.el("label", { for: "casos-loja" }, "ID da loja"),
    dom.el("div", { class: "search-row" }, storeInput, filterButton),
    dom.el(
      "p",
      { class: "hint", id: "casos-loja-dica" },
      "Vazio lista os atendimentos de todas as lojas."
    )
  );
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (loading) {
      return;
    }
    const typed = storeInput.value;
    if (typed.length > MAX_STORE_LENGTH || hasControlCharacter(typed)) {
      notice.alert(
        "O filtro aceita só o ID da loja, até 128 caracteres, sem caracteres de controle."
      );
      return;
    }
    store = typed;
    load(null);
  });
  moreButton.addEventListener("click", () => {
    if (!loading && next !== null) {
      load(next);
    }
  });

  const suffix = context.store === null ? "" : `loja=${context.store}`;
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
    { "aria-labelledby": "casos-titulo", class: "area" },
    dom.el(
      "h2",
      { id: "casos-titulo" },
      `Atendimentos ${state.label.toLowerCase()}`
    ),
    dom.el(
      "ul",
      { "aria-label": "Estado dos atendimentos", class: "tabs" },
      tab("abertos", suffix === "" ? "/casos" : `/casos?${suffix}`),
      tab(
        "fechados",
        suffix === ""
          ? "/casos?estado=fechados"
          : `/casos?estado=fechados&${suffix}`
      )
    ),
    newCaseLink(dom, context.store),
    form,
    notice.element,
    nextStep,
    dom.el("div", { class: "results" }, list),
    moreButton
  );
}
