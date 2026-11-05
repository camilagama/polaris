import { type ApiFailure, PROBLEM_TEXT } from "../api";
import type { ScreenTools } from "../app";
import { facts, tableRow } from "../blocks";
import { labelName } from "../dom";
import {
  brasiliaMomentText,
  brasiliaTime,
  deadEventStateText,
  incidentCauseText,
  incidentKindText,
  minutesText,
} from "../format";
import { createNotice } from "../notice";
import type {
  DeadEventSummary,
  OperationalIncidentDetail,
  RetryAnswer,
  RetryResult,
} from "../types";
import { isUuid } from "./incident-links";

const PAGE_SIZE = "25";
const REFERENCE_SHOWN = 200;

export const FOREVER_TEXT =
  "As ocorrências somam para sempre: acompanhe os eventos a reenviar.";
export const RETRY_EFFECT =
  "O evento volta para a fila e será enviado no próximo ciclo (até uma hora). Reenviar de novo é seguro. Fica na auditoria.";
export const NO_EVENTS = "Nenhum evento morto neste incidente.";
export const INCIDENT_NOT_FOUND = "Este incidente não foi encontrado.";
export const RETRY_UNKNOWN =
  "Não deu para confirmar se o evento foi reenviado. Recarregue a página para ver o estado antes de tentar de novo.";

const HEADERS = [
  "Evento",
  "Tipo",
  "Estado",
  "Ocorrências",
  "Primeira",
  "Última",
  "Reenvios",
  "Ação",
] as const;

const RESULTS: ReadonlySet<string> = new Set<RetryResult>([
  "already_pending",
  "busy",
  "event_gone",
  "retried",
  "unknown_item",
]);

function isResult(value: unknown): value is RetryResult {
  return typeof value === "string" && RESULTS.has(value);
}

const STALE_LIST =
  " Não foi possível reler a lista: o estado desta linha pode estar desatualizado.";

function resultText(
  result: RetryResult,
  at: string,
  listUpdated: boolean
): string {
  switch (result) {
    case "retried":
      return `Reenviado às ${at}. O evento sai no próximo ciclo (até uma hora).${listUpdated ? "" : STALE_LIST}`;
    case "already_pending":
      return `Este evento já estava na fila. Nada foi mudado; ele sai no próximo ciclo (até uma hora).${listUpdated ? "" : STALE_LIST}`;
    case "busy":
      return "Este evento está sendo processado agora. Nada foi mudado. Tente de novo mais tarde.";
    case "event_gone":
      return "Este evento não existe mais e não pode ser reenviado. Nada foi mudado.";
    case "unknown_item":
      return listUpdated
        ? "Este evento não foi encontrado neste incidente. Nada foi mudado. A lista foi atualizada."
        : "Este evento não foi encontrado neste incidente. Nada foi mudado.";
    default: {
      const unreachable: never = result;
      return unreachable;
    }
  }
}

/** What the lists ask to be read again once: the answers that say the list the operator saw is not the truth, or is about to stop being it (a sent event changes state and count on the server, which the screen never computes). */
const REREAD: ReadonlySet<RetryResult> = new Set<RetryResult>([
  "already_pending",
  "busy",
  "event_gone",
  "retried",
  "unknown_item",
]);

function setHidden(element: HTMLElement, hidden: boolean) {
  if (hidden) {
    element.setAttribute("hidden", "");
  } else {
    element.removeAttribute("hidden");
  }
}

function countText(count: number, more: boolean): string {
  if (count === 0) {
    return NO_EVENTS;
  }
  const found = count === 1 ? "1 evento." : `${count} eventos.`;
  return more ? `${found} Há mais: use Carregar mais.` : found;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isDetail(data: unknown): data is OperationalIncidentDetail {
  if (!(isObject(data) && Array.isArray(data.events))) {
    return false;
  }
  const { incident } = data;
  return (
    isObject(incident) &&
    typeof incident.kind === "string" &&
    typeof incident.cause === "string" &&
    typeof incident.subject === "string" &&
    data.events.every(
      (event) =>
        isObject(event) &&
        typeof event.eventId === "string" &&
        typeof event.eventType === "string"
    )
  );
}

function failureText(failure: ApiFailure): string {
  switch (failure.problem) {
    case "network":
      return RETRY_UNKNOWN;
    case "rate_limited":
      return failure.retryAfterSeconds === undefined
        ? PROBLEM_TEXT.rate_limited
        : `Limite de consultas por hora atingido. Tente de novo em ${minutesText(failure.retryAfterSeconds)}.`;
    case "invalid":
    case "not_found":
      return PROBLEM_TEXT.failed;
    default:
      return PROBLEM_TEXT[failure.problem];
  }
}

export function incidentView(tools: ScreenTools): HTMLElement {
  const { api, can, context, dom, now } = tools;
  const canRetry = can("operational_incident:retry");
  const headers = canRetry ? HEADERS : HEADERS.slice(0, -1);
  const notice = createNotice(dom);
  const incidentId = context.id;
  const back = dom.el(
    "p",
    {},
    dom.el("a", { href: "/incidentes" }, "Voltar para os incidentes")
  );
  const head = dom.el("div", { class: "incident" });
  const rows = dom.el("tbody");
  const table = dom.el(
    "table",
    { class: "grid incidents", hidden: "" },
    dom.el("caption", { class: "sr-only" }, "Eventos mortos do incidente"),
    dom.el(
      "thead",
      {},
      dom.el(
        "tr",
        {},
        ...headers.map((header) => dom.el("th", { scope: "col" }, header))
      )
    ),
    rows
  );
  const moreButton = dom.el(
    "button",
    { class: "secondary", hidden: "", type: "button" },
    "Carregar mais"
  );
  const effect = dom.el(
    "p",
    { class: "hint", hidden: "", id: "reenviar-efeito" },
    RETRY_EFFECT
  );

  const lines = new Map<string, HTMLElement>();
  const said = new Map<string, string>();
  const senders = new Map<string, HTMLElement>();
  let next: string | null = null;
  let shown = 0;
  let busy = false;

  const setBusy = (on: boolean) => {
    busy = on;
    for (const button of [moreButton, ...senders.values()]) {
      button.setAttribute("aria-disabled", String(on));
    }
  };

  const say = (eventId: string, text: string) => {
    said.set(eventId, text);
    const line = lines.get(eventId);
    if (line !== undefined) {
      line.textContent = text;
    }
  };

  const retry = async (eventId: string) => {
    if (busy || incidentId === null) {
      return;
    }
    setBusy(true);
    say(eventId, "Reenviando…");
    const sender = senders.get(eventId);
    if (sender !== undefined) {
      sender.textContent = "Reenviando…";
    }
    const answer = await api.post<RetryAnswer>(
      `/api/operational-incidents/${incidentId}/events/${eventId}/retry`,
      {},
      [404, 409]
    );
    const result = answer.ok ? answer.data?.result : undefined;
    if (sender !== undefined) {
      sender.textContent = "Reenviar";
    }
    if (!isResult(result)) {
      setBusy(false);
      say(eventId, "");
      notice.alert(answer.ok ? PROBLEM_TEXT.failed : failureText(answer));
      return;
    }
    await settle(eventId, result);
  };

  const settle = async (eventId: string, result: RetryResult) => {
    const at = brasiliaTime(now());
    say(eventId, resultText(result, at, true));
    let reread = true;
    try {
      if (REREAD.has(result)) {
        reread = await load(null);
      }
    } finally {
      setBusy(false);
    }
    if (!reread) {
      say(eventId, resultText(result, at, false));
      return;
    }
    const current = lines.get(eventId);
    if (current === undefined) {
      notice.success(said.get(eventId) ?? "");
    } else {
      current.focus();
    }
  };

  const action = (item: DeadEventSummary) => {
    const line = dom.el("p", {
      class: "status",
      role: "status",
      tabindex: "-1",
    });
    const previous = said.get(item.eventId);
    if (previous !== undefined) {
      line.textContent = previous;
    }
    if (!isUuid(item.eventId)) {
      return dom.el("div", {}, "—", line);
    }
    const button = dom.el(
      "button",
      {
        "aria-describedby": "reenviar-efeito",
        "aria-disabled": String(busy),
        type: "button",
      },
      "Reenviar"
    );
    button.setAttribute("aria-label", `Reenviar o evento ${item.eventId}`);
    button.addEventListener("click", () => {
      retry(item.eventId);
    });
    senders.set(item.eventId, button);
    lines.set(item.eventId, line);
    return dom.el("div", {}, button, line);
  };

  const row = (item: DeadEventSummary) => {
    const cells = [
      dom.el("code", {}, labelName(item.eventId, 40)),
      dom.el("code", {}, labelName(item.eventType, 80)),
      deadEventStateText(item.state),
      String(item.occurrences),
      brasiliaMomentText(item.firstSeenAt),
      brasiliaMomentText(item.lastSeenAt),
      item.retryCount === 0
        ? "Nenhum"
        : `${item.retryCount}, o último em ${brasiliaMomentText(item.retriedAt)}`,
    ];
    return tableRow(dom, headers, canRetry ? [...cells, action(item)] : cells);
  };

  const showHead = (incident: OperationalIncidentDetail["incident"]) => {
    const reference = incident.lastReference;
    dom.fill(
      head,
      facts(dom, [
        ["Tipo", incidentKindText(incident.kind)],
        ["Causa", incidentCauseText(incident.cause)],
        ["Assunto", dom.el("code", {}, labelName(incident.subject, 80))],
        ["Ocorrências", String(incident.occurrenceCount)],
        ["Primeira", brasiliaMomentText(incident.firstSeenAt)],
        ["Última", brasiliaMomentText(incident.lastSeenAt)],
        [
          "Referência",
          reference === null
            ? "—"
            : dom.el("code", {}, labelName(reference, REFERENCE_SHOWN)),
        ],
      ]),
      dom.el("p", { class: "hint" }, FOREVER_TEXT)
    );
  };

  async function load(after: string | null): Promise<boolean> {
    if (incidentId === null) {
      return false;
    }
    const parameters = new URLSearchParams({ limit: PAGE_SIZE });
    if (after !== null) {
      parameters.set("after", after);
    }
    const wasBusy = busy;
    setBusy(true);
    notice.status("Buscando eventos…");
    const answer = await api.get<OperationalIncidentDetail>(
      `/api/operational-incidents/${incidentId}?${parameters.toString()}`
    );
    setBusy(wasBusy);
    if (!answer.ok) {
      notice.alert(
        answer.problem === "not_found"
          ? INCIDENT_NOT_FOUND
          : failureText(answer)
      );
      return false;
    }
    if (!isDetail(answer.data)) {
      notice.alert(PROBLEM_TEXT.failed);
      return false;
    }
    if (after === null) {
      rows.replaceChildren();
      lines.clear();
      senders.clear();
      shown = 0;
    }
    showHead(answer.data.incident);
    const added = answer.data.events.map(row);
    rows.append(...added);
    shown += added.length;
    next = typeof answer.data.next === "string" ? answer.data.next : null;
    setHidden(table, shown === 0);
    setHidden(effect, shown === 0 || !canRetry);
    setHidden(moreButton, next === null);
    notice.status(countText(shown, next !== null));
    if (after !== null) {
      added[0]?.querySelector("button")?.focus();
    }
    return true;
  }

  moreButton.addEventListener("click", () => {
    if (!busy && next !== null) {
      load(next);
    }
  });

  if (incidentId === null) {
    notice.alert(INCIDENT_NOT_FOUND);
  } else {
    load(null);
  }
  return dom.el(
    "section",
    { "aria-labelledby": "incidente-titulo", class: "area" },
    dom.el("h2", { id: "incidente-titulo" }, "Incidente operacional"),
    back,
    head,
    notice.element,
    dom.el("h3", {}, "Eventos mortos"),
    effect,
    dom.el("div", { class: "results" }, table),
    moreButton
  );
}
