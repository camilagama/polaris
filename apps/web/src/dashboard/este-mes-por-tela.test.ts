import { describe, expect, it } from "vitest";
import { historyFields } from "../sales/sale-history-filters";
import { shortcutRange } from "../ui/date-values";
import { presetPeriod } from "./result-period";

function historyEndsToday(): boolean {
  const period = historyFields(false).find(
    (field) => field.label === "Período"
  );
  return period?.type === "date-range" && period.endsToday === true;
}

describe("Este mês: o mesmo mês de calendário em cada tela, cortado só no limite dela", () => {
  const table = [
    {
      historico: { from: "2026-11-01", to: "2026-11-09" },
      metas: { from: "2026-11-01", to: "2026-11-30" },
      resultado: { from: "2026-11-01", to: "2026-11-30" },
      today: "2026-11-09",
    },
    {
      historico: { from: "2026-02-01", to: "2026-02-28" },
      metas: { from: "2026-02-01", to: "2026-02-28" },
      resultado: { from: "2026-02-01", to: "2026-02-28" },
      today: "2026-02-28",
    },
    {
      historico: { from: "2028-02-01", to: "2028-02-10" },
      metas: { from: "2028-02-01", to: "2028-02-29" },
      resultado: { from: "2028-02-01", to: "2028-02-29" },
      today: "2028-02-10",
    },
  ] as const;

  it.each(table)("em $today", ({ historico, metas, resultado, today }) => {
    expect(historyEndsToday()).toBe(true);
    expect(presetPeriod("this-month", today, null)).toEqual(resultado);
    expect(shortcutRange("este-mes", today, false)).toEqual(metas);
    expect(shortcutRange("este-mes", today, historyEndsToday())).toEqual(
      historico
    );
  });
});
