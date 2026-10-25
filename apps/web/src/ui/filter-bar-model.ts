import {
  type DateRange,
  formatRange,
  type IsoDate,
  todayOr,
  validRange,
} from "@/ui/date-values";

/**
 * What the filter bar (`filter-bar.tsx`) knows about its fields and filters, as pure functions with no React, so the
 * rules (what a filter is, what its pill says, what adding, editing and removing do) are tested without a browser. A
 * field is a text, a choice among a few options, or a range of days; there are no operators, the shopkeeper picks a
 * value, never "contains" or "between". The screen owns the list of filters (`FilterRule[]`, in the order they were
 * added) and the bar returns the next list.
 */
export interface FilterOption {
  label: string;
  value: string;
}

interface FilterFieldBase {
  /**
   * Why the field cannot be used now ("Só com conexão"). The field stays in the menu, `aria-disabled`, with this text
   * under its name; a pill of it that already exists cannot be edited, only removed.
   */
  disabledReason?: string | undefined;
  /** Stable name of the field, the key of its filter. */
  id: string;
  /** What the shopkeeper calls it: "Período", "Situação", "Cliente". */
  label: string;
}

export interface TextFilterField extends FilterFieldBase {
  placeholder?: string | undefined;
  type: "text";
}

export interface SelectFilterField extends FilterFieldBase {
  options: readonly FilterOption[];
  type: "select";
}

interface DateRangeFilterField extends FilterFieldBase {
  /** The store's day, as in the `DateRangePicker`; the device's day when absent. */
  today?: IsoDate | undefined;
  type: "date-range";
}

export type FilterField =
  | DateRangeFilterField
  | SelectFilterField
  | TextFilterField;

export type FilterRuleValue = DateRange | string;

/** One active filter: the field and its value (a string for a text or a choice, both ends for a period). */
export interface FilterRule {
  fieldId: string;
  value: FilterRuleValue;
}

/** What the pill of a field being added shows until it has a value. */
export const PENDING_TEXT = "Escolher";

/** "Limpar tudo" appears from this many pills. */
export const CLEAR_ALL_FROM = 2;

/** The text of a pill for `value`: the text typed, the label of the option, "01/10 a 24/10". Undefined when `value` does not fit the field. */
export function valueText(
  field: FilterField,
  value: FilterRuleValue
): string | undefined {
  switch (field.type) {
    case "text":
      return typeof value === "string" && value.trim() !== ""
        ? value.trim()
        : undefined;
    case "select":
      return typeof value === "string"
        ? field.options.find((option) => option.value === value)?.label
        : undefined;
    case "date-range": {
      const range = typeof value === "string" ? null : validRange(value);
      return range ? formatRange(range, todayOr(field.today)) : undefined;
    }
    default:
      return field satisfies never;
  }
}

/**
 * The filters the bar shows: those whose field exists and whose value fits it, in the order of the list, once per
 * field. Anything else (a field the screen took away, a value no option has, a bad range) is ignored, never shown
 * as a pill with a wrong text.
 */
export function visibleRules(
  fields: readonly FilterField[],
  rules: readonly FilterRule[]
): { field: FilterField; rule: FilterRule; text: string }[] {
  const seen = new Set<string>();
  const shown: { field: FilterField; rule: FilterRule; text: string }[] = [];
  for (const rule of rules) {
    const field = fields.find((candidate) => candidate.id === rule.fieldId);
    const text = field ? valueText(field, rule.value) : undefined;
    if (field && text !== undefined && !seen.has(field.id)) {
      seen.add(field.id);
      shown.push({ field, rule, text });
    }
  }
  return shown;
}

/**
 * The list after `fieldId` gets `value`: the filter is replaced where it is, or added at the end. A value that does not
 * fit the field (an empty text, a range that is not one) takes the filter out, so "empty" is never a filter.
 */
export function setRule(
  fields: readonly FilterField[],
  rules: readonly FilterRule[],
  fieldId: string,
  value: FilterRuleValue | null
): FilterRule[] {
  const field = fields.find((candidate) => candidate.id === fieldId);
  const kept = rules.filter((rule) => rule.fieldId !== fieldId);
  if (!field || value === null || valueText(field, value) === undefined) {
    return kept;
  }
  const normalized = typeof value === "string" ? value.trim() : value;
  const index = rules.findIndex((rule) => rule.fieldId === fieldId);
  const next: FilterRule = { fieldId, value: normalized };
  if (index === -1) {
    return [...kept, next];
  }
  return rules.map((rule) => (rule.fieldId === fieldId ? next : rule));
}

/** The list without the filter of `fieldId`. */
export function removeRule(
  rules: readonly FilterRule[],
  fieldId: string
): FilterRule[] {
  return rules.filter((rule) => rule.fieldId !== fieldId);
}

/** "Limpar tudo" only with two or more pills: with one, its own X is the same gesture. */
export function showClearAll(pills: number): boolean {
  return pills >= CLEAR_ALL_FROM;
}

/** The name of a pill's button: "Período: 01/10 a 24/10, editar". */
export function editLabel(field: FilterField, text: string): string {
  return `${field.label}: ${text}, editar`;
}

/** The name of the pill of a field that cannot be used now: it cannot be edited, so it does not say "editar" (the reason is its description). */
export function lockedLabel(field: FilterField, text: string): string {
  return `${field.label}: ${text}`;
}

/** The name of a pill's X: "Tirar o filtro Período". */
export function removeLabel(field: FilterField): string {
  return `Tirar o filtro ${field.label}`;
}

/** The animation of a pill, as the Araute's smart filter has it (opacity and scale in and out, the neighbours slide). */
export interface PillMotion {
  animate?: { opacity: number; scale: number; y: number };
  exit?: { opacity: number; scale: number; y: number };
  initial?: { opacity: number; scale: number; y: number };
  layout?: true;
  transition?: {
    damping: number;
    mass: number;
    stiffness: number;
    type: "spring";
  };
}

/** With `prefers-reduced-motion` nothing moves: no entry, no exit and no sliding of the neighbours. */
export function pillMotion(reduced: boolean | null): PillMotion {
  if (reduced) {
    return {};
  }
  return {
    animate: { opacity: 1, scale: 1, y: 0 },
    exit: { opacity: 0, scale: 0.95, y: -4 },
    initial: { opacity: 0, scale: 0.95, y: 4 },
    layout: true,
    transition: { damping: 24, mass: 0.5, stiffness: 300, type: "spring" },
  };
}
