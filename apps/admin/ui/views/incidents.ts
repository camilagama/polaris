import { PROBLEM_TEXT } from "../api";
import type { ScreenTools } from "../app";
import { tableRow } from "../blocks";
import { labelName } from "../dom";
import {
  brasiliaMomentText,
  incidentCauseText,
  incidentKindText,
} from "../format";
import { createNotice } from "../notice";
import type {
  OperationalIncidentPage,
  OperationalIncidentSummary,
} from "../types";
import { incidentLink } from "./incident-links";

const PAGE_SIZE = "25";
export const NO_INCIDENTS = "Nenhuma falha de envio. Tudo foi entregue.";

const HEADERS = [
  "Tipo",
  "Causa",
  "Assunto",
  "Ocorrências",
  "Primeira",
  "Última",
  "A reenviar",
  "Falha de envio",
] as const;

function countText(count: number, more: boolean): string {
  const found = count === 1 ? "1 falha de envio." : `${count} falhas de envio.`;
  return more ? `${found} Há mais: use Carregar mais.` : found;
}

/** The count of occurrences only grows, so the column that tells what is left to do is the dead events still to send again. */
export function incidentsView(tools: ScreenTools): HTMLElement {
  const { api, dom } = tools;
  const notice = createNotice(dom);
  const moreButton = dom.el(
    "button",
    { class: "secondary", hidden: "", type: "button" },
    "Carregar mais"
  );
  const rows = dom.el("tbody");
  const list = dom.el(
    "table",
    { class: "grid incidents", hidden: "" },
    dom.el("caption", { class: "sr-only" }, "Falhas de envio"),
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
  const reloadButton = dom.el(
    "button",
    { class: "secondary", type: "button" },
    "Atualizar"
  );

  let next: string | null = null;
  let shown = 0;
  let loading = false;

  const busy = (on: boolean) => {
    loading = on;
    for (const button of [moreButton, reloadButton]) {
      button.setAttribute("aria-disabled", String(on));
    }
  };

  const row = (item: OperationalIncidentSummary) => {
    const link = incidentLink(
      dom,
      item,
      `Ver falha de envio: ${incidentCauseText(item.cause)}, ${labelName(item.subject, 80)}`
    );
    return tableRow(dom, HEADERS, [
      incidentKindText(item.kind),
      incidentCauseText(item.cause),
      dom.el("code", {}, labelName(item.subject, 80)),
      String(item.occurrenceCount),
      brasiliaMomentText(item.firstSeenAt),
      brasiliaMomentText(item.lastSeenAt),
      String(item.deadEvents),
      link ?? "—",
    ]);
  };

  const load = async (after: string | null) => {
    const parameters = new URLSearchParams({ limit: PAGE_SIZE });
    if (after === null) {
      rows.replaceChildren();
      shown = 0;
      next = null;
      list.setAttribute("hidden", "");
      moreButton.setAttribute("hidden", "");
    } else {
      parameters.set("after", after);
    }
    busy(true);
    notice.status("Buscando falhas de envio…");
    const answer = await api.get<OperationalIncidentPage>(
      `/api/operational-incidents?${parameters.toString()}`
    );
    busy(false);
    if (!answer.ok) {
      notice.alert(PROBLEM_TEXT[answer.problem]);
      return;
    }
    if (!Array.isArray(answer.data?.incidents)) {
      notice.alert(PROBLEM_TEXT.failed);
      return;
    }
    const added = answer.data.incidents.map(row);
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
    notice.status(shown === 0 ? NO_INCIDENTS : countText(shown, next !== null));
    if (after !== null) {
      added[0]?.querySelector("a")?.focus();
    }
  };

  moreButton.addEventListener("click", () => {
    if (!loading && next !== null) {
      load(next);
    }
  });
  reloadButton.addEventListener("click", () => {
    if (!loading) {
      load(null);
    }
  });

  load(null);
  return dom.el(
    "section",
    { "aria-labelledby": "incidentes-titulo", class: "area" },
    dom.el("h2", { id: "incidentes-titulo" }, "Falhas de envio"),
    dom.el(
      "p",
      { class: "hint" },
      "Uma falha por causa. A coluna A reenviar conta os eventos que não foram entregues e esperam reenvio."
    ),
    dom.el("div", { class: "button-row" }, reloadButton),
    notice.element,
    dom.el("div", { class: "results" }, list),
    moreButton
  );
}
