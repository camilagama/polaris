import { PROBLEM_TEXT } from "../api";
import type { ScreenTools } from "../app";
import { tableRow } from "../blocks";
import { brasiliaDay } from "../format";
import { createNotice } from "../notice";
import { HOLD_STOPS_PURGE, REVIEW_DUE } from "../purge-words";
import type { LegalHoldPage, LegalHoldSummary } from "../types";
import { storePath } from "./case-links";

const PAGE_SIZE = "25";
export const NO_HOLDS = "Nenhuma loja com trava legal.";
const HOLDS_READ_ONLY =
  "Só leitura. Pôr, mudar a data de revisão e liberar a trava são ações de um atendimento de privacidade aberto da loja, na aba Apagamento e trava legal.";

const HEADERS = ["Loja (ID)", "Desde", "Revisão em", "Situação"] as const;

function countText(count: number, more: boolean): string {
  const found = count === 1 ? "1 trava legal." : `${count} travas legais.`;
  return more ? `${found} Há mais: use Carregar mais.` : found;
}

function dueText(due: number): string {
  return due === 1
    ? `1 trava está ${REVIEW_DUE}: ela continua valendo até ser liberada.`
    : `${due} travas estão pendentes de revisão: elas continuam valendo até serem liberadas.`;
}

/**
 * Lojas com trava legal (`/retencoes`, corte admin-v2, Parte 7, AC-P7.4): the holds in force, read only, as the server lists
 * them (the store by its ID, never by its name). A hold past its review date is marked "pendente de revisão" and is
 * still in force. Nothing here places or releases a hold: that is an act of a case.
 */
export function legalHoldsView(tools: ScreenTools): HTMLElement {
  const { api, can, dom } = tools;
  const notice = createNotice(dom);
  const due = dom.el("p", { class: "warning", hidden: "" });
  const moreButton = dom.el(
    "button",
    { class: "secondary", hidden: "", type: "button" },
    "Carregar mais"
  );
  const rows = dom.el("tbody");
  const nextStep = dom.el(
    "p",
    { class: "hint", hidden: "" },
    ...(can("privacy_case:manage")
      ? [
          "Para pôr uma trava, abra o pedido de dados da loja e use a aba Apagamento e trava legal. ",
          dom.el("a", { href: "/privacidade" }, "Ir para Pedidos de dados"),
        ]
      : [
          "Quem atende os pedidos de dados da loja põe a trava, na aba Apagamento e trava legal.",
        ])
  );
  const list = dom.el(
    "table",
    { class: "grid", hidden: "" },
    dom.el("caption", { class: "sr-only" }, "Travas legais vigentes"),
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

  const storeCell = (hold: LegalHoldSummary) => {
    const id = dom.el("code", { class: "store-id" }, hold.organizationId);
    const path = storePath(hold.organizationId);
    return can("organization:diagnose") && path !== null
      ? dom.el("a", { href: path }, id)
      : id;
  };

  const row = (hold: LegalHoldSummary) =>
    tableRow(dom, HEADERS, [
      storeCell(hold),
      brasiliaDay(hold.placedAt),
      brasiliaDay(hold.reviewAt),
      hold.reviewDue ? `Vigente · ${REVIEW_DUE}` : "Vigente",
    ]);

  const load = async (after: string | null) => {
    const query = after === null ? "" : `&after=${encodeURIComponent(after)}`;
    loading = true;
    moreButton.setAttribute("aria-disabled", "true");
    notice.status("Buscando travas legais…");
    const answer = await api.get<LegalHoldPage>(
      `/api/legal-holds?limit=${PAGE_SIZE}${query}`
    );
    loading = false;
    moreButton.setAttribute("aria-disabled", "false");
    if (!answer.ok) {
      notice.alert(PROBLEM_TEXT[answer.problem]);
      return;
    }
    if (!Array.isArray(answer.data?.holds)) {
      notice.alert(PROBLEM_TEXT.failed);
      return;
    }
    const added = answer.data.holds.map(row);
    rows.append(...added);
    shown += added.length;
    next = typeof answer.data.next === "string" ? answer.data.next : null;
    const dueCount = answer.data.dueForReview;
    if (typeof dueCount === "number" && dueCount > 0) {
      due.textContent = dueText(dueCount);
      due.removeAttribute("hidden");
    }
    if (shown > 0) {
      list.removeAttribute("hidden");
    } else {
      nextStep.removeAttribute("hidden");
    }
    if (next === null) {
      moreButton.setAttribute("hidden", "");
    } else {
      moreButton.removeAttribute("hidden");
    }
    notice.status(shown === 0 ? NO_HOLDS : countText(shown, next !== null));
    if (after !== null) {
      added[0]?.querySelector("a")?.focus();
    }
  };

  moreButton.addEventListener("click", () => {
    if (!loading && next !== null) {
      load(next);
    }
  });

  load(null);
  return dom.el(
    "section",
    { "aria-labelledby": "retencoes-titulo", class: "area" },
    dom.el("h2", { id: "retencoes-titulo" }, "Travas legais vigentes"),
    dom.el("p", { class: "hint" }, HOLDS_READ_ONLY),
    dom.el("p", { class: "hint" }, HOLD_STOPS_PURGE),
    due,
    notice.element,
    nextStep,
    dom.el("div", { class: "results" }, list),
    moreButton
  );
}
