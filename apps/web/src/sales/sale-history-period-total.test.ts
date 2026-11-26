import type { SaleListEntryReadModel } from "@polaris/contracts";
import { describe, expect, it } from "vitest";
import {
  emptyHistoryFilters,
  type HistoryFilters,
  historyFooterView,
  PERIOD_TOTAL_FAILED_NOTICE,
  PERIOD_TOTAL_HELP,
  PERIOD_TOTAL_LABEL,
  PERIOD_TOTAL_OFFLINE_NOTICE,
  PERIOD_TOTAL_TOO_LONG_NOTICE,
  type PeriodTotalRead,
  periodTotalPeriod,
  SCREEN_TOTAL_LABEL,
} from "./sale-history-model";

const PERIOD: HistoryFilters = {
  ...emptyHistoryFilters,
  from: "2026-10-01",
  to: "2026-10-14",
};

const sale = (
  n: number,
  overrides: Partial<SaleListEntryReadModel> = {}
): SaleListEntryReadModel => ({
  cancelledAt: null,
  confirmedAt: "2026-10-14T12:00:01.000Z",
  customerId: null,
  customerName: null,
  hasReturns: false,
  id: `0199c2d0-0000-7000-8000-000000003${String(n).padStart(3, "0")}`,
  itemCount: 1,
  occurredAt: "2026-10-14T12:00:00.000Z",
  occurredOn: "2026-10-14",
  paymentMethod: "pix",
  status: "confirmed",
  totalDue: "100.00",
  ...overrides,
});

describe("periodTotalPeriod", () => {
  it("as duas pontas, em ordem e sem outro filtro, são o período do total", () => {
    expect(periodTotalPeriod(PERIOD)).toEqual({
      from: "2026-10-01",
      to: "2026-10-14",
    });
    expect(
      periodTotalPeriod({ ...PERIOD, from: "2026-10-14", to: "2026-10-14" })
    ).toEqual({ from: "2026-10-14", to: "2026-10-14" });
  });

  it("sem período, ou com uma ponta só, não há total do período", () => {
    expect(periodTotalPeriod(emptyHistoryFilters)).toBeNull();
    expect(periodTotalPeriod({ ...PERIOD, to: "" })).toBeNull();
    expect(periodTotalPeriod({ ...PERIOD, from: "" })).toBeNull();
  });

  it("datas trocadas não têm total do período", () => {
    expect(
      periodTotalPeriod({ ...PERIOD, from: "2026-10-14", to: "2026-10-01" })
    ).toBeNull();
  });

  it("366 dias lê, 367 não (o resumo recusa mais de um ano)", () => {
    expect(
      periodTotalPeriod({ ...PERIOD, from: "2025-10-14", to: "2026-10-14" })
    ).not.toBeNull();
    expect(
      periodTotalPeriod({ ...PERIOD, from: "2025-10-13", to: "2026-10-14" })
    ).toBeNull();
  });

  it("Situação, Cliente ou busca junto do período tiram o total do período", () => {
    expect(periodTotalPeriod({ ...PERIOD, status: "confirmed" })).toBeNull();
    expect(periodTotalPeriod({ ...PERIOD, customer: "Ana" })).toBeNull();
    expect(periodTotalPeriod({ ...PERIOD, query: "camisa" })).toBeNull();
    expect(periodTotalPeriod({ ...PERIOD, customer: "   " })).not.toBeNull();
  });
});

const SALES = [
  sale(1, { totalDue: "100.00" }),
  sale(2, { totalDue: "50.00" }),
  sale(3, { status: "cancelled", totalDue: "999.00" }),
];

const READS: PeriodTotalRead[] = [
  { status: "idle" },
  { status: "loading" },
  { netSales: "123.40", salesCount: 3, status: "ready" },
  { status: "failed" },
];

describe("historyFooterView", () => {
  const view = (
    overrides: Partial<Parameters<typeof historyFooterView>[0]> = {}
  ) =>
    historyFooterView({
      filters: PERIOD,
      hasMore: false,
      listLoading: false,
      offline: false,
      read: { status: "idle" },
      sales: SALES,
      ...overrides,
    });

  it("lido: o rótulo e o número do servidor, a contagem sem 'há mais' e sem nota das canceladas", () => {
    expect(
      view({
        hasMore: true,
        read: { netSales: "123.40", salesCount: 3, status: "ready" },
      })
    ).toEqual({
      count: "3 vendas",
      hasHelp: true,
      label: PERIOD_TOTAL_LABEL,
      notice: "",
      note: "",
      value: "R$ 123,40",
      valueLoading: false,
    });
  });

  it("uma venda é no singular, e zero vendas lê R$ 0,00", () => {
    expect(
      view({ read: { netSales: "0.00", salesCount: 1, status: "ready" } }).count
    ).toBe("1 venda");
    const zero = view({
      read: { netSales: "0.00", salesCount: 0, status: "ready" },
    });
    expect(zero.count).toBe("0 vendas");
    expect(zero.value).toBe("R$ 0,00");
  });

  it("lendo: o mesmo rótulo e (i), sem valor e com esqueleto; nunca a soma da lista", () => {
    const loading = view({ read: { status: "loading" } });
    expect(loading).toMatchObject({
      hasHelp: true,
      label: PERIOD_TOTAL_LABEL,
      notice: "",
      note: "",
      value: null,
      valueLoading: true,
    });
    expect(loading.count).toBe("");
  });

  it("lendo a lista e o total juntos, o valor segue sendo só o esqueleto", () => {
    const both = view({ listLoading: true, read: { status: "loading" } });
    expect(both.valueLoading).toBe(true);
    expect(both.value).toBeNull();
  });

  it("sem período, o 'Total na tela' de hoje, igual à soma das confirmadas", () => {
    expect(
      view({
        filters: emptyHistoryFilters,
        hasMore: true,
        read: { status: "idle" },
      })
    ).toEqual({
      count: "2 vendas · há mais",
      hasHelp: false,
      label: SCREEN_TOTAL_LABEL,
      notice: "",
      note: "1 cancelada fica fora da soma.",
      value: "R$ 150,00",
      valueLoading: false,
    });
  });

  it("a falha volta ao 'Total na tela' com a frase calma da falha", () => {
    expect(view({ read: { status: "failed" } })).toMatchObject({
      hasHelp: false,
      label: SCREEN_TOTAL_LABEL,
      notice: PERIOD_TOTAL_FAILED_NOTICE,
      note: "1 cancelada fica fora da soma.",
      value: "R$ 150,00",
    });
  });

  it("sem conexão com período, 'Total na tela' da janela do aparelho com a frase de aviso", () => {
    expect(view({ offline: true })).toMatchObject({
      label: SCREEN_TOTAL_LABEL,
      notice: PERIOD_TOTAL_OFFLINE_NOTICE,
      value: "R$ 150,00",
    });
  });

  it("sem conexão e sem período (ou com uma ponta só) não há frase de aviso", () => {
    expect(view({ filters: emptyHistoryFilters, offline: true }).notice).toBe(
      ""
    );
    expect(view({ filters: { ...PERIOD, to: "" }, offline: true }).notice).toBe(
      ""
    );
  });

  it("366 dias lê o líquido sem aviso; 367 fica em 'Total na tela' com a frase do ano", () => {
    const year = { ...PERIOD, from: "2025-10-14", to: "2026-10-14" };
    expect(view({ filters: year })).toMatchObject({ notice: "" });
    expect(view({ filters: year, read: { status: "loading" } })).toMatchObject({
      label: PERIOD_TOTAL_LABEL,
      notice: "",
    });
    const longer = { ...PERIOD, from: "2025-10-13", to: "2026-10-14" };
    expect(view({ filters: longer })).toMatchObject({
      hasHelp: false,
      label: SCREEN_TOTAL_LABEL,
      notice: PERIOD_TOTAL_TOO_LONG_NOTICE,
      valueLoading: false,
    });
    expect(PERIOD_TOTAL_TOO_LONG_NOTICE).toBe(
      "O total líquido do período vale para até 1 ano."
    );
  });

  it("a frase do ano só vale com o período sozinho, com conexão e sem a primeira página carregando", () => {
    const longer = { ...PERIOD, from: "2025-10-13", to: "2026-10-14" };
    expect(view({ filters: { ...longer, status: "confirmed" } }).notice).toBe(
      ""
    );
    expect(view({ filters: { ...longer, customer: "Ana" } }).notice).toBe("");
    expect(view({ filters: { ...longer, query: "camisa" } }).notice).toBe("");
    expect(view({ filters: { ...longer, to: "" } }).notice).toBe("");
    expect(view({ filters: longer, offline: true }).notice).toBe(
      PERIOD_TOTAL_OFFLINE_NOTICE
    );
    expect(view({ filters: longer, listLoading: true }).notice).toBe("");
  });

  it("enquanto a primeira página carrega, o total na tela é o traço de sempre", () => {
    expect(
      view({ filters: emptyHistoryFilters, listLoading: true })
    ).toMatchObject({
      count: "",
      note: "",
      notice: "",
      value: "…",
    });
  });

  it("'Total na tela' nunca fica sobre o número líquido, nem 'Vendas líquidas do período' sobre a soma das linhas, em nenhum estado", () => {
    const filtersCases: HistoryFilters[] = [
      emptyHistoryFilters,
      PERIOD,
      { ...PERIOD, status: "confirmed" },
      { ...PERIOD, to: "" },
      { ...PERIOD, from: "2025-01-01" },
    ];
    for (const filters of filtersCases) {
      for (const read of READS) {
        for (const offline of [false, true]) {
          for (const listLoading of [false, true]) {
            const result = view({ filters, listLoading, offline, read });
            const context = JSON.stringify({
              filters,
              listLoading,
              offline,
              read,
            });
            if (result.label === PERIOD_TOTAL_LABEL) {
              expect(result.hasHelp, context).toBe(true);
              expect(
                result.value === null || read.status === "ready",
                context
              ).toBe(true);
              if (read.status === "ready") {
                expect(result.value, context).toBe("R$ 123,40");
              }
              expect(result.value, context).not.toBe("R$ 150,00");
            } else {
              expect(result.label, context).toBe(SCREEN_TOTAL_LABEL);
              expect(result.hasHelp, context).toBe(false);
              expect(result.value, context).not.toBe("R$ 123,40");
            }
          }
        }
      }
    }
  });
});

describe("o texto do (i)", () => {
  it("tem duas frases, a regra do (i) do projeto", () => {
    const sentences = PERIOD_TOTAL_HELP.match(/[.!?](?=\s|$)/g) ?? [];
    expect(sentences).toHaveLength(2);
  });

  it("cabe nos 160 caracteres (PERIOD_TOTAL_HELP)", () => {
    expect(PERIOD_TOTAL_HELP.length).toBeLessThanOrEqual(160);
  });
});
