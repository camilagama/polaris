import type { RangePreset } from "@/ui/date-values";

/**
 * The shortcuts of every period picker, in one list: the names are the same wherever a screen shows them, and a screen
 * only chooses which ones (`shortcuts` of the picker). The range each one gives is `presetRange` in `date-values.ts`.
 * A source rule (`ui-source-rules.test.ts`) fails a screen that writes one of these names on its own.
 */
export const DATE_RANGE_SHORTCUTS: readonly {
  label: string;
  value: RangePreset;
}[] = [
  { label: "Hoje", value: "hoje" },
  { label: "7 dias", value: "7-dias" },
  { label: "Este mês", value: "este-mes" },
  { label: "Mês passado", value: "mes-passado" },
  { label: "Últimos 30 dias", value: "30-dias" },
  { label: "Este ano", value: "este-ano" },
];

/** What the pickers show when a screen does not choose: the four the filters of the Histórico and of the Metas always had. */
export const DEFAULT_SHORTCUTS: readonly RangePreset[] = [
  "hoje",
  "7-dias",
  "este-mes",
  "mes-passado",
];

export function shortcutLabel(value: RangePreset): string {
  return (
    DATE_RANGE_SHORTCUTS.find((shortcut) => shortcut.value === value)?.label ??
    value
  );
}

/** The shortcuts of `values`, in the order of the list (never the order a screen wrote them in). */
export function shortcutsOf(values: readonly RangePreset[]) {
  return DATE_RANGE_SHORTCUTS.filter(({ value }) => values.includes(value));
}
