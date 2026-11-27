import type { SaleListEntryReadModel } from "@polaris/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ItemDraft } from "./sale-form-model";
import { SaleHistoryList } from "./sale-history-list";
import { historyRows } from "./sale-history-model";
import { ItemEditor } from "./sale-item-editor";

vi.mock("../lib/orpc", () => ({ orpcClient: {} }));

const variantId = "22222222-2222-4222-8222-222222222222";
const NBSP = "\u00A0";
const item: ItemDraft = {
  chargedUnitPrice: "50,00",
  draftId: "d1",
  label: "Camiseta do teste · Azul",
  listedUnitPrice: "50,00",
  productId: "11111111-1111-4111-8111-111111111111",
  quantity: "1",
  variantId,
};
const noop = () => undefined;
const SEPARATOR_BEFORE_STATUS = new RegExp(
  `<span aria-hidden="true"[^>]*>·${NBSP}</span><span[^>]*id="sale-item-d1-stock"[^>]*role="status"[^>]*>Saldo 5</span>`
);

describe("o ponto separador não fica pendurado no fim da linha", () => {
  it("na linha do item, o ponto vem colado ao saldo e o saldo mantém o id e o role", () => {
    const html = renderToStaticMarkup(
      <ItemEditor
        canAdjustStock={false}
        canRemove={false}
        errors={{}}
        index={0}
        item={item}
        localSearch={undefined}
        onChange={noop}
        onPick={noop}
        onRemove={noop}
        organizationId="org"
        priceHint={null}
        stock={{
          [variantId]: {
            status: "ready",
            value: {
              movingAverageCost: null,
              quantity: 5,
              variantId,
              version: 1,
            },
          },
        }}
        stockWarning={undefined}
        summaryLine={undefined}
      />
    );
    expect(html).toMatch(SEPARATOR_BEFORE_STATUS);
  });

  it("no Histórico, o ponto abre a forma de pagamento e nenhum ponto fecha o nome do cliente", () => {
    const sale: SaleListEntryReadModel = {
      cancelledAt: null,
      confirmedAt: "2026-10-14T12:00:01.000Z",
      customerId: null,
      customerName: null,
      hasReturns: false,
      id: "0199c2d0-0000-7000-8000-000000001001",
      itemCount: 1,
      occurredAt: "2026-10-14T12:00:00.000Z",
      occurredOn: "2026-10-14",
      paymentMethod: "cash",
      status: "confirmed",
      totalDue: "50.00",
    };
    const html = renderToStaticMarkup(
      <SaleHistoryList
        offline={false}
        rows={historyRows({
          hasMore: false,
          list: "ready",
          listError: null,
          listKey: "k",
          loadingMore: false,
          moreError: null,
          refresh: "idle",
          sales: [sale],
        })}
      />
    );
    expect(html).toContain(`>·${NBSP}Dinheiro ·${NBSP}1 item<`);
    expect(html).not.toContain("Sem cliente ·");
    expect(html).not.toContain(">Sem cliente</span><span");
  });
});
