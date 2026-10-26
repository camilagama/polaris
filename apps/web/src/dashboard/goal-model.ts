import type { GoalReadModel } from "@polaris/contracts";
import { EARLIEST_EXPENSE_COMPETENCE } from "@polaris/domain/expenses/expense";
import {
  isGoalKind,
  MAX_GOAL_NAME_LENGTH,
  MAX_GOAL_PERIOD_DAYS,
  MAX_SALE_COUNT_TARGET,
} from "@polaris/domain/goals/goal";
import {
  type MoneyInputError,
  moneyInputText,
  monthBounds,
  parseMoneyInput,
} from "../expenses/expense-model";
import { calendarDayInTimezone, isCalendarDate } from "../lib/dates";
import {
  formatBrlAmount,
  formatCalendarDate,
  formatQuantity,
} from "../lib/format";

/**
 * Pure helpers of the goals panel: labels, how a goal value reads, the width of
 * the progress bar and the checks of what a person types. Money stays exact
 * decimal text; the progress percent is the server's text, only read here.
 */

export type GoalKind = GoalReadModel["kind"];
export type GoalStatus = GoalReadModel["status"];

interface GoalKindOption {
  /** One plain sentence on what the goal measures. */
  hint: string;
  key: GoalKind;
  label: string;
}

/** The three measures, in the order the form offers them. */
export const GOAL_KIND_OPTIONS: readonly GoalKindOption[] = [
  {
    hint: "Soma das vendas confirmadas menos descontos e devoluções, como no cartão “Vendas líquidas”.",
    key: "net_sales",
    label: "Vendas líquidas",
  },
  {
    hint: "Estimativa, como no cartão “Resultado estimado”: não é lucro líquido nem dinheiro já recebido.",
    key: "operating_result",
    label: "Resultado operacional estimado",
  },
  {
    hint: "Quantidade de vendas confirmadas no período, como no cartão “Vendas”.",
    key: "sale_count",
    label: "Número de vendas",
  },
];

export function goalKindLabel(kind: GoalKind): string {
  return GOAL_KIND_OPTIONS.find((option) => option.key === kind)?.label ?? kind;
}

export function goalKindHint(kind: GoalKind): string {
  return GOAL_KIND_OPTIONS.find((option) => option.key === kind)?.hint ?? "";
}

const statusLabels: Record<GoalStatus, string> = {
  active: "Em andamento",
  cancelled: "Cancelada",
  completed: "Concluída",
  missed: "Não atingida",
};

export function goalStatusLabel(status: GoalStatus): string {
  return statusLabels[status];
}

/** The badge for a status (a paused goal warns); the text always carries the meaning. */
export function goalBadgeVariant(
  status: GoalStatus,
  paused: boolean
): "ink" | "outline" | "secondary" | "warning" {
  if (paused) {
    return "warning";
  }
  if (status === "active") {
    return "secondary";
  }
  return status === "completed" ? "ink" : "outline";
}

/** What the goal is called on screen: its own name, or what it measures. */
export function goalTitle(goal: Pick<GoalReadModel, "kind" | "name">): string {
  return goal.name ?? goalKindLabel(goal.kind);
}

/** A target or a measured value: BRL for money goals, a whole number for a count. */
export function formatGoalValue(kind: GoalKind, value: string): string {
  if (kind === "sale_count") {
    const count = Number(value);
    return Number.isSafeInteger(count) ? formatQuantity(count) : value;
  }
  return formatBrlAmount(value);
}

const percentTextPattern = /^(-?)(\d+)(?:\.(\d))?\d*$/;
const FULL_BAR_TENTHS = 1000;

/**
 * Width of the progress bar, 0 to 100, from the server's percent text ("37.5").
 * No percent (nothing positive yet) or a negative one is an empty bar; more
 * than the target is a full bar. Read as tenths of a percent, never as money.
 */
export function goalProgressWidth(percent: string | null): number {
  if (percent === null) {
    return 0;
  }
  const match = percentTextPattern.exec(percent.trim());
  if (!match || match[1] === "-") {
    return 0;
  }
  const tenths = Number(match[2]) * 10 + Number(match[3] ?? "0");
  return Math.min(tenths, FULL_BAR_TENTHS) / 10;
}

/** "37,5%" for "37.5"; a progress that is not positive reads "0%". */
export function formatGoalPercent(percent: string | null): string {
  if (percent === null) {
    return "0%";
  }
  const text = percent.trim();
  if (!percentTextPattern.test(text) || text.startsWith("-")) {
    return "0%";
  }
  return `${text.replace(".", ",")}%`;
}

/** "01/10/2026 a 31/10/2026" */
export function goalPeriodText(
  goal: Pick<GoalReadModel, "endsOn" | "startsOn">
): string {
  return `${formatCalendarDate(goal.startsOn)} a ${formatCalendarDate(goal.endsOn)}`;
}

/** True when the period has not begun on the organization's today. */
export function goalNotStarted(
  goal: Pick<GoalReadModel, "startsOn">,
  today: string
): boolean {
  return goal.startsOn > today;
}

/** dd/mm/aaaa of an instant, on the calendar of the organization's time zone. */
export function formatGoalDate(
  instant: string,
  timezone: string | null
): string {
  const date = new Date(instant);
  if (Number.isNaN(date.getTime())) {
    return instant;
  }
  return formatCalendarDate(calendarDayInTimezone(date, timezone));
}

/** The date a goal turned final: when it settled, or, for a cancelled one, when it was cancelled. */
export function goalFinalDate(
  goal: Pick<GoalReadModel, "settledAt" | "updatedAt">,
  timezone: string | null
): string {
  return formatGoalDate(goal.settledAt ?? goal.updatedAt, timezone);
}

export interface GoalGroups {
  active: GoalReadModel[];
  settled: GoalReadModel[];
}

function byEndThenStart(a: GoalReadModel, b: GoalReadModel): number {
  return (
    a.endsOn.localeCompare(b.endsOn) ||
    a.startsOn.localeCompare(b.startsOn) ||
    a.id.localeCompare(b.id)
  );
}

function finalInstant(goal: GoalReadModel): string {
  return goal.settledAt ?? goal.updatedAt;
}

/** Active goals first (the nearest end first), then the final ones (the latest first). */
export function groupGoals(goals: readonly GoalReadModel[]): GoalGroups {
  return {
    active: goals
      .filter((goal) => goal.status === "active")
      .sort(byEndThenStart),
    settled: goals
      .filter((goal) => goal.status !== "active")
      .sort(
        (a, b) =>
          finalInstant(b).localeCompare(finalInstant(a)) ||
          a.id.localeCompare(b.id)
      ),
  };
}

// --------------------------------------------------------------------- target

type TargetResult = { ok: true; value: string } | { error: string; ok: false };

const wholeNumberPattern = /^\d{1,9}$/;

const moneyMessages: Record<MoneyInputError, string> = {
  empty: "Informe o alvo da meta.",
  invalid: "Use apenas números, por exemplo 1500, 1.500,50 ou 1500,5.",
  negative: "O alvo não pode ser negativo.",
  not_positive: "O alvo precisa ser maior que zero.",
  too_large: "O alvo é grande demais.",
  too_many_decimals: "Use no máximo duas casas decimais.",
};

function countTarget(text: string): TargetResult {
  const trimmed = text.trim();
  if (trimmed === "") {
    return { error: "Informe o alvo da meta.", ok: false };
  }
  if (!wholeNumberPattern.test(trimmed)) {
    return { error: "Use só números inteiros, por exemplo 50.", ok: false };
  }
  const count = Number(trimmed);
  if (count < 1) {
    return { error: "O alvo precisa ser maior que zero.", ok: false };
  }
  if (count > MAX_SALE_COUNT_TARGET) {
    return {
      error: `O alvo é de no máximo ${formatQuantity(MAX_SALE_COUNT_TARGET)} vendas.`,
      ok: false,
    };
  }
  return { ok: true, value: String(count) };
}

/**
 * What a person typed as a target, as the text the API takes: "1500.50" for the
 * money goals (it reads "1.500,50" too), a whole number for the count.
 */
export function parseGoalTarget(kind: GoalKind, text: string): TargetResult {
  if (kind === "sale_count") {
    return countTarget(text);
  }
  const money = parseMoneyInput(text);
  return money.ok
    ? { ok: true, value: money.value }
    : { error: moneyMessages[money.error], ok: false };
}

/** A goal's target as a person types it, to fill the field when editing. */
export function goalTargetInputText(
  goal: Pick<GoalReadModel, "kind" | "target">
): string {
  return goal.kind === "sale_count" ? goal.target : moneyInputText(goal.target);
}

// ---------------------------------------------------------------------- draft

export interface GoalDraft {
  endsOn: string;
  kind: GoalKind;
  name: string;
  startsOn: string;
  target: string;
}

export type GoalDraftField = keyof GoalDraft;
export type GoalDraftErrors = Partial<
  Record<GoalDraftField, string | undefined>
>;

/** What the API takes to create a goal. */
export interface GoalCreateInput {
  endsOn: string;
  kind: GoalKind;
  name: string | null;
  startsOn: string;
  target: string;
}

/** What the API takes to change an active goal. */
export interface GoalEditInput {
  name: string | null;
  target: string;
}

/** Fields in the order they appear on the form, to focus the first wrong one. */
export const GOAL_DRAFT_FIELDS: readonly GoalDraftField[] = [
  "kind",
  "name",
  "startsOn",
  "endsOn",
  "target",
];

/** The month on screen as the goal's period: its first to its last day. */
export function defaultGoalPeriod(month: string): {
  endsOn: string;
  startsOn: string;
} {
  const bounds = monthBounds(month);
  return bounds
    ? { endsOn: bounds.to, startsOn: bounds.from }
    : { endsOn: "", startsOn: "" };
}

export function newGoalDraft(month: string): GoalDraft {
  return {
    ...defaultGoalPeriod(month),
    kind: "net_sales",
    name: "",
    target: "",
  };
}

function nameError(name: string): string | null {
  return [...name.trim()].length > MAX_GOAL_NAME_LENGTH
    ? `Use no máximo ${MAX_GOAL_NAME_LENGTH} caracteres.`
    : null;
}

function inclusiveDays(from: string, to: string): number {
  return (
    Math.round(
      (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
        86_400_000
    ) + 1
  );
}

function startError(startsOn: string): string | null {
  if (!isCalendarDate(startsOn)) {
    return "Informe uma data de início válida.";
  }
  return startsOn < EARLIEST_EXPENSE_COMPETENCE
    ? "O início não pode ser anterior a 2000."
    : null;
}

function endError(startsOn: string, endsOn: string): string | null {
  if (!isCalendarDate(endsOn)) {
    return "Informe uma data de término válida.";
  }
  if (!isCalendarDate(startsOn)) {
    return null;
  }
  if (endsOn < startsOn) {
    return "O término não pode ser antes do início.";
  }
  return inclusiveDays(startsOn, endsOn) > MAX_GOAL_PERIOD_DAYS
    ? `O período não pode passar de ${MAX_GOAL_PERIOD_DAYS} dias.`
    : null;
}

/**
 * Checks a new goal the way the server will, so mistakes show next to the field
 * before anything is sent. `input` is set only when nothing is wrong.
 */
export function validateGoalDraft(draft: GoalDraft): {
  errors: GoalDraftErrors;
  input: GoalCreateInput | null;
} {
  const errors: GoalDraftErrors = {};
  if (!isGoalKind(draft.kind)) {
    errors.kind = "Escolha o que a meta mede.";
  }
  const name = nameError(draft.name);
  if (name) {
    errors.name = name;
  }
  if (draft.startsOn === "" && draft.endsOn === "") {
    // the two ends are one control on the form ("Período da meta"): an empty one is named as such
    errors.startsOn = "Escolha o período da meta.";
  } else {
    const start = startError(draft.startsOn);
    if (start) {
      errors.startsOn = start;
    }
    const end = endError(draft.startsOn, draft.endsOn);
    if (end) {
      errors.endsOn = end;
    }
  }
  const target = parseGoalTarget(draft.kind, draft.target);
  if (!target.ok) {
    errors.target = target.error;
  }
  if (!target.ok || Object.keys(errors).length > 0) {
    return { errors, input: null };
  }
  const trimmed = draft.name.trim();
  return {
    errors,
    input: {
      endsOn: draft.endsOn,
      kind: draft.kind,
      name: trimmed === "" ? null : trimmed,
      startsOn: draft.startsOn,
      target: target.value,
    },
  };
}

export type GoalEditDraft = Pick<GoalDraft, "name" | "target">;
export type GoalEditErrors = Partial<
  Record<keyof GoalEditDraft, string | undefined>
>;

/** Checks the name and the target of an active goal being edited. */
export function validateGoalEdit(
  kind: GoalKind,
  draft: GoalEditDraft
): { errors: GoalEditErrors; input: GoalEditInput | null } {
  const errors: GoalEditErrors = {};
  const name = nameError(draft.name);
  if (name) {
    errors.name = name;
  }
  const target = parseGoalTarget(kind, draft.target);
  if (!target.ok) {
    errors.target = target.error;
  }
  if (!target.ok || Object.keys(errors).length > 0) {
    return { errors, input: null };
  }
  const trimmed = draft.name.trim();
  return {
    errors,
    input: { name: trimmed === "" ? null : trimmed, target: target.value },
  };
}

/**
 * `/dashboard?meta=…`, the two links of the Início (AC-11): `nova` opens the form of a new goal, `lista` takes the
 * person to the goals. Anything else, or none, is the screen as it is; the value is never shown.
 */
export function readGoalsLink(search: string): "list" | "new" | null {
  switch (new URLSearchParams(search).get("meta")) {
    case "nova":
      return "new";
    case "lista":
      return "list";
    default:
      return null;
  }
}
