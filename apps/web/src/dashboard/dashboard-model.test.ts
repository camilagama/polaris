import { describe, expect, it } from "vitest";
import { monthBounds, shiftMonth } from "../expenses/expense-model";
import {
  chainRows,
  EMPTY_VALUE,
  formatMoneyOrDash,
  formatPercentOrDash,
  formatUpdatedUntil,
  isIncompleteEstimate,
  offlineCopyNotice,
  type PeriodChain,
  type PeriodQuality,
  qualityMessages,
  qualityView,
} from "./dashboard-model";

const completeQuality: PeriodQuality = {
  anticipationFeesUnknown: 0,
  itemLines: 4,
  itemLinesWithUnknownCost: 0,
  level: "complete",
  linkedExpenses: 1,
  missing: [],
  operatingExpenses: 2,
  processingFeesUnknown: 0,
  salesCount: 3,
};

const chain: PeriodChain = {
  anticipationFees: "0.00",
  cogs: "60.00",
  commercialSurcharges: "5.00",
  contributionMargin: "68.50",
  discounts: "10.00",
  estimatedOperatingResult: "-12.30",
  grossProfit: "70.00",
  grossSales: "150.00",
  linkedExpenses: "2.00",
  netSales: "130.00",
  operatingExpenses: "80.80",
  processingFees: "4.50",
  returns: "10.00",
};

describe("a month and its days", () => {
  it("gives the first and last day of the month the report reads", () => {
    expect(monthBounds("2026-10")).toEqual({
      from: "2026-10-01",
      to: "2026-10-31",
    });
    expect(monthBounds("2028-02")).toEqual({
      from: "2028-02-01",
      to: "2028-02-29",
    });
  });

  it("moves between months across the year", () => {
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
  });
});

describe("formatMoneyOrDash", () => {
  it("formats exact BRL texts, negatives included", () => {
    expect(formatMoneyOrDash("1234.50")).toBe("R$ 1.234,50");
    expect(formatMoneyOrDash("-12.30")).toBe("-R$ 12,30");
    expect(formatMoneyOrDash("0.00")).toBe("R$ 0,00");
  });

  it("shows a dash where there is no value", () => {
    expect(formatMoneyOrDash(null)).toBe(EMPTY_VALUE);
  });
});

describe("formatPercentOrDash", () => {
  it("formats a percent with a decimal comma", () => {
    expect(formatPercentOrDash("72.50")).toBe("72,50%");
    expect(formatPercentOrDash("100.00")).toBe("100,00%");
    expect(formatPercentOrDash("-3.20")).toBe("-3,20%");
    expect(formatPercentOrDash("5")).toBe("5,00%");
    expect(formatPercentOrDash("1234.50")).toBe("1.234,50%");
  });

  it("shows a dash for no value and keeps text that is not a number", () => {
    expect(formatPercentOrDash(null)).toBe(EMPTY_VALUE);
    expect(formatPercentOrDash("n/a")).toBe("n/a");
  });
});

describe("formatUpdatedUntil", () => {
  it("says the date and time the server read the figures, in the organization's zone", () => {
    const readAt = "2026-10-14T15:30:00.000Z";
    expect(formatUpdatedUntil(readAt, "UTC")).toBe(
      "Atualizado até 14/10/2026 15:30"
    );
    expect(formatUpdatedUntil(readAt, "America/Sao_Paulo")).toBe(
      "Atualizado até 14/10/2026 12:30"
    );
    // the organization's calendar day, not the UTC one
    expect(
      formatUpdatedUntil("2026-10-14T02:05:00.000Z", "America/Sao_Paulo")
    ).toBe("Atualizado até 13/10/2026 23:05");
  });

  it("does not fail on a time it cannot read", () => {
    expect(formatUpdatedUntil("not a time", "UTC")).toBe(
      `Atualizado até ${EMPTY_VALUE} ${EMPTY_VALUE}`
    );
  });
});

describe("offlineCopyNotice", () => {
  const readAt = "2026-10-14T15:30:00.000Z";

  it("names the confirmed result it shows and what is not in it", () => {
    expect(offlineCopyNotice(readAt, "America/Sao_Paulo", 0)).toEqual({
      pending: null,
      summary:
        "Sem conexão. Mostrando o último resultado confirmado, de 14/10/2026 às 12:30. Vendas e despesas feitas depois, ou ainda não enviadas deste aparelho, não estão nestes números.",
    });
  });

  it("counts the operations kept on the device, which never enter the result", () => {
    expect(offlineCopyNotice(readAt, "UTC", 3).pending).toBe(
      "Há 3 operações guardadas neste aparelho que ainda não entram no resultado."
    );
    expect(offlineCopyNotice(readAt, "UTC", 1).pending).toBe(
      "Há 1 operação guardada neste aparelho que ainda não entra no resultado."
    );
  });
});

describe("qualityMessages", () => {
  it("names each missing input with its count, in the server's order", () => {
    expect(
      qualityMessages({
        ...completeQuality,
        anticipationFeesUnknown: 1,
        itemLinesWithUnknownCost: 3,
        level: "partial",
        missing: [
          "unknown_cost",
          "unknown_processing_fee",
          "unknown_anticipation_fee",
          "no_expenses",
        ],
        processingFeesUnknown: 2,
      })
    ).toEqual([
      "3 linhas de itens vendidos sem custo conhecido: o custo delas não entrou no CMV.",
      "2 vendas sem taxa de processamento conhecida: elas não entraram no resultado.",
      "1 venda com antecipação sem taxa conhecida: ela não entrou no resultado.",
      "Nenhuma despesa registrada neste período: o resultado pode estar acima do real.",
    ]);
  });

  it("uses the singular for one", () => {
    expect(
      qualityMessages({
        ...completeQuality,
        itemLinesWithUnknownCost: 1,
        level: "partial",
        missing: ["unknown_cost"],
      })
    ).toEqual([
      "1 linha de item vendido sem custo conhecido: o custo dela não entrou no CMV.",
    ]);
  });

  it("says there are no sales", () => {
    expect(
      qualityMessages({
        ...completeQuality,
        level: "no_data",
        missing: ["no_sales"],
        salesCount: 0,
      })
    ).toEqual(["Sem vendas neste período."]);
  });

  it("has nothing to say when nothing is missing", () => {
    expect(qualityMessages(completeQuality)).toEqual([]);
  });
});

describe("qualityView", () => {
  it("is quiet when the data is complete", () => {
    expect(qualityView(completeQuality)).toEqual({
      messages: [],
      title: "Dados completos para este período",
      tone: "complete",
    });
    expect(isIncompleteEstimate(completeQuality)).toBe(false);
  });

  it("does not hide that a complete period has expenses only", () => {
    const view = qualityView({ ...completeQuality, salesCount: 0 });
    expect(view.tone).toBe("complete");
    expect(view.messages).toEqual([
      "Sem vendas neste período: só as despesas entraram no resultado.",
    ]);
  });

  it("warns when the estimate is partial", () => {
    const partial: PeriodQuality = {
      ...completeQuality,
      level: "partial",
      missing: ["no_expenses"],
      operatingExpenses: 0,
    };
    const view = qualityView(partial);
    expect(view.tone).toBe("partial");
    expect(view.title).toBe("Estimativa incompleta");
    expect(view.messages).toHaveLength(1);
    expect(isIncompleteEstimate(partial)).toBe(true);
  });

  it("is an empty state when there is no data", () => {
    const view = qualityView({
      ...completeQuality,
      level: "no_data",
      missing: ["no_sales"],
      salesCount: 0,
    });
    expect(view.tone).toBe("empty");
    expect(view.messages).toEqual(["Sem vendas neste período."]);
  });
});

describe("chainRows", () => {
  it("follows the chain from gross sales to the estimated result", () => {
    const rows = chainRows(chain, completeQuality);
    expect(rows.map((row) => row.id)).toEqual([
      "grossSales",
      "discounts",
      "returns",
      "netSales",
      "cogs",
      "grossProfit",
      "commercialSurcharges",
      "processingFees",
      "anticipationFees",
      "linkedExpenses",
      "contributionMargin",
      "operatingExpenses",
      "estimatedOperatingResult",
    ]);
    expect(rows.map((row) => row.kind)).toEqual([
      "line",
      "line",
      "line",
      "subtotal",
      "line",
      "subtotal",
      "line",
      "line",
      "line",
      "line",
      "subtotal",
      "line",
      "result",
    ]);
  });

  it("formats each value and marks a negative result", () => {
    const rows = chainRows(chain, completeQuality);
    const result = rows.at(-1);
    expect(result).toMatchObject({
      label: "(=) Resultado operacional estimado",
      negative: true,
      value: "-R$ 12,30",
    });
    expect(rows[0]).toMatchObject({
      label: "Vendas brutas",
      negative: false,
      value: "R$ 150,00",
    });
    expect(rows.filter((row) => row.negative)).toHaveLength(1);
  });

  it("marks on their own line what was left out because it was unknown", () => {
    const rows = chainRows(chain, {
      ...completeQuality,
      anticipationFeesUnknown: 1,
      itemLinesWithUnknownCost: 2,
      level: "partial",
      processingFeesUnknown: 1,
    });
    const notes = Object.fromEntries(rows.map((row) => [row.id, row.note]));
    expect(notes.cogs).toBe("Não inclui 2 itens sem custo conhecido.");
    expect(notes.processingFees).toBe("Não inclui 1 venda sem taxa conhecida.");
    expect(notes.anticipationFees).toBe(
      "Não inclui 1 venda sem taxa conhecida."
    );
    expect(notes.operatingExpenses).toBeNull();
    expect(notes.grossSales).toBeNull();
  });

  it("notes when no expense was recorded", () => {
    const rows = chainRows(chain, { ...completeQuality, operatingExpenses: 0 });
    expect(rows.find((row) => row.id === "operatingExpenses")?.note).toBe(
      "Nenhuma despesa registrada."
    );
  });
});
