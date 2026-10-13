import type {
  CustomerReadModel,
  SaleDetailReadModel,
  SaleListEntryReadModel,
} from "@polaris/contracts";
import { describe, expect, it } from "vitest";
import {
  canLoadMore,
  detailLoadErrorMessage,
  type HistoryState,
  historyCustomersFailed,
  historyCustomersLoaded,
  historyLoaded,
  historyLoadFailed,
  historyLoading,
  historyRows,
  historyView,
  initialHistoryState,
  loadMoreStarted,
  loadMoreView,
  moreLoaded,
  moreLoadFailed,
  nextOffset,
  saleDetailHref,
  saleDetailView,
} from "./sale-history-model";

const organizationId = "org_1";
const ana = "a0000000-0000-4000-8000-000000000001";
const gone = "d0000000-0000-4000-8000-000000000004";

function id(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

function entry(
  n: number,
  overrides: Partial<SaleListEntryReadModel> = {}
): SaleListEntryReadModel {
  return {
    cancelledAt: null,
    confirmedAt: "2026-05-01T12:00:01.000Z",
    customerId: null,
    hasReturns: false,
    id: id(n),
    itemCount: 2,
    occurredAt: "2026-05-01T12:00:00.000Z",
    paymentMethod: "pix",
    status: "confirmed",
    totalDue: "1234.5",
    ...overrides,
  };
}

function customer(
  customerId: string,
  name: string,
  status: "active" | "archived" = "active"
): CustomerReadModel {
  return {
    archivedAt: status === "archived" ? "2026-02-01T00:00:00.000Z" : null,
    createdAt: "2026-01-01T00:00:00.000Z",
    email: "ana@example.com",
    id: customerId,
    name,
    notes: null,
    organizationId,
    phone: "+55 11 99999-0000",
    status,
    updatedAt: "2026-01-01T00:00:00.000Z",
    version: 1,
  };
}

function loaded(
  sales: SaleListEntryReadModel[],
  hasMore = false
): HistoryState {
  return historyLoaded(initialHistoryState(), { hasMore, sales });
}

describe("list load states", () => {
  it("starts loading", () => {
    expect(historyView(initialHistoryState())).toEqual({
      kind: "loading",
      message: "Carregando vendas…",
    });
  });

  it("explains an empty history and links to the new sale screen", () => {
    const view = historyView(loaded([]));
    expect(view).toMatchObject({ href: "/sales", kind: "empty" });
    expect("message" in view && view.message).toContain("Nenhuma venda ainda");
  });

  it("reports an error, with the generic forbidden message", () => {
    const state = historyLoadFailed(initialHistoryState(), {
      code: "FORBIDDEN",
    });
    expect(historyView(state)).toEqual({
      kind: "error",
      message: "Sua conta não tem acesso a esta organização ou ação.",
    });
  });

  it("keeps a showing list when a refresh fails", () => {
    const state = historyLoadFailed(loaded([entry(1)]), new TypeError("x"));
    expect(historyView(state).kind).toBe("ready");
    expect(state.moreError).toContain("Não foi possível carregar");
    expect(historyLoading(state).moreError).toBeNull();
  });

  it("keeps the list in the server order, newest first", () => {
    const rows = historyRows(loaded([entry(3), entry(2), entry(1)]));
    expect(rows.map((row) => row.id)).toEqual([id(3), id(2), id(1)]);
  });
});

describe("pagination", () => {
  it("offers more only when the server says so and nothing is loading", () => {
    const state = loaded([entry(1), entry(2)], true);
    expect(canLoadMore(state)).toBe(true);
    expect(nextOffset(state)).toBe(2);
    expect(loadMoreView(state)).toMatchObject({
      busy: false,
      label: "Carregar mais",
      visible: true,
    });
    expect(canLoadMore(loaded([entry(1)], false))).toBe(false);
    expect(loadMoreView(loaded([entry(1)], false)).visible).toBe(false);
    expect(canLoadMore(initialHistoryState())).toBe(false);
  });

  it("guards against a second load while one is running", () => {
    const first = loadMoreStarted(loaded([entry(1)], true));
    expect(first.loadingMore).toBe(true);
    expect(canLoadMore(first)).toBe(false);
    expect(loadMoreStarted(first)).toBe(first);
    expect(loadMoreView(first)).toMatchObject({
      busy: true,
      label: "Carregando…",
    });
  });

  it("appends the next page, skipping sales already shown", () => {
    const first = loadMoreStarted(loaded([entry(3), entry(2)], true));
    const next = moreLoaded(first, {
      hasMore: false,
      sales: [entry(2), entry(1)],
    });
    expect(next.sales.map((sale) => sale.id)).toEqual([id(3), id(2), id(1)]);
    expect(next.hasMore).toBe(false);
    expect(next.loadingMore).toBe(false);
  });

  it("keeps the list and shows an error when loading more fails", () => {
    const state = moreLoadFailed(loadMoreStarted(loaded([entry(1)], true)), {
      code: "SERVICE_UNAVAILABLE",
    });
    expect(state.sales).toHaveLength(1);
    expect(state.loadingMore).toBe(false);
    expect(loadMoreView(state).error).toContain("mais vendas");
    expect(canLoadMore(state)).toBe(true);
  });

  it("replaces the list when the first page is reloaded", () => {
    const state = historyLoaded(loaded([entry(1), entry(2)], true), {
      hasMore: false,
      sales: [entry(9)],
    });
    expect(state.sales.map((sale) => sale.id)).toEqual([id(9)]);
  });
});

describe("rows", () => {
  it("shows status, total, method, item count and the detail link", () => {
    const [confirmed, cancelled] = historyRows(
      loaded([
        entry(1),
        entry(2, {
          cancelledAt: "2026-05-03T12:00:00.000Z",
          itemCount: 1,
          paymentMethod: "credit_card",
          status: "cancelled",
        }),
      ])
    );
    expect(confirmed).toMatchObject({
      detailHref: `/sales/detail?saleId=${id(1)}`,
      itemCountText: "2 itens",
      methodText: "Pix",
      statusLabel: "Confirmada",
      statusTone: "confirmed",
      totalText: "R$ 1.234,50",
    });
    expect(cancelled).toMatchObject({
      itemCountText: "1 item",
      methodText: "Cartão de crédito",
      statusLabel: "Cancelada",
      statusTone: "cancelled",
    });
    expect(saleDetailHref(id(1))).toBe(`/sales/detail?saleId=${id(1)}`);
  });

  it("badges a sale that has returns, keeping its status", () => {
    const [plain, withReturns, cancelled] = historyRows(
      loaded([
        entry(1),
        entry(2, { hasReturns: true }),
        entry(3, { hasReturns: true, status: "cancelled" }),
      ])
    );
    expect(plain?.returnsBadge).toBeNull();
    expect(withReturns).toMatchObject({
      returnsBadge: "Com devoluções",
      statusLabel: "Confirmada",
    });
    expect(cancelled?.statusLabel).toBe("Cancelada");
  });

  it("describes a missing payment method", () => {
    expect(
      historyRows(loaded([entry(1, { paymentMethod: null })]))[0]?.methodText
    ).toBe("Pagamento não informado");
  });

  it("resolves the customer by name only", () => {
    const state = historyCustomersLoaded(
      loaded([
        entry(1),
        entry(2, { customerId: ana }),
        entry(3, { customerId: gone }),
      ]),
      [customer(ana, "Ana"), customer(id(99), "Outra", "archived")]
    );
    const rows = historyRows(state);
    expect(rows.map((row) => row.customerText)).toEqual([
      "Sem cliente",
      "Ana",
      "Cliente indisponível",
    ]);
    expect(JSON.stringify(rows)).not.toContain("example.com");
    expect(JSON.stringify(rows)).not.toContain("99999");
  });

  it("marks an archived customer and handles customers still loading or failed", () => {
    const sales = [entry(1, { customerId: ana })];
    const archived = historyCustomersLoaded(loaded(sales), [
      customer(ana, "Ana", "archived"),
    ]);
    expect(historyRows(archived)[0]?.customerText).toBe("Ana (arquivado)");
    expect(historyRows(loaded(sales))[0]?.customerText).toBe(
      "Carregando cliente…"
    );
    const failed = historyCustomersFailed(loaded(sales), { code: "FORBIDDEN" });
    expect(historyRows(failed)[0]?.customerText).toBe("Cliente indisponível");
  });
});

describe("sale detail", () => {
  const detail = (
    cancellation: SaleDetailReadModel["cancellation"],
    extra: Partial<Pick<SaleDetailReadModel, "returnSummary" | "returns">> = {}
  ): SaleDetailReadModel => ({
    cancellation,
    customer: { customerId: null, version: 0 },
    returnSummary: [
      {
        availableToReturn: 2,
        position: 0,
        restockedQuantity: 0,
        returnedQuantity: 0,
        sold: 2,
      },
    ],
    returns: [],
    ...extra,
    sale: {
      adjustments: [
        {
          amount: "10.98",
          kind: "discount",
          percentage: "10.000000",
          position: 0,
          valueType: "percentage",
        },
      ],
      items: [
        {
          chargedUnitPrice: "49.90",
          listedUnitPrice: "55.00",
          position: 0,
          productId: id(50),
          productLabel: "Camiseta — Azul / M",
          quantity: 2,
          unitCost: null,
          variantId: id(51),
        },
      ],
      payment: {
        amount: "88.82",
        anticipationFee: {
          amount: "0.00",
          fixedAmount: null,
          mode: "not_applicable",
          percentage: null,
        },
        anticipationRequested: false,
        expectedSettlementDays: null,
        installmentPlan: null,
        installments: null,
        method: "pix",
        paymentProfileId: null,
        paymentProfileName: null,
        paymentProfileRuleId: null,
        paymentProfileVersion: null,
        processingFee: {
          amount: null,
          fixedAmount: null,
          mode: "unknown",
          percentage: null,
        },
      },
      sale: {
        clientCreatedAt: null,
        commandId: id(60),
        confirmedAt: "2026-05-01T12:00:01.000Z",
        currency: "BRL",
        id: id(70),
        occurredAt: "2026-05-01T12:00:00.000Z",
      },
      totals: {
        discountTotal: "10.98",
        freightTotal: "0.00",
        paymentSurchargeTotal: "0.00",
        subtotal: "99.80",
        surchargeTotal: "0.00",
        totalDue: "88.82",
      },
    },
  });

  it("shows a confirmed sale in full and offers the cancellation", () => {
    const view = saleDetailView(detail(null));
    expect(view).toMatchObject({
      canCancel: true,
      cancellation: null,
      saleId: id(70),
      statusLabel: "Confirmada",
      statusTone: "confirmed",
    });
    expect(view.sale.items[0]).toMatchObject({
      costText: "Custo desconhecido — margem indeterminada.",
      label: "Camiseta — Azul / M",
    });
    expect(view.sale.totals.map((row) => row.value)).toEqual([
      "R$ 99,80",
      "-R$ 10,98",
      "R$ 88,82",
    ]);
    const processing = view.sale.paymentDetails.find(
      (row) => row.label === "Taxa de processamento"
    );
    expect(processing).toMatchObject({
      tone: "unknown",
      value: "desconhecida — não é zero",
    });
    expect(view.sale.saleDetails.map((row) => row.label)).toEqual([
      "Venda",
      "Data comercial",
      "Confirmada no servidor",
    ]);
  });

  it("shows the cancellation, keeps the snapshot and stops offering to cancel", () => {
    const view = saleDetailView(
      detail({
        cancelledAt: "2026-05-02T12:00:00.000Z",
        cancelledBy: "user_1",
        commandId: id(80),
        id: id(81),
        reasonCode: "other",
        reasonNote: "Troca de loja",
        saleId: id(70),
      })
    );
    expect(view.canCancel).toBe(false);
    expect(view.statusLabel).toBe("Cancelada");
    expect(view.statusTone).toBe("cancelled");
    expect(view.cancellation?.rows.map((row) => row.label)).toEqual([
      "Cancelada em",
      "Motivo",
      "Observação",
      "Estoque",
    ]);
    expect(view.cancellation?.rows[1]?.value).toBe("Outro");
    expect(view.cancellation?.rows[2]?.value).toBe("Troca de loja");
    expect(view.sale.items).toHaveLength(1);
    expect(view.sale.totals.at(-1)?.value).toBe("R$ 88,82");
  });

  it("says no reason was informed and omits an empty note", () => {
    const view = saleDetailView(
      detail({
        cancelledAt: "2026-05-02T12:00:00.000Z",
        cancelledBy: "user_1",
        commandId: id(80),
        id: id(81),
        reasonCode: null,
        reasonNote: null,
        saleId: id(70),
      })
    );
    expect(view.cancellation?.rows.map((row) => row.label)).toEqual([
      "Cancelada em",
      "Motivo",
      "Estoque",
    ]);
    expect(view.cancellation?.rows[1]?.value).toBe("Sem motivo informado");
  });

  const partial: Pick<SaleDetailReadModel, "returnSummary" | "returns"> = {
    returnSummary: [
      {
        availableToReturn: 1,
        position: 0,
        restockedQuantity: 0,
        returnedQuantity: 1,
        sold: 2,
      },
    ],
    returns: [
      {
        commandId: id(90),
        id: id(91),
        items: [{ position: 0, restockedQuantity: 0, returnedQuantity: 1 }],
        reasonCode: "defective",
        reasonNote: "Rasgada",
        returnedAt: "2026-05-02T12:00:00.000Z",
        returnedBy: "user_1",
        saleId: id(70),
      },
      {
        commandId: id(92),
        id: id(93),
        items: [{ position: 0, restockedQuantity: 1, returnedQuantity: 1 }],
        reasonCode: null,
        reasonNote: null,
        returnedAt: "2026-05-03T12:00:00.000Z",
        returnedBy: "user_1",
        saleId: id(70),
      },
    ],
  };

  it("offers a return, and no cancellation, while units remain after a return", () => {
    const view = saleDetailView(detail(null, partial));
    expect(view.hasReturns).toBe(true);
    expect(view.returnsBadge).toBe("Com devoluções");
    expect(view.statusLabel).toBe("Confirmada");
    expect(view.canReturn).toBe(true);
    expect(view.canCancel).toBe(false);
    expect(view.cancelBlockedReason).toContain("já tem devoluções");
    expect(view.allReturnedMessage).toBeNull();
    expect(view.returnRows[0]).toMatchObject({
      available: 1,
      label: "Camiseta — Azul / M",
      returned: 1,
      sold: 2,
    });
  });

  it("lists the returns newest first with reason, note and per-item quantities", () => {
    const view = saleDetailView(detail(null, partial));
    expect(view.returnsHistory.map((item) => item.id)).toEqual([
      id(93),
      id(91),
    ]);
    expect(view.returnsHistory[1]).toMatchObject({
      noteText: "Rasgada",
      reasonText: "Item com defeito",
    });
    expect(view.returnsHistory[1]?.lines[0]?.text).toBe(
      "Camiseta — Azul / M: devolvidas 1 · voltaram ao estoque 0"
    );
    expect(view.returnsHistory[0]?.reasonText).toBe("Sem motivo informado");
    expect(view.returnsHistory[0]?.noteText).toBeNull();
  });

  it("says everything was returned when nothing is available", () => {
    const view = saleDetailView(
      detail(null, {
        ...partial,
        returnSummary: [
          {
            availableToReturn: 0,
            position: 0,
            restockedQuantity: 1,
            returnedQuantity: 2,
            sold: 2,
          },
        ],
      })
    );
    expect(view.canReturn).toBe(false);
    expect(view.allReturnedMessage).toBe(
      "Todas as unidades já foram devolvidas."
    );
    expect(view.canCancel).toBe(false);
  });

  it("offers a return but no cancel block for a sale without returns", () => {
    const view = saleDetailView(detail(null));
    expect(view.canReturn).toBe(true);
    expect(view.canCancel).toBe(true);
    expect(view.cancelBlockedReason).toBeNull();
    expect(view.returnsBadge).toBeNull();
    expect(view.returnsHistory).toEqual([]);
  });

  it("does not offer returns on a cancelled sale", () => {
    const view = saleDetailView(
      detail({
        cancelledAt: "2026-05-02T12:00:00.000Z",
        cancelledBy: "user_1",
        commandId: id(80),
        id: id(81),
        reasonCode: null,
        reasonNote: null,
        saleId: id(70),
      })
    );
    expect(view.canReturn).toBe(false);
    expect(view.canCancel).toBe(false);
    expect(view.cancelBlockedReason).toBeNull();
  });

  it("maps load failures", () => {
    expect(
      detailLoadErrorMessage({
        code: "NOT_FOUND",
        data: { reason: "sale_not_found" },
      })
    ).toContain("não foi encontrada");
    expect(detailLoadErrorMessage({ code: "FORBIDDEN" })).toBe(
      "Sua conta não tem acesso a esta organização ou ação."
    );
    expect(detailLoadErrorMessage(new Error("x"))).toContain(
      "Não foi possível carregar"
    );
  });
});
