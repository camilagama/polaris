import {
  PROBLEM_TEXT,
  type Problem,
  type StoreCommandOutcome,
  sendStoreCommand,
} from "../api";
import { environmentText, type ScreenTools } from "../app";
import { facts } from "../blocks";
import { labelName, storeName } from "../dom";
import { brasiliaDay, brasiliaMomentText, storeStatusText } from "../format";
import { createNotice, type Notice } from "../notice";
import { PURGE_SCOPE } from "../privacy";
import {
  CANCEL_EFFECT,
  CANCEL_RECORD,
  CANCEL_RULE,
  CANCEL_UNDO,
  CASE_REQUIRED,
  COMMAND_UNKNOWN,
  HOLD_RECORD,
  HOLD_RULE,
  HOLD_STOPS_PURGE,
  HELD_WHILE_SCHEDULED,
  HOLD_UNDO,
  holdEffectText,
  NEXT_PURGE_CYCLE,
  ONLY_CLOSED,
  PURGE_DONE,
  PURGE_KEPT,
  PURGE_NOT_NOW,
  PURGE_RECORD,
  PURGE_UNDO,
  PURGE_REFUSALS,
  purgeErasedText,
  purgeRefusalText,
  READ_FAILED,
  RELEASE_EFFECT,
  RELEASE_RECORD,
  RELEASE_UNDO,
  REVIEW_DUE,
  SERVER_CHECKS,
  TYPE_THE_NAME,
} from "../purge-words";
import type {
  LegalHoldAnswer,
  LegalHoldPage,
  LegalHoldSummary,
  OrganizationDiagnostics,
  PrivacyCaseDetail,
  PurgeCancelled,
  PurgeScheduled,
} from "../types";
import {
  MAX_NOTE_LENGTH,
  NO_PERSONAL_DATA,
  noteProblem,
  plainField,
  textField,
} from "./privacy-form";

type Detail = PrivacyCaseDetail;

/** The legal holds are read 50 at a time; past this many pages the screen says it could not check them. */
const HOLD_PAGE_SIZE = 50;
const MAX_HOLD_PAGES = 20;
const DAY_INPUT = /^(\d{4})-(\d{2})-(\d{2})$/;

export interface PurgeHooks {
  /** False once the screen was drawn again or left: an old read writes nothing. */
  current: () => boolean;
  /** What this page was told by the server and keeps only in memory: the start of the purge this page scheduled. */
  memory: { notBefore: string | null };
  /** Reads the case again and says how the command ended once the screen is shown again; false if it could not. */
  reread: (outcome?: {
    kind: "alert" | "success";
    text: string;
  }) => Promise<boolean>;
}

interface Buttons {
  back: HTMLButtonElement;
  confirm: HTMLButtonElement;
  reload: HTMLButtonElement;
}

/** Whether the tab may be offered at all: one of its two capabilities. The server asks for each again. */
export function mayShowPurgeTab(can: (capability: string) => boolean): boolean {
  return can("organization:purge") || can("organization:legal_hold");
}

/** Why this case cannot carry the purge, in words, or null when it is an accepted deletion of the whole store. */
export function purgeCaseProblem(detail: Detail): string | null {
  const { privacy } = detail;
  if (privacy.requestType !== "deletion") {
    return "Este atendimento não é um pedido de exclusão.";
  }
  if (privacy.requesterKind !== "organization_owner") {
    return "Este pedido de exclusão não foi feito pelo dono da loja.";
  }
  if (
    !(privacy.stage === "decided" || privacy.stage === "executed") ||
    privacy.decision !== "accept"
  ) {
    return "O pedido de exclusão deste atendimento ainda não foi decidido como aceito por inteiro.";
  }
  const scope = privacy.scopeCategories ?? [];
  const exact =
    scope.length === PURGE_SCOPE.length &&
    PURGE_SCOPE.every((code) => scope.includes(code));
  return exact
    ? null
    : "O escopo deste atendimento não é exatamente o que o purge apaga: dados da loja, clientes, vendas, estoque e catálogo, imagens.";
}

const PURGE_STATUSES: Readonly<Record<string, string>> = {
  closed: "Encerrada",
  closing: "Em encerramento",
  purge_pending: "Encerrada, com o apagamento agendado",
  purged: "Apagada (o apagamento terminou)",
};

function statusText(status: string): string {
  return PURGE_STATUSES[status] ?? storeStatusText(status);
}

function problemText(problem: Problem): string {
  if (problem === "not_found") {
    return "Este atendimento não foi encontrado.";
  }
  return PROBLEM_TEXT[problem === "invalid" ? "failed" : problem];
}

function isPurgeAnswer(value: unknown): value is PurgeScheduled {
  return (
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    typeof value.status === "string" &&
    "changed" in value &&
    typeof value.changed === "boolean"
  );
}

function isHoldAnswer(value: unknown): value is LegalHoldAnswer {
  return (
    typeof value === "object" &&
    value !== null &&
    "held" in value &&
    typeof value.held === "boolean" &&
    "changed" in value &&
    typeof value.changed === "boolean"
  );
}

/** The last time this case's trail names one of the events, or null. */
function lastEvent(detail: Detail, types: readonly string[]) {
  const found = detail.audit.filter((entry) => types.includes(entry.eventType));
  return found.at(-1) ?? null;
}

/** A day typed as `aaaa-mm-dd`, as dd/mm/aaaa; null when it is not one. */
function typedDay(value: string): string | null {
  const parts = DAY_INPUT.exec(value);
  return parts === null ? null : `${parts[3]}/${parts[2]}/${parts[1]}`;
}

const HOLD_REVIEW_MAX_DAYS = 366;
const HOLD_REVIEW_SKEW_MS = 3_600_000;
const BRASILIA_OFFSET_MS = 3 * 3_600_000;

const brasiliaDayOf = (at: number): string =>
  new Date(at - BRASILIA_OFFSET_MS).toISOString().slice(0, 10);

/**
 * The instant sent for a chosen review day: the end of that day in Brasília, but never later than the server's limit
 * (now plus 366 days) minus a margin for clock skew, because the end of the last permitted day can lie past that limit.
 * Null for a day after the last one that can be sent; days in the past are left to the server.
 */
export function holdReviewAt(day: string, now: Date): string | null {
  if (!DAY_INPUT.test(day)) {
    return null;
  }
  const ceiling =
    now.getTime() + HOLD_REVIEW_MAX_DAYS * 86_400_000 - HOLD_REVIEW_SKEW_MS;
  if (day > brasiliaDayOf(ceiling)) {
    return null;
  }
  const endOfDay = `${day}T23:59:59-03:00`;
  return new Date(endOfDay).getTime() > ceiling
    ? new Date(ceiling).toISOString()
    : endOfDay;
}

/** The last day the review field offers: the same ceiling as `holdReviewAt`. */
export function lastHoldReviewDay(now: Date): string {
  return brasiliaDayOf(
    now.getTime() + HOLD_REVIEW_MAX_DAYS * 86_400_000 - HOLD_REVIEW_SKEW_MS
  );
}

/** Same name: both sides in NFC, only the ends trimmed, case kept; an empty name never matches. */
export function sameStoreName(typed: string, name: string): boolean {
  const expected = name.trim().normalize("NFC");
  return expected !== "" && typed.trim().normalize("NFC") === expected;
}

interface StoreState {
  /** The hold in force, null for none, undefined when the operator may not read the holds. */
  hold: LegalHoldSummary | null | undefined;
  /** The store's status, null when the operator may not read the store. */
  status: string | null;
}

/**
 * "Apagamento e trava legal", the tab `?acao=purge` of a privacy case (corte admin-v2, Parte 7; ADR 0081 and 0102). It
 * reads the store's status (diagnostics) and the holds in force, both without audit, and shows what the server said;
 * it never computes the 90 days or a date. Scheduling is the strongest confirmation of the Admin (the store's name
 * typed); cancelling asks for a reason; placing and releasing the hold are reviewed in two steps. One request per
 * click, and the case, with this tab, is read again after every answer. The closure notice is not here (Parte 12).
 */
export function purgeTab(
  tools: ScreenTools,
  detail: Detail,
  hooks: PurgeHooks
): HTMLElement {
  const { api, can, context, dom } = tools;
  const item = detail.case;
  const slot = dom.el("div", { class: "purge-slot" });
  let sending = false;

  const wrap = (...children: (HTMLElement | null)[]) =>
    dom.el(
      "section",
      { "aria-labelledby": "purge-titulo", class: "purge action-panel" },
      dom.el(
        "h3",
        { id: "purge-titulo", tabindex: "-1" },
        "Apagamento e trava legal"
      ),
      ...children
    );

  const caseFacts = (extra: [string, Node | string][] = []) =>
    facts(dom, [
      ["Ambiente", environmentText(context)],
      ["Loja", storeName(dom, item.organizationName, item.organizationId)],
      [
        "Atendimento",
        `Atendimento de privacidade aberto em ${brasiliaMomentText(item.openedAt)}`,
      ],
      ...extra,
    ]);

  const line = (text: string, kind = "hint") =>
    dom.el("p", { class: kind }, text);

  const rereadButton = () => {
    const again = dom.el(
      "button",
      { class: "secondary", type: "button" },
      "Reler o atendimento"
    );
    again.addEventListener("click", () => {
      hooks.reread();
    });
    return again;
  };

  const readStatus = async (): Promise<string | null | false> => {
    if (!can("organization:diagnose")) {
      return null;
    }
    const answer = await api.get<OrganizationDiagnostics>(
      `/api/organizations/${encodeURIComponent(item.organizationId)}/diagnostics`
    );
    const organization = answer.ok ? answer.data?.organization : undefined;
    return organization?.id === item.organizationId &&
      typeof organization.status === "string"
      ? organization.status
      : false;
  };

  /** One page of the holds in force; each page needs the cursor of the one before, so they are read in turn. */
  const holdFrom = async (
    after: string | null,
    page: number
  ): Promise<LegalHoldSummary | null | false> => {
    if (page >= MAX_HOLD_PAGES) {
      return false;
    }
    const query = after === null ? "" : `&after=${encodeURIComponent(after)}`;
    const answer = await api.get<LegalHoldPage>(
      `/api/legal-holds?limit=${HOLD_PAGE_SIZE}${query}`
    );
    if (!(answer.ok && Array.isArray(answer.data?.holds))) {
      return false;
    }
    const found = answer.data.holds.find(
      (hold) => hold.organizationId === item.organizationId
    );
    if (found !== undefined) {
      return found;
    }
    return typeof answer.data.next === "string"
      ? holdFrom(answer.data.next, page + 1)
      : null;
  };

  const readHold = (): Promise<LegalHoldSummary | null | undefined | false> =>
    can("organization:legal_hold")
      ? holdFrom(null, 0)
      : Promise.resolve(undefined);

  const read = async () => {
    const status = await readStatus();
    const hold = status === false ? false : await readHold();
    if (!hooks.current()) {
      return;
    }
    if (status === false || hold === false) {
      dom.fill(
        slot,
        wrap(
          dom.el("p", { class: "hint", role: "status" }, READ_FAILED),
          rereadButton()
        )
      );
      return;
    }
    draw({ hold, status });
  };

  const holdStatedInPurge = (state: StoreState): boolean =>
    can("organization:purge") &&
    state.status === "closed" &&
    purgeCaseProblem(detail) === null &&
    state.hold !== null &&
    state.hold !== undefined;

  const holdText = (hold: StoreState["hold"]): string => {
    if (hold === undefined) {
      return "O servidor confere ao agendar.";
    }
    if (hold === null) {
      return "Nenhuma trava legal vigente.";
    }
    const due = hold.reviewDue ? ` (${REVIEW_DUE}: continua valendo)` : "";
    return `Vigente desde ${brasiliaDay(hold.placedAt)}, revisão em ${brasiliaDay(hold.reviewAt)}${due}.`;
  };

  const draw = (state: StoreState) => {
    const pairs: [string, Node | string][] = [];
    if (state.status !== null) {
      pairs.push(["Situação da loja", statusText(state.status)]);
    }
    pairs.push(["Trava legal", holdText(state.hold)]);
    const parts: (HTMLElement | null)[] = [caseFacts(pairs)];
    if (can("organization:purge")) {
      parts.push(purgePart(state));
    }
    if (can("organization:legal_hold") && state.status !== "purged") {
      parts.push(holdPart(state));
    }
    dom.fill(slot, wrap(...parts));
  };

  const area = (title: string, ...children: (HTMLElement | null)[]) =>
    dom.el(
      "div",
      { class: "purge-part" },
      dom.el("h4", {}, title),
      ...children
    );

  const purgePart = (state: StoreState): HTMLElement => {
    const title = "Apagamento da loja";
    if (state.status === null) {
      return area(
        title,
        line(
          "Para ver a situação da loja e agendar o apagamento, é preciso a permissão de ver a loja."
        )
      );
    }
    if (state.status === "purged") {
      const done = lastEvent(detail, ["organization.purge_completed"]);
      return area(
        title,
        line(
          done === null
            ? PURGE_DONE
            : `${PURGE_DONE} Concluído em ${brasiliaMomentText(done.at)}.`
        )
      );
    }
    if (state.status === "purge_pending") {
      return scheduledPart(title, state);
    }
    // the start the server gave belongs to that schedule only: once the store is no longer scheduled it is dropped
    hooks.memory.notBefore = null;
    if (state.status !== "closed") {
      return area(title, line(ONLY_CLOSED));
    }
    return closedPart(title, state);
  };

  const scheduledPart = (title: string, state: StoreState): HTMLElement => {
    const scheduled = lastEvent(detail, ["organization.purge_scheduled"]);
    const from =
      hooks.memory.notBefore === null
        ? NEXT_PURGE_CYCLE
        : `a partir de ${brasiliaMomentText(hooks.memory.notBefore)}`;
    const cancel = dom.el(
      "button",
      { class: "secondary", type: "button" },
      "Cancelar o agendamento"
    );
    cancel.addEventListener("click", () => {
      if (!sending) {
        cancelForm();
      }
    });
    return area(
      title,
      line(
        scheduled === null
          ? "O apagamento desta loja está agendado."
          : `O apagamento desta loja foi agendado em ${brasiliaMomentText(scheduled.at)}.`,
        "warning"
      ),
      state.hold === null || state.hold === undefined
        ? line(`Os dados serão apagados ${from}.`)
        : line(HELD_WHILE_SCHEDULED, "warning"),
      line(CANCEL_RULE),
      dom.el("div", { class: "button-row" }, cancel)
    );
  };

  const closedPart = (title: string, state: StoreState): HTMLElement => {
    const caseProblem = purgeCaseProblem(detail);
    if (caseProblem !== null) {
      return area(
        title,
        dom.el(
          "p",
          {},
          `${CASE_REQUIRED} `,
          dom.el("a", { href: "/privacidade" }, "Ir para Pedidos de dados")
        ),
        line(caseProblem)
      );
    }
    const last = lastEvent(detail, [
      "organization.purge_scheduled",
      "organization.purge_cancelled",
    ]);
    const cancelled =
      last?.eventType === "organization.purge_cancelled"
        ? line(
            `O agendamento anterior foi cancelado em ${brasiliaMomentText(last.at)}. A loja não será apagada enquanto não houver outro.`
          )
        : null;
    if (holdStatedInPurge(state)) {
      return area(title, cancelled, line(HOLD_STOPS_PURGE, "warning"));
    }
    const schedule = dom.el(
      "button",
      { type: "button" },
      "Agendar o apagamento"
    );
    schedule.addEventListener("click", () => {
      if (!sending) {
        scheduleReview();
      }
    });
    return area(
      title,
      cancelled,
      line(SERVER_CHECKS),
      can("organization:legal_hold") ? null : line(HOLD_STOPS_PURGE),
      dom.el("div", { class: "button-row" }, schedule)
    );
  };

  const holdPart = (state: StoreState): HTMLElement => {
    const title = "Trava legal";
    const { hold } = state;
    const put = dom.el(
      "button",
      { class: "secondary", type: "button" },
      hold ? "Mudar a data de revisão" : "Pôr trava legal"
    );
    put.addEventListener("click", () => {
      if (!sending) {
        holdForm(Boolean(hold));
      }
    });
    const row = dom.el("div", { class: "button-row" }, put);
    if (hold) {
      const release = dom.el(
        "button",
        { class: "secondary", type: "button" },
        "Liberar trava legal"
      );
      release.addEventListener("click", () => {
        if (!sending) {
          releaseReview();
        }
      });
      row.append(release);
    }
    return area(
      title,
      holdStatedInPurge(state) ? null : line(HOLD_STOPS_PURGE),
      row
    );
  };

  const buttonsOf = (confirmText: string, submit = false): Buttons => ({
    back: dom.el("button", { class: "secondary", type: "button" }, "Voltar"),
    confirm: dom.el(
      "button",
      { type: submit ? "submit" : "button" },
      confirmText
    ),
    reload: dom.el(
      "button",
      { class: "secondary", hidden: "", type: "button" },
      "Reler o atendimento"
    ),
  });

  const heading = (text: string) =>
    dom.el("h4", { id: "purge-revisao", tabindex: "-1" }, text);

  const goBack = () => {
    hooks.reread();
  };

  const scheduleReview = () => {
    const notice = createNotice(dom);
    const name = item.organizationName;
    const tail = item.organizationId.slice(-6);
    const buttons = buttonsOf(
      `Agendar o apagamento da ${labelName(name)} (…${tail})`,
      true
    );
    const hint = dom.el(
      "p",
      { class: "hint", id: "purge-nome-dica" },
      TYPE_THE_NAME
    );
    const typed = dom.el("input", {
      "aria-describedby": "purge-nome-dica",
      autocomplete: "off",
      id: "purge-nome",
      name: "purge-nome",
      spellcheck: "false",
      type: "text",
    });
    buttons.confirm.setAttribute("aria-disabled", "true");
    buttons.confirm.setAttribute("aria-describedby", "purge-nome-dica");
    const matches = () => sameStoreName(typed.value, name);
    typed.addEventListener("input", () => {
      if (!sending) {
        buttons.confirm.setAttribute(
          "aria-disabled",
          matches() ? "false" : "true"
        );
        hint.textContent = matches() ? "O nome confere." : TYPE_THE_NAME;
      }
    });
    const form = dom.el(
      "form",
      { class: "step-form", novalidate: "" },
      dom.el(
        "label",
        { for: "purge-nome" },
        "Para confirmar, digite o nome da loja: ",
        dom.el("bdi", {}, labelName(name))
      ),
      typed,
      hint,
      dom.el(
        "div",
        { class: "button-row" },
        buttons.confirm,
        buttons.back,
        buttons.reload
      )
    );
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (sending) {
        return;
      }
      if (!matches()) {
        hint.textContent = TYPE_THE_NAME;
        typed.focus();
        return;
      }
      run(buttons, notice, {
        body: { organizationId: item.organizationId },
        doing: "Agendando o apagamento…",
        done: (answer: PurgeScheduled) => {
          if (answer.status === "purged") {
            return PURGE_DONE;
          }
          if (!answer.changed) {
            return "O apagamento já estava agendado. Nada foi mudado.";
          }
          hooks.memory.notBefore = answer.notBefore ?? null;
          const from =
            answer.notBefore === undefined
              ? NEXT_PURGE_CYCLE
              : `a partir de ${brasiliaMomentText(answer.notBefore)}`;
          return `Apagamento agendado. Os dados serão apagados ${from}.`;
        },
        isAnswer: isPurgeAnswer,
        path: `/api/support-cases/${encodeURIComponent(item.id)}/purge`,
      });
    });
    buttons.back.addEventListener("click", () => {
      if (!sending) {
        goBack();
      }
    });
    buttons.reload.addEventListener("click", goBack);
    const title = heading("Revise antes de agendar o apagamento");
    dom.fill(
      slot,
      wrap(
        title,
        caseFacts([
          [
            "Decisão do atendimento",
            "Exclusão aceita, pedida pelo dono da loja",
          ],
          ["Quando", PURGE_NOT_NOW],
          ["O que é apagado", purgeErasedText(NEXT_PURGE_CYCLE)],
          ["O que fica", PURGE_KEPT],
          ["Dá para desfazer", PURGE_UNDO],
          ["Fica no registro", PURGE_RECORD],
        ]),
        form,
        notice.element
      )
    );
    title.focus();
  };

  const cancelForm = () => {
    const notice = createNotice(dom);
    const reason = textField(
      dom,
      "purge-cancelar-motivo",
      "Motivo do cancelamento",
      MAX_NOTE_LENGTH,
      `Obrigatório. Fica guardado com o cancelamento. ${NO_PERSONAL_DATA}`
    );
    const next = dom.el("button", { type: "submit" }, "Revisar o cancelamento");
    const back = dom.el(
      "button",
      { class: "secondary", type: "button" },
      "Voltar"
    );
    const form = dom.el(
      "form",
      { class: "step-form", novalidate: "" },
      line(CANCEL_RULE),
      reason.element,
      dom.el("div", { class: "button-row" }, next, back)
    );
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const text = reason.control.value.trim();
      const refused =
        text === ""
          ? `Escreva o motivo do cancelamento (de 1 a ${MAX_NOTE_LENGTH} caracteres).`
          : noteProblem(text, "O motivo");
      if (refused !== null) {
        reason.refuse(refused);
        return;
      }
      cancelReview(text);
    });
    back.addEventListener("click", goBack);
    dom.fill(
      slot,
      wrap(heading("Cancelar o agendamento"), caseFacts(), form, notice.element)
    );
    reason.control.focus();
  };

  const cancelReview = (reason: string) => {
    reviewThen(
      "Revise antes de cancelar o agendamento",
      [
        ["Motivo", reason],
        ["Atenção", NO_PERSONAL_DATA],
        ["O que acontece", CANCEL_EFFECT],
        ["Dá para desfazer", CANCEL_UNDO],
        ["Fica no registro", CANCEL_RECORD],
      ],
      "Confirmar o cancelamento do agendamento",
      {
        body: { organizationId: item.organizationId, reason },
        doing: "Cancelando o agendamento…",
        done: (answer: PurgeCancelled) =>
          answer.changed
            ? "Agendamento cancelado. A loja encerrada não será apagada neste ciclo."
            : "Não havia agendamento a cancelar. Nada foi mudado.",
        isAnswer: isPurgeAnswer,
        path: `/api/support-cases/${encodeURIComponent(item.id)}/purge/cancel`,
      }
    );
  };

  const holdForm = (renewing: boolean) => {
    const notice = createNotice(dom);
    const day = plainField(
      dom,
      "purge-trava-data",
      "Data de revisão",
      "date",
      HOLD_RULE
    );
    day.control.setAttribute("max", lastHoldReviewDay(new Date()));
    const next = dom.el(
      "button",
      { type: "submit" },
      renewing ? "Revisar a nova data" : "Revisar a trava legal"
    );
    const back = dom.el(
      "button",
      { class: "secondary", type: "button" },
      "Voltar"
    );
    const form = dom.el(
      "form",
      { class: "step-form", novalidate: "" },
      day.element,
      dom.el("div", { class: "button-row" }, next, back)
    );
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const value = day.control.value.trim();
      const shown = typedDay(value);
      if (shown === null) {
        day.refuse("Escolha a data de revisão.");
        return;
      }
      const reviewAt = holdReviewAt(value, new Date());
      if (reviewAt === null) {
        day.refuse(purgeRefusalText("invalid_review_at"));
        return;
      }
      holdReview(reviewAt, shown, renewing);
    });
    back.addEventListener("click", goBack);
    dom.fill(
      slot,
      wrap(
        heading(renewing ? "Mudar a data de revisão" : "Pôr trava legal"),
        caseFacts(),
        form,
        notice.element
      )
    );
    day.control.focus();
  };

  const holdReview = (reviewAt: string, shown: string, renewing: boolean) => {
    const effect = renewing
      ? `${holdEffectText(shown)} Uma data igual ou mais cedo que a atual não muda nada.`
      : holdEffectText(shown);
    reviewThen(
      renewing
        ? "Revise antes de mudar a data de revisão"
        : "Revise antes de pôr a trava legal",
      [
        ["Data de revisão", shown],
        ["O que acontece", effect],
        ["Dá para desfazer", HOLD_UNDO],
        ["Fica no registro", HOLD_RECORD],
      ],
      renewing ? "Confirmar a nova data de revisão" : "Confirmar a trava legal",
      {
        body: { organizationId: item.organizationId, reviewAt },
        doing: "Registrando a trava legal…",
        done: holdDone,
        isAnswer: isHoldAnswer,
        path: `/api/support-cases/${encodeURIComponent(item.id)}/legal-hold`,
      }
    );
  };

  const releaseReview = () => {
    reviewThen(
      "Revise antes de liberar a trava legal",
      [
        ["O que acontece", RELEASE_EFFECT],
        ["Dá para desfazer", RELEASE_UNDO],
        ["Fica no registro", RELEASE_RECORD],
      ],
      "Liberar trava legal",
      {
        body: { organizationId: item.organizationId },
        doing: "Liberando a trava legal…",
        done: (answer: LegalHoldAnswer) =>
          answer.changed
            ? "Trava legal liberada."
            : "Não havia trava legal vigente. Nada foi mudado.",
        isAnswer: isHoldAnswer,
        path: `/api/support-cases/${encodeURIComponent(item.id)}/legal-hold/release`,
      }
    );
  };

  const reviewThen = <T>(
    title: string,
    pairs: [string, Node | string][],
    confirmText: string,
    command: Command<T>
  ) => {
    const notice = createNotice(dom);
    const buttons = buttonsOf(confirmText);
    buttons.back.addEventListener("click", () => {
      if (!sending) {
        goBack();
      }
    });
    buttons.reload.addEventListener("click", goBack);
    buttons.confirm.addEventListener("click", () => {
      if (!sending) {
        run(buttons, notice, command);
      }
    });
    const top = heading(title);
    dom.fill(
      slot,
      wrap(
        top,
        caseFacts(pairs),
        dom.el(
          "div",
          { class: "button-row" },
          buttons.confirm,
          buttons.back,
          buttons.reload
        ),
        notice.element
      )
    );
    top.focus();
  };

  const onlyReload = (buttons: Buttons) => {
    sending = true;
    buttons.confirm.setAttribute("hidden", "");
    buttons.back.setAttribute("hidden", "");
    buttons.reload.removeAttribute("hidden");
  };

  const run = async <T>(
    buttons: Buttons,
    notice: Notice,
    command: Command<T>
  ) => {
    sending = true;
    buttons.confirm.setAttribute("aria-disabled", "true");
    buttons.back.setAttribute("aria-disabled", "true");
    notice.status(command.doing);
    const outcome: StoreCommandOutcome<T> = await sendStoreCommand(
      api,
      command.path,
      command.body,
      command.isAnswer,
      (code) => Object.hasOwn(PURGE_REFUSALS, code)
    );
    if (outcome.kind === "done") {
      await finish(
        { kind: "success", text: command.done(outcome.answer) },
        buttons,
        notice
      );
      return;
    }
    if (outcome.kind === "refused") {
      await finish(
        { kind: "alert", text: purgeRefusalText(outcome.code) },
        buttons,
        notice
      );
      return;
    }
    const { problem } = outcome;
    if (
      problem === "network" ||
      problem === "failed" ||
      problem === "unavailable"
    ) {
      onlyReload(buttons);
      notice.alert(COMMAND_UNKNOWN);
      return;
    }
    if (problem === "session" || problem === "rate_limited") {
      sending = false;
      buttons.confirm.setAttribute("aria-disabled", "false");
      buttons.back.setAttribute("aria-disabled", "false");
      notice.alert(problemText(problem));
      return;
    }
    await finish(
      { kind: "alert", text: problemText(problem) },
      buttons,
      notice
    );
  };

  const finish = async (
    outcome: { kind: "alert" | "success"; text: string },
    buttons: Buttons,
    notice: Notice
  ) => {
    if (await hooks.reread(outcome)) {
      return;
    }
    onlyReload(buttons);
    notice.status(
      `${outcome.text} Não deu para mostrar o atendimento de novo: use Reler o atendimento.`
    );
  };

  if (item.status === "open") {
    dom.fill(
      slot,
      wrap(
        dom.el(
          "p",
          { class: "hint", role: "status" },
          "Lendo a situação da loja…"
        )
      )
    );
    read();
  } else {
    dom.fill(
      slot,
      wrap(
        line(
          "Este atendimento está fechado: purge e trava legal precisam de um atendimento de privacidade aberto desta loja."
        ),
        dom.el("a", { href: "/privacidade" }, "Ir para Pedidos de dados")
      )
    );
  }
  return slot;
}

interface Command<T> {
  body: Readonly<Record<string, string>>;
  doing: string;
  done: (answer: T) => string;
  isAnswer: (value: unknown) => value is T;
  path: string;
}

function holdDone(answer: LegalHoldAnswer): string {
  if (!answer.changed) {
    return "Nada mudou: a trava já estava vigente com uma data de revisão igual ou mais tarde.";
  }
  const said = answer.renewed
    ? "Data de revisão da trava legal mudada."
    : "Trava legal posta.";
  return answer.storageTouched
    ? `${said} O apagamento agendado já tinha apagado arquivos do armazenamento: eles não voltam.`
    : said;
}
