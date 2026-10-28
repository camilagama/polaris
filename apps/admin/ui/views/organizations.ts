import type { Api } from "../api";
import { PROBLEM_TEXT } from "../api";
import { tableRow } from "../blocks";
import { type Dom, hasControlCharacter, shownName, storeName } from "../dom";
import {
  billingStateText,
  brasiliaDay,
  planText,
  storeStatusText,
} from "../format";
import { createNotice } from "../notice";
import type { OrganizationPage, OrganizationSummary } from "../types";

/** The server's limits for the search (GET /api/organizations): what is typed beyond them is refused here first. */
const MAX_QUERY_LENGTH = 100;
const PAGE_SIZE = "25";

const HEADERS = [
  "Loja",
  "Situação",
  "Assinatura",
  "Plano em vigor",
  "Fim do acesso",
  "Ação",
] as const;

function countText(count: number, more: boolean): string {
  if (count === 0) {
    return "Nenhuma loja encontrada.";
  }
  const found =
    count === 1 ? "1 loja encontrada." : `${count} lojas encontradas.`;
  return more ? `${found} Há mais: use Carregar mais.` : found;
}

/**
 * Lojas (AC-4): the search by exact ID or the start of the name, as the server does it. The text goes to the server
 * as it was typed (no wildcard is added, nothing is trimmed or rewritten); a text the server would refuse (too long,
 * a control character) is refused here with a sentence, and the request is not made.
 */
export function organizationsView(
  dom: Dom,
  api: Api,
  onSelect: (organization: OrganizationSummary) => void
): HTMLElement {
  const notice = createNotice(dom);
  const input = dom.el("input", {
    "aria-describedby": "busca-dica",
    autocomplete: "off",
    id: "busca",
    maxlength: String(MAX_QUERY_LENGTH),
    name: "busca",
    spellcheck: "false",
    type: "search",
  });
  const searchButton = dom.el("button", { type: "submit" }, "Buscar");
  const moreButton = dom.el(
    "button",
    { class: "secondary", hidden: "", type: "button" },
    "Carregar mais"
  );
  const rows = dom.el("tbody");
  const results = dom.el(
    "table",
    { class: "grid", hidden: "" },
    dom.el("caption", { class: "sr-only" }, "Lojas encontradas"),
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

  let query = "";
  let next: string | null = null;
  let shown = 0;

  const busy = (on: boolean) => {
    for (const button of [searchButton, moreButton]) {
      if (on) {
        button.setAttribute("disabled", "");
      } else {
        button.removeAttribute("disabled");
      }
    }
  };

  const row = (organization: OrganizationSummary) => {
    const open = dom.el(
      "button",
      {
        "aria-label": `Ver loja ${shownName(organization.name)} (${organization.id})`,
        class: "secondary",
        type: "button",
      },
      "Ver loja"
    );
    open.addEventListener("click", () => onSelect(organization));
    return tableRow(dom, HEADERS, [
      storeName(dom, organization.name, organization.id),
      storeStatusText(organization.status),
      billingStateText(organization.billingState),
      planText(organization.planInForce),
      brasiliaDay(organization.accessEndsAt),
      open,
    ]);
  };

  const load = async (after: string | null) => {
    const parameters = new URLSearchParams({ limit: PAGE_SIZE, query });
    if (after !== null) {
      parameters.set("after", after);
    }
    busy(true);
    notice.status("Buscando lojas…");
    const answer = await api.get<OrganizationPage>(
      `/api/organizations?${parameters.toString()}`
    );
    busy(false);
    if (!answer.ok) {
      notice.alert(PROBLEM_TEXT[answer.problem]);
      return;
    }
    if (after === null) {
      rows.replaceChildren();
      shown = 0;
    }
    for (const organization of answer.data.organizations) {
      rows.append(row(organization));
    }
    shown += answer.data.organizations.length;
    ({ next } = answer.data);
    if (shown === 0) {
      results.setAttribute("hidden", "");
    } else {
      results.removeAttribute("hidden");
    }
    if (next === null) {
      moreButton.setAttribute("hidden", "");
    } else {
      moreButton.removeAttribute("hidden");
    }
    notice.status(countText(shown, next !== null));
  };

  const form = dom.el(
    "form",
    { class: "search", novalidate: "" },
    dom.el("label", { for: "busca" }, "Buscar loja"),
    dom.el("div", { class: "search-row" }, input, searchButton),
    dom.el(
      "p",
      { class: "hint", id: "busca-dica" },
      "ID exato da loja ou começo do nome. Vazio lista todas."
    )
  );
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const typed = input.value;
    if (typed.length > MAX_QUERY_LENGTH) {
      notice.alert("A busca aceita até 100 caracteres.");
      return;
    }
    if (hasControlCharacter(typed)) {
      notice.alert("A busca não aceita caracteres de controle.");
      return;
    }
    query = typed;
    load(null);
  });
  moreButton.addEventListener("click", () => {
    if (next !== null) {
      load(next);
    }
  });

  return dom.el(
    "section",
    { "aria-labelledby": "lojas-titulo", class: "area" },
    dom.el("h2", { id: "lojas-titulo" }, "Lojas"),
    form,
    notice.element,
    dom.el("div", { class: "results" }, results),
    moreButton
  );
}
