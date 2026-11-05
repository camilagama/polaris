import { PROBLEM_TEXT, type Problem } from "../api";
import type { ScreenTools } from "../app";
import { table } from "../blocks";
import { hasControlCharacter, labelName } from "../dom";
import {
  accessEventText,
  brasiliaSecondsText,
  minutesText,
  utcSecondsText,
} from "../format";
import { createNotice } from "../notice";
import type { AccessLogEntry, AccessLogPage } from "../types";

export const NO_ACCESS =
  "Nenhum acesso encontrado nessa janela. O registro pode ter lacunas: isto não prova que não houve acesso.";
export const NO_MORE_ACCESS = "Não há mais acessos nessa janela.";
export const REGISTERED_TEXT =
  "Esta consulta fica registrada na auditoria, com o número do processo.";
export const WINDOW_TEXT = "O período pode ter no máximo 31 dias.";
export const CASE_FORMAT = "0000000-00.0000.0.00.0000";

const MAX_DAYS = 31;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Brasília has been UTC-3 all year since 2019, and the log keeps 6 months: the day starts 3 hours into the UTC day. */
const BRASILIA_OFFSET_MS = 3 * 60 * 60 * 1000;
const MIN_YEAR = 2000;
const MAX_YEAR = 2200;
const CASE_LENGTH = CASE_FORMAT.length;
const USER_LENGTH = 64;
const IP_LENGTH = 45;
const DAY_TEXT = /^(\d{4})-(\d{2})-(\d{2})$/;

const HEADERS = [
  "Brasília",
  "UTC",
  "Evento",
  "IP",
  "Usuário",
  "Requisição",
] as const;

type FilterKind = "ip" | "user";

const FILTERS: Readonly<
  Record<FilterKind, { hint: string; label: string; length: number }>
> = {
  ip: {
    hint: "O endereço IP exato, inteiro e sem máscara.",
    label: "Endereço IP",
    length: IP_LENGTH,
  },
  user: {
    hint: "O ID do usuário na plataforma: letras, números, - e _, até 64 caracteres. Não é o e-mail.",
    label: "Usuário",
    length: USER_LENGTH,
  },
};

const GENERIC_PROBLEM =
  "A consulta não foi aceita. Refaça a consulta; se continuar, avise a engenharia.";

const FILTER_REFUSED =
  "O valor não foi aceito. Usuário só com letras, números, - e _ (até 64); IP inteiro, sem máscara.";
const REFERENCE_REFUSED = `O número do processo não foi aceito. Confira o formato (${CASE_FORMAT}) e os dígitos.`;

const PROBLEMS: Readonly<Partial<Record<Problem, string>>> = {
  failed: PROBLEM_TEXT.failed,
  forbidden: PROBLEM_TEXT.forbidden,
  invalid: GENERIC_PROBLEM,
  network: PROBLEM_TEXT.network,
  not_found:
    "A consulta não foi encontrada no Admin. Recarregue a página; se continuar, avise a engenharia.",
  session: PROBLEM_TEXT.session,
  unavailable: PROBLEM_TEXT.unavailable,
};

function problemText(problem: Problem, retryAfterSeconds?: number): string {
  if (problem === "rate_limited") {
    return retryAfterSeconds === undefined
      ? "Muitas consultas em pouco tempo. Espere e tente de novo."
      : `Muitas consultas em pouco tempo. Tente de novo em ${minutesText(retryAfterSeconds)}.`;
  }
  return PROBLEMS[problem] ?? PROBLEM_TEXT.failed;
}

/** The UTC midnight of a calendar day written `aaaa-mm-dd`, or null when it is not a real day in the years the server takes. */
function dayStart(text: string): number | null {
  const match = DAY_TEXT.exec(text);
  if (match === null) {
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const moment = new Date(Date.UTC(year, month - 1, day));
  return moment.getUTCFullYear() === year &&
    moment.getUTCMonth() === month - 1 &&
    moment.getUTCDate() === day &&
    year >= MIN_YEAR &&
    year <= MAX_YEAR
    ? moment.getTime()
    : null;
}

type Period =
  | { from: string; to: string }
  | { field: "first" | "last"; problem: string };

/**
 * The days the operator picked, first and last included, as the two instants the route takes: the first day at 00:00
 * and the end of the last day, in Brasília. 31 calendar days fit and 32 do not.
 */
export function periodOf(first: string, last: string): Period {
  const start = dayStart(first);
  const end = dayStart(last);
  if (start === null) {
    return { field: "first", problem: "Informe o primeiro dia do período." };
  }
  if (end === null) {
    return { field: "last", problem: "Informe o último dia do período." };
  }
  if (end < start) {
    return {
      field: "last",
      problem: "O último dia não pode ser antes do primeiro.",
    };
  }
  if ((end - start) / DAY_MS + 1 > MAX_DAYS) {
    return { field: "last", problem: WINDOW_TEXT };
  }
  return {
    from: new Date(start + BRASILIA_OFFSET_MS).toISOString(),
    to: new Date(end + DAY_MS + BRASILIA_OFFSET_MS).toISOString(),
  };
}

function shown(value: unknown): string {
  return typeof value === "string" ? labelName(value, 80) : "—";
}

function isPage(data: unknown): data is AccessLogPage {
  return (
    typeof data === "object" &&
    data !== null &&
    "entries" in data &&
    Array.isArray(data.entries)
  );
}

function refusalOf(data: unknown): string | null {
  return typeof data === "object" &&
    data !== null &&
    "error" in data &&
    typeof data.error === "string"
    ? data.error
    : null;
}

/**
 * Registro de acessos (corte admin-v2, Parte 8; ADR 0092): the court's query of who accessed the platform. Nothing is
 * read when the screen opens. One click is one POST, and every field travels in its body: the case number, the user
 * or the IP and the answer live only in this page's memory, never in the URL, the title, a log or the browser's
 * storage, and the page leaves them behind when it is hidden. The server decides what is valid; the screen only
 * refuses the two things it can see (two filters, a period past 31 days).
 */
export function accessLogView(tools: ScreenTools): HTMLElement {
  const { api, dom } = tools;
  const notice = createNotice(dom);

  const field = (
    id: string,
    inputType: "date" | "text",
    length?: number,
    describedBy = id
  ) =>
    dom.el("input", {
      "aria-describedby": `${describedBy}-dica ${describedBy}-erro`,
      autocomplete: "off",
      id,
      ...(length === undefined ? {} : { maxlength: String(length) }),
      name: id,
      spellcheck: "false",
      type: inputType,
    });
  const errorLine = (id: string) =>
    dom.el("p", { "aria-live": "polite", class: "field-error", id });

  const reference = field("registro-processo", "text", CASE_LENGTH);
  const referenceError = errorLine("registro-processo-erro");
  const kind = dom.el(
    "select",
    { "aria-describedby": "registro-tipo-dica", id: "registro-tipo" },
    dom.el("option", { selected: "", value: "user" }, "Usuário"),
    dom.el("option", { value: "ip" }, "IP")
  );
  kind.value = "user";
  const filterLabel = dom.el(
    "label",
    { for: "registro-valor" },
    FILTERS.user.label
  );
  const filterHint = dom.el(
    "p",
    { class: "hint", id: "registro-valor-dica" },
    FILTERS.user.hint
  );
  const filterValue = field("registro-valor", "text", USER_LENGTH);
  const filterError = errorLine("registro-valor-erro");
  const firstDay = field("registro-inicio", "date", undefined, "registro-fim");
  const lastDay = field("registro-fim", "date", undefined, "registro-fim");
  const periodError = errorLine("registro-fim-erro");
  const submit = dom.el("button", { type: "submit" }, "Consultar");
  const more = dom.el(
    "button",
    { class: "secondary", hidden: "", type: "button" },
    "Próxima página"
  );
  const rows = dom.el("div", { class: "results" });

  const form = dom.el(
    "form",
    { class: "search access-form", novalidate: "" },
    dom.el("label", { for: "registro-processo" }, "Número do processo"),
    dom.el(
      "p",
      { class: "hint", id: "registro-processo-dica" },
      `Formato ${CASE_FORMAT}. O servidor confere os dígitos.`
    ),
    reference,
    referenceError,
    dom.el("label", { for: "registro-tipo" }, "Filtrar por"),
    dom.el(
      "p",
      { class: "hint", id: "registro-tipo-dica" },
      "Um filtro só: usuário ou IP."
    ),
    kind,
    filterLabel,
    filterHint,
    filterValue,
    filterError,
    dom.el("p", { class: "label" }, "Período"),
    dom.el(
      "div",
      { class: "period" },
      dom.el("label", { for: "registro-inicio" }, "Primeiro dia"),
      firstDay,
      dom.el("label", { for: "registro-fim" }, "Último dia"),
      lastDay
    ),
    dom.el(
      "p",
      { class: "hint", id: "registro-fim-dica" },
      "No máximo 31 dias, contando o primeiro e o último. Dias em horário de Brasília."
    ),
    periodError,
    dom.el("p", { class: "audit" }, REGISTERED_TEXT),
    dom.el("div", { class: "button-row" }, submit)
  );

  let loading = false;
  let asked: Record<string, string> | null = null;
  let next: string | null = null;
  // an answer that comes after the form changed or the page was hidden belongs to nothing on screen
  let generation = 0;

  const fieldErrors: [HTMLElement, HTMLElement][] = [
    [referenceError, reference],
    [filterError, filterValue],
    [periodError, lastDay],
    [periodError, firstDay],
  ];

  const clearFieldErrors = () => {
    for (const [line, input] of fieldErrors) {
      line.textContent = "";
      input.removeAttribute("aria-invalid");
    }
  };

  const fieldProblem = (
    line: HTMLElement,
    input: HTMLElement,
    text: string
  ) => {
    notice.clear();
    line.textContent = text;
    input.setAttribute("aria-invalid", "true");
    input.focus();
  };

  const busy = (on: boolean) => {
    loading = on;
    for (const button of [submit, more]) {
      button.setAttribute("aria-disabled", String(on));
    }
    submit.textContent = on ? "Consultando…" : "Consultar";
  };

  /** Leaves nothing of an answer on the page: the lines, the cursor and the request it belongs to. */
  const dropResults = () => {
    generation += 1;
    rows.replaceChildren();
    more.setAttribute("hidden", "");
    asked = null;
    next = null;
  };

  const entryRow = (entry: AccessLogEntry) =>
    [
      brasiliaSecondsText(String(entry.occurredAt)),
      utcSecondsText(String(entry.occurredAt)),
      accessEventText(String(entry.event)),
      dom.el("code", {}, shown(entry.ip)),
      entry.userId === null ? "—" : dom.el("code", {}, shown(entry.userId)),
      dom.el("code", {}, shown(entry.requestId)),
    ] as const;

  const showPage = (page: AccessLogPage, firstPage: boolean) => {
    const lines = page.entries.map(entryRow);
    next = typeof page.next === "string" ? page.next : null;
    if (lines.length === 0) {
      rows.replaceChildren();
      more.setAttribute("hidden", "");
      notice.success(firstPage ? NO_ACCESS : NO_MORE_ACCESS);
      return;
    }
    dom.fill(
      rows,
      table(
        dom,
        "Acessos encontrados",
        HEADERS,
        lines.map((line) => [...line])
      )
    );
    if (next === null) {
      more.setAttribute("hidden", "");
    } else {
      more.removeAttribute("hidden");
    }
    const count =
      lines.length === 1
        ? "1 acesso nesta página."
        : `${lines.length} acessos nesta página.`;
    notice.success(
      next === null ? count : `${count} Há mais: use Próxima página.`
    );
  };

  const run = async (body: Record<string, string>, after: string | null) => {
    clearFieldErrors();
    if (after === null) {
      dropResults();
    }
    busy(true);
    notice.status("Consultando…");
    const mine = generation;
    const answer = await api.post<AccessLogPage | { error: string }>(
      "/api/access-log/read",
      after === null ? body : { ...body, after },
      [400]
    );
    busy(false);
    if (mine !== generation) {
      return;
    }
    if (!answer.ok) {
      notice.alert(problemText(answer.problem, answer.retryAfterSeconds));
      return;
    }
    if (isPage(answer.data)) {
      asked = body;
      showPage(answer.data, after === null);
      return;
    }
    const refusal = refusalOf(answer.data);
    if (refusal === "invalid_reference") {
      fieldProblem(referenceError, reference, REFERENCE_REFUSED);
    } else if (refusal === "invalid_filter") {
      fieldProblem(filterError, filterValue, FILTER_REFUSED);
    } else if (refusal === "invalid_window") {
      fieldProblem(periodError, lastDay, WINDOW_TEXT);
    } else if (refusal === null) {
      notice.alert(PROBLEM_TEXT.failed);
    } else {
      notice.alert(GENERIC_PROBLEM);
    }
  };

  const bodyOfForm = (): Record<string, string> | null => {
    clearFieldErrors();
    const processo = reference.value.trim();
    if (processo === "" || hasControlCharacter(processo)) {
      fieldProblem(
        referenceError,
        reference,
        `Informe o número do processo no formato ${CASE_FORMAT}.`
      );
      return null;
    }
    const chosen: FilterKind = kind.value === "ip" ? "ip" : "user";
    const value = filterValue.value.trim();
    if (value === "" || hasControlCharacter(value)) {
      fieldProblem(
        filterError,
        filterValue,
        chosen === "ip" ? "Informe o endereço IP." : "Informe o usuário."
      );
      return null;
    }
    const period = periodOf(firstDay.value, lastDay.value);
    if ("problem" in period) {
      fieldProblem(
        periodError,
        period.field === "first" ? firstDay : lastDay,
        period.problem
      );
      return null;
    }
    return {
      from: period.from,
      [chosen]: value,
      legalReference: processo,
      to: period.to,
    };
  };

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (loading) {
      return;
    }
    const body = bodyOfForm();
    if (body !== null) {
      run(body, null);
    }
  });
  more.addEventListener("click", () => {
    if (!loading && asked !== null && next !== null) {
      run(asked, next);
    }
  });
  kind.addEventListener("change", () => {
    const chosen = FILTERS[kind.value === "ip" ? "ip" : "user"];
    filterLabel.textContent = chosen.label;
    filterHint.textContent = chosen.hint;
    filterValue.setAttribute("maxlength", String(chosen.length));
    filterValue.value = "";
    clearFieldErrors();
    dropResults();
    notice.clear();
  });
  for (const input of [reference, filterValue, firstDay, lastDay]) {
    // an answer belongs to what was typed when it was asked: a changed field takes it off the page
    input.addEventListener("input", () => {
      clearFieldErrors();
      dropResults();
      notice.clear();
    });
  }

  const discard = () => {
    clearFieldErrors();
    dropResults();
    notice.clear();
    for (const input of [reference, filterValue, firstDay, lastDay]) {
      input.value = "";
    }
  };
  // a page restored from the back-forward cache must not show the number, the IP or the lines again
  dom.document.defaultView?.addEventListener("pagehide", discard);

  return dom.el(
    "section",
    { "aria-labelledby": "registro-titulo", class: "area" },
    dom.el("h2", { id: "registro-titulo" }, "Registro de acessos"),
    dom.el(
      "p",
      { class: "hint" },
      "Consulta de acessos de usuários da plataforma para atender ordem judicial. Nada fica guardado nesta página: sair dela apaga o número do processo e o resultado."
    ),
    form,
    notice.element,
    rows,
    dom.el("div", { class: "button-row" }, more)
  );
}
