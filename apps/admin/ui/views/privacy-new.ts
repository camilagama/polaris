import { PROBLEM_TEXT } from "../api";
import type { ScreenTools } from "../app";
import { storeName } from "../dom";
import { createNotice } from "../notice";
import {
  CHANNELS,
  isCode,
  privacyCasePath,
  REQUEST_TYPES,
  REQUESTER_KINDS,
} from "../privacy";
import type {
  OpenedPrivacyCase,
  OrganizationPage,
  OrganizationSummary,
} from "../types";
import { organizationsView } from "./organizations";
import {
  choiceField,
  MAX_NOTE_LENGTH,
  NO_PERSONAL_DATA,
  noteProblem,
  plainField,
  textField,
} from "./privacy-form";
import { MAX_REASON_LENGTH, reasonProblem } from "./support-case";

const DAY_TEXT = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;
/** Brasília is UTC−3 all year (no daylight saving since 2019): a day there starts at 03:00 UTC. */
const BRASILIA_OFFSET_MS = 3 * 3_600_000;

export const OPEN_EFFECT =
  "Abrir o atendimento fica no registro e na auditoria com o seu e-mail. O registro do atendimento não se apaga por esta tela: ele fecha só pela resolução, na etapa 6. Se a loja for apagada, o texto livre do atendimento some e o registro fica.";
const OPEN_REFUSED =
  "O atendimento não foi aberto: confira o motivo, as três listas, a data de recebimento (até hoje, no máximo um ano atrás) e a nota.";
const OPEN_UNKNOWN =
  "Não deu para confirmar se o atendimento foi aberto. Veja a lista de atendimentos de privacidade antes de abrir outro; para tentar de novo, recarregue esta página.";

interface Choice {
  id: string;
  name: string | null;
}

/**
 * The day the request arrived, as the instant the route takes: 00:00 of that day in Brasília. Null when the field is
 * empty (the server takes now); a string when the day is not a real one or is after today.
 */
function receivedOf(
  text: string,
  now: Date
): string | null | { problem: string } {
  if (text === "") {
    return null;
  }
  const match = DAY_TEXT.exec(text);
  const year = Number(match?.[1]);
  const month = Number(match?.[2]);
  const day = Number(match?.[3]);
  const midnight = new Date(Date.UTC(year, month - 1, day));
  if (
    match === null ||
    midnight.getUTCFullYear() !== year ||
    midnight.getUTCMonth() !== month - 1 ||
    midnight.getUTCDate() !== day
  ) {
    return { problem: "Informe um dia válido, ou deixe vazio." };
  }
  const start = midnight.getTime() + BRASILIA_OFFSET_MS;
  if (start > now.getTime()) {
    return { problem: "A data de recebimento não pode ser depois de hoje." };
  }
  if (start < now.getTime() - 365 * DAY_MS) {
    return { problem: "A data de recebimento vai até um ano atrás." };
  }
  return new Date(start).toISOString();
}

/**
 * Abrir atendimento de privacidade (corte admin-v2, Parte 11, AC-P11.1): the store (from `?loja=` or the search), the reason
 * (1 to 500, with its counter), the channel, the kind of request and who asks (only codes of the domain's closed
 * lists, nothing chosen for the operator), the optional day it arrived and a short note, with the fixed warning above
 * the fields. One request per click; the case opened is shown on its own screen.
 */
export function privacyNewView(tools: ScreenTools): HTMLElement {
  const { api, can, context, dom, navigate, now } = tools;
  const notice = createNotice(dom);
  const chosenLine = dom.el(
    "p",
    { class: "chosen", id: "privacidade-loja" },
    "Nenhuma loja escolhida."
  );
  const reason = textField(
    dom,
    "privacidade-motivo",
    "Motivo",
    MAX_REASON_LENGTH,
    "Por que o atendimento existe, curto. Fica na auditoria."
  );
  const channel = choiceField(dom, "privacidade-canal", "Canal", CHANNELS);
  const requestType = choiceField(
    dom,
    "privacidade-tipo",
    "Tipo de pedido",
    REQUEST_TYPES
  );
  const requester = choiceField(
    dom,
    "privacidade-quem",
    "Quem pede",
    REQUESTER_KINDS
  );
  const received = plainField(
    dom,
    "privacidade-recebido",
    "Recebido em (opcional)",
    "date",
    "Vazio: agora. Use quando o pedido chegou antes, por outro canal; o prazo conta desse dia."
  );
  const note = textField(
    dom,
    "privacidade-nota",
    "Nota curta (opcional)",
    MAX_NOTE_LENGTH
  );
  const openButton = dom.el(
    "button",
    { type: "submit" },
    "Abrir atendimento de privacidade"
  );
  const form = dom.el(
    "form",
    { class: "case-form privacy-form", novalidate: "" },
    dom.el("h3", {}, "Loja do atendimento"),
    chosenLine,
    dom.el(
      "p",
      { class: "warning", id: "privacidade-aviso" },
      NO_PERSONAL_DATA
    ),
    reason.element,
    channel.element,
    requestType.element,
    requester.element,
    received.element,
    note.element,
    dom.el("p", {}, OPEN_EFFECT),
    dom.el("div", { class: "button-row" }, openButton)
  );

  let chosen: Choice | null = null;
  let sending = false;

  const choose = (choice: Choice) => {
    chosen = choice;
    dom.fill(
      chosenLine,
      "Loja: ",
      storeName(dom, choice.name ?? "nome não lido", choice.id)
    );
  };

  /** The body the route takes, or null once the first field the server would refuse is marked. */
  const bodyOf = (target: Choice) => {
    const fields = [reason, channel, requestType, requester, received, note];
    for (const field of fields) {
      field.reset();
    }
    const reasonText = reason.control.value.trim();
    const reasonRefused = reasonProblem(reasonText);
    if (reasonRefused !== null) {
      reason.refuse(reasonRefused);
      return null;
    }
    const lists = [
      [channel, CHANNELS, "Escolha o canal."],
      [requestType, REQUEST_TYPES, "Escolha o tipo de pedido."],
      [requester, REQUESTER_KINDS, "Escolha quem pede."],
    ] as const;
    for (const [field, list, problem] of lists) {
      if (!isCode(list, field.control.value)) {
        field.refuse(problem);
        return null;
      }
    }
    const day = receivedOf(received.control.value, now());
    if (day !== null && typeof day === "object") {
      received.refuse(day.problem);
      return null;
    }
    const noteText = note.control.value.trim();
    const noteRefused = noteProblem(noteText, "A nota");
    if (noteRefused !== null) {
      note.refuse(noteRefused);
      return null;
    }
    const body: Record<string, string> = {
      channel: channel.control.value,
      organizationId: target.id,
      reason: reasonText,
      requesterKind: requester.control.value,
      requestType: requestType.control.value,
    };
    if (day !== null) {
      body.receivedAt = day;
    }
    if (noteText !== "") {
      body.note = noteText;
    }
    return body;
  };

  const open = async (target: Choice) => {
    notice.clear();
    const body = bodyOf(target);
    if (body === null) {
      return;
    }
    sending = true;
    openButton.setAttribute("aria-disabled", "true");
    notice.status("Abrindo o atendimento de privacidade…");
    const answer = await api.post<OpenedPrivacyCase>(
      "/api/privacy-cases",
      body
    );
    const path = answer.ok ? privacyCasePath(answer.data?.id) : null;
    if (answer.ok && path !== null) {
      // the button stays off: the screen of the case opened replaces this one
      notice.success(
        "Atendimento de privacidade aberto. Abrindo o atendimento…"
      );
      navigate(path);
      return;
    }
    if (
      answer.ok ||
      answer.problem === "network" ||
      answer.problem === "failed" ||
      answer.problem === "unavailable"
    ) {
      // the case may have been opened: the button stays off, so a second click cannot open another one
      notice.alert(OPEN_UNKNOWN);
      return;
    }
    sending = false;
    openButton.setAttribute("aria-disabled", "false");
    if (answer.problem === "invalid") {
      notice.alert(OPEN_REFUSED);
    } else if (answer.problem === "not_found") {
      notice.alert("Esta loja não foi encontrada.");
    } else {
      notice.alert(PROBLEM_TEXT[answer.problem]);
    }
  };

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (sending) {
      return;
    }
    if (chosen === null) {
      notice.alert("Escolha a loja antes de abrir o atendimento.");
      return;
    }
    open(chosen);
  });

  const parts: (HTMLElement | null)[] = [];
  const { store } = context;
  if (store !== null) {
    choose({ id: store, name: null });
    if (can("organization:diagnose")) {
      readName(store);
    }
  } else if (can("organization:diagnose")) {
    parts.push(
      organizationsView(
        dom,
        api,
        (organization: OrganizationSummary) => {
          choose({ id: organization.id, name: organization.name });
          reason.control.focus();
        },
        "Escolher loja"
      )
    );
  } else {
    dom.fill(
      chosenLine,
      "Sem permissão para buscar loja: abra o atendimento pela tela da loja."
    );
  }

  /** The chosen store's name, by its exact ID (the search, not audited); the case is opened by the ID all the same. */
  async function readName(id: string) {
    const parameters = new URLSearchParams({ limit: "1", query: id });
    const answer = await api.get<OrganizationPage>(
      `/api/organizations?${parameters.toString()}`
    );
    if (!answer.ok) {
      notice.alert(PROBLEM_TEXT[answer.problem]);
      return;
    }
    const found = Array.isArray(answer.data?.organizations)
      ? answer.data.organizations.find((item) => item.id === id)
      : undefined;
    if (found === undefined) {
      notice.alert("Esta loja não foi encontrada.");
      return;
    }
    if (chosen?.id === id) {
      choose({ id, name: found.name });
    }
  }

  const discard = () => {
    reason.clear();
    note.clear();
    received.control.value = "";
  };
  // a page restored from the back-forward cache must not show what was typed
  dom.document.defaultView?.addEventListener("pagehide", discard);

  return dom.el(
    "section",
    { "aria-labelledby": "privacidade-novo-titulo", class: "area" },
    dom.el(
      "h2",
      { id: "privacidade-novo-titulo" },
      "Novo atendimento de privacidade"
    ),
    ...parts,
    form,
    notice.element
  );
}
