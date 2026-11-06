import type { SaleListEntryReadModel } from "@polaris/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ListTotalFooter } from "../catalog/screen-parts";
import { SaleHistoryList } from "./sale-history-list";
import { historyRows, historyTotal } from "./sale-history-model";

const sale = (
  n: number,
  overrides: Partial<SaleListEntryReadModel> = {}
): SaleListEntryReadModel => ({
  cancelledAt: null,
  confirmedAt: "2026-10-14T12:00:01.000Z",
  customerId: null,
  customerName: null,
  hasReturns: false,
  id: `0199c2d0-0000-7000-8000-000000001${String(n).padStart(3, "0")}`,
  itemCount: 1,
  occurredAt: "2026-10-14T12:00:00.000Z",
  occurredOn: "2026-10-14",
  paymentMethod: "pix",
  status: "confirmed",
  totalDue: "219.90",
  ...overrides,
});

describe("historyTotal", () => {
  it("soma só as confirmadas, em centavos exatos, e diz quantas canceladas ficaram de fora", () => {
    const total = historyTotal([
      sale(1, { totalDue: "0.10" }),
      sale(2, { totalDue: "0.20" }),
      sale(3, { status: "cancelled", totalDue: "5000.00" }),
      sale(4, { status: "cancelled", totalDue: "1.00" }),
    ]);
    expect(total).toEqual({
      countText: "2 vendas",
      noteText: "2 canceladas ficam fora da soma.",
      totalText: "R$ 0,30",
    });
  });

  it("singular, e sem cancelada a nota fica vazia (a linha continua no DOM)", () => {
    const total = historyTotal([sale(1, { totalDue: "1234.50" })]);
    expect(total.countText).toBe("1 venda");
    expect(total.noteText).toBe("");
    expect(total.totalText).toBe("R$ 1.234,50");
    expect(historyTotal([sale(1, { status: "cancelled" })]).noteText).toBe(
      "1 cancelada fica fora da soma."
    );
  });

  it('com mais uma página pendente a contagem diz "há mais"', () => {
    expect(historyTotal([sale(1)], true).countText).toBe("1 venda · há mais");
    expect(historyTotal([sale(1)]).countText).toBe("1 venda");
  });

  it("sem vendas é zero, e um valor ilegível vira null", () => {
    expect(historyTotal([])).toMatchObject({
      countText: "0 vendas",
      totalText: "R$ 0,00",
    });
    expect(historyTotal([sale(1, { totalDue: "abc" })]).totalText).toBeNull();
  });
});

describe("o rodapé do Histórico", () => {
  const footer = (sales: SaleListEntryReadModel[]) => {
    const total = historyTotal(sales);
    return (
      <ListTotalFooter
        count={total.countText}
        note={total.noteText}
        value={total.totalText}
      />
    );
  };

  it("fica dentro do cartão da lista, depois das linhas, com o valor à direita em tabular-nums", () => {
    const sales = [sale(1), sale(2, { status: "cancelled" })];
    const html = renderToStaticMarkup(
      <SaleHistoryList
        footer={footer(sales)}
        offline={false}
        rows={historyRows({
          hasMore: false,
          list: "ready",
          listError: null,
          loadingMore: false,
          moreError: null,
          sales,
        })}
      />
    );
    expect(html.indexOf("Total na tela")).toBeGreaterThan(
      html.lastIndexOf("</li>")
    );
    expect(html).toContain("R$ 219,90");
    expect(html).toContain("1 cancelada fica fora da soma.");
    expect(html).toContain("text-right");
    expect(html).toContain("tabular-nums");
  });

  it("a linha da nota continua no DOM, vazia e com altura mínima, quando nenhuma venda saiu da soma", () => {
    const html = renderToStaticMarkup(footer([sale(1)]));
    expect(html).toContain('data-list-total-note=""');
    expect(html).toContain("min-h-5");
  });
});
