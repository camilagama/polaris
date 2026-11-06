import { PROBLEM_TEXT } from "../api";
import type { ScreenTools } from "../app";
import { tableRow } from "../blocks";
import { hasControlCharacter, labelName, storeName } from "../dom";
import { brasiliaMomentText, caseKindText } from "../format";
import { createNotice } from "../notice";
import type {
  OrganizationPage,
  OrganizationSummary,
  SupportCasePage,
  SupportCaseSummary,
} from "../types";
import { caseLink, newCaseLink } from "./case-links";

/** The server's limits for the store filter of `GET /api/support-cases` (`MAX_ID_LENGTH`) and its page. */
const MAX_STORE_LENGTH = 128;
/** The server's limit for the name search of `GET /api/organizations`. */
const MAX_NAME_LENGTH = 100;
const CHOICES_PAGE = "10";
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

const INVALID_FILTER_BY_NAME =
  "O filtro não foi aceito. Escolha a loja de novo pelo nome.";
const INVALID_FILTER_BY_ID =
  "O filtro não foi aceito: use o ID da loja, até 128 caracteres.";
const NO_STORE_NAMED =
  "Nenhuma loja começa com esse nome. Tente menos letras do início do nome ou deixe o campo vazio para ver os atendimentos de todas as lojas.";

/**
 * Atendimentos (AC-P1.4): the open or the closed cases, of every store or of one, a page at a time, read when the
 * screen opens (the list is not audited). The store is chosen by its name: the search is the Lojas one, and the ID
 * it finds is only the value the filter sends, kept out of the URL and out of the field; an operator who cannot
 * search stores types the ID, as before. The tabs are links with a fixed value. A privacy case is listed for reading
 * only: its reason and its steps belong to the privacy workflow.
 */
export function casesView(tools: ScreenTools): HTMLElement {
  const { api, can, context, dom } = tools;
  const state = STATES[context.listState];
  const notice = createNotice(dom);
  const byName = can("organization:diagnose");
  const storeInput = dom.el("input", {
    "aria-describedby": "casos-loja-dica",
    autocomplete: "off",
    id: "casos-loja",
    maxlength: String(byName ? MAX_NAME_LENGTH : MAX_STORE_LENGTH),
    name: "loja",
    spellcheck: "false",
    type: "search",
  });
  storeInput.value = byName ? "" : (context.store ?? "");
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
  const chosen = dom.el("p", { class: "chosen", hidden: "" });
  const choices = dom.el("ul", { class: "case-list", hidden: "" });
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

  let store = byName ? (context.store ?? "") : storeInput.value;
  /** The name of the store chosen by the search; a store that came with the address is named from its cases or by its ID. */
  let storeNamed: string | undefined;
  let next: string | null = null;
  let shown = 0;
  let loading = false;
  let turn = 0;
  let searchTurn = 0;

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
      searchTurn += 1;
      choices.setAttribute("hidden", "");
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
      const invalid = byName ? INVALID_FILTER_BY_NAME : INVALID_FILTER_BY_ID;
      notice.alert(
        answer.problem === "invalid" ? invalid : PROBLEM_TEXT[answer.problem]
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
    if (after === null) {
      nameChosen(answer.data.cases[0]?.organizationName);
    } else {
      added[0]?.querySelector("a")?.focus();
    }
  };

  /** The store the filter holds, by name; with no case to take the name from, the store is asked for by its ID. */
  const nameChosen = async (known: string | undefined) => {
    if (!byName || store === "") {
      chosen.setAttribute("hidden", "");
      return;
    }
    let name = storeNamed ?? known;
    if (name === undefined) {
      const mine = searchTurn;
      const target = store;
      const found = await api.get<OrganizationPage>(
        `/api/organizations?${new URLSearchParams({ limit: "1", query: store }).toString()}`
      );
      if (mine !== searchTurn || target !== store) {
        return;
      }
      name =
        found.ok && Array.isArray(found.data?.organizations)
          ? found.data.organizations.find((item) => item.id === store)?.name
          : undefined;
    }
    if (name !== undefined) {
      storeInput.value = name;
    }
    dom.fill(
      chosen,
      "Loja: ",
      name === undefined ? "escolhida pelo endereço" : labelName(name),
      "."
    );
    chosen.removeAttribute("hidden");
  };

  const choose = (organization: OrganizationSummary) => {
    store = organization.id;
    storeNamed = organization.name;
    storeInput.value = organization.name;
    choices.setAttribute("hidden", "");
    load(null);
  };

  const searchByName = async (typed: string) => {
    searchTurn += 1;
    const mine = searchTurn;
    choices.setAttribute("hidden", "");
    busy(true);
    notice.status("Buscando a loja…");
    const answer = await api.get<OrganizationPage>(
      `/api/organizations?${new URLSearchParams({ limit: CHOICES_PAGE, query: typed }).toString()}`
    );
    if (mine !== searchTurn) {
      return;
    }
    busy(false);
    if (!answer.ok) {
      notice.alert(PROBLEM_TEXT[answer.problem]);
      return;
    }
    const found = Array.isArray(answer.data?.organizations)
      ? answer.data.organizations
      : [];
    if (found.length === 0) {
      notice.alert(NO_STORE_NAMED);
      return;
    }
    const [only] = found;
    if (found.length === 1 && only !== undefined) {
      choose(only);
      return;
    }
    const more =
      typeof answer.data.next === "string"
        ? " Há mais: escreva mais letras do nome."
        : "";
    dom.fill(
      choices,
      ...found.map((organization) => {
        const pick = dom.el(
          "button",
          { class: "secondary", type: "button" },
          `Escolher ${labelName(organization.name)}`
        );
        pick.addEventListener("click", () => {
          if (!loading) {
            choose(organization);
          }
        });
        return dom.el("li", {}, pick);
      })
    );
    choices.removeAttribute("hidden");
    notice.status(`${found.length} lojas com esse nome. Escolha uma.${more}`);
    choices.querySelector("button")?.focus();
  };

  const emptyNextStep = (): (HTMLElement | string)[] => {
    if (store !== "") {
      return [
        "Não há atendimentos para esta loja. Confira a loja ou deixe o campo vazio e filtre para ver os de todas as lojas.",
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
    dom.el(
      "label",
      { for: "casos-loja" },
      byName ? "Nome da loja" : "ID da loja"
    ),
    dom.el("div", { class: "search-row" }, storeInput, filterButton),
    dom.el(
      "p",
      { class: "hint", id: "casos-loja-dica" },
      byName
        ? "Digite o começo do nome da loja. Vazio lista os atendimentos de todas as lojas."
        : "Vazio lista os atendimentos de todas as lojas."
    ),
    choices
  );
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (loading) {
      return;
    }
    const typed = storeInput.value;
    if (byName) {
      if (typed.length > MAX_NAME_LENGTH || hasControlCharacter(typed)) {
        notice.alert(
          "A busca aceita o nome da loja, até 100 caracteres, sem caracteres de controle."
        );
        return;
      }
      if (typed !== "") {
        searchByName(typed);
        return;
      }
      store = "";
      storeNamed = undefined;
      load(null);
      return;
    }
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
    chosen,
    notice.element,
    nextStep,
    dom.el("div", { class: "results" }, list),
    moreButton
  );
}
