// @vitest-environment happy-dom
import type { SaleListEntryReadModel } from "@polaris/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SaleHistoryList } from "./sale-history-list";
import { historyRows } from "./sale-history-model";

const SALE: SaleListEntryReadModel = {
  cancelledAt: null,
  confirmedAt: "2026-10-14T12:00:01.000Z",
  customerId: null,
  customerName: null,
  hasReturns: false,
  id: "0199c2d0-0000-7000-8000-000000001001",
  itemCount: 1,
  occurredAt: "2026-10-14T12:00:00.000Z",
  occurredOn: "2026-10-14",
  paymentMethod: "pix",
  status: "confirmed",
  totalDue: "219.90",
};

function renderList(onOpen: (saleId: string) => void) {
  render(
    <SaleHistoryList
      offline={false}
      onOpen={onOpen}
      rows={historyRows({
        hasMore: false,
        list: "ready",
        listError: null,
        listKey: "k",
        loadingMore: false,
        moreError: null,
        refresh: "idle",
        sales: [SALE],
      })}
    />
  );
  return screen.getByRole("link");
}

afterEach(cleanup);

describe("o retorno do Histórico ao abrir uma venda", () => {
  it("o clique simples grava o retorno da venda aberta", () => {
    const onOpen = vi.fn();
    fireEvent.click(renderList(onOpen));
    expect(onOpen).toHaveBeenCalledExactlyOnceWith(SALE.id);
  });

  it.each([
    ["Ctrl-clique", { ctrlKey: true }],
    ["Cmd-clique", { metaKey: true }],
    ["Shift-clique", { shiftKey: true }],
    ["Alt-clique", { altKey: true }],
    ["clique do meio", { button: 1 }],
  ])("%s abre fora desta aba e não grava o retorno", (_name, init) => {
    const onOpen = vi.fn();
    const link = renderList(onOpen);
    fireEvent.click(link, init);
    expect(onOpen).not.toHaveBeenCalled();
  });
});
