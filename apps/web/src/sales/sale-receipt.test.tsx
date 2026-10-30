import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ConfirmedSaleView } from "./sale-form-model";
import { SaleHistoryList } from "./sale-history-list";
import type { HistoryRow } from "./sale-history-model";
import { SaleReceipt } from "./sale-receipt";

const SALE_ID = "77777777-7777-4777-8777-777777777777";

const sale: ConfirmedSaleView = {
  headline: "Venda confirmada",
  items: [
    {
      costText: "Custo desconhecido. Margem indeterminada.",
      detail: "2 × R$ 114,95 (tabela R$ 139,90) = R$ 229,90",
      key: "0-v1",
      label: "Calça jeans — 42",
    },
  ],
  note: "O método de pagamento registrado não comprova liquidação.",
  paymentDetails: [{ label: "Método", tone: "plain", value: "Pix" }],
  replayed: false,
  saleDetails: [
    { label: "Venda", tone: "plain", value: SALE_ID },
    { label: "Data da venda", tone: "plain", value: "15/10/2026" },
  ],
  saleId: SALE_ID,
  totals: [
    { key: "subtotal", label: "Subtotal", tone: "normal", value: "R$ 229,90" },
    {
      key: "discount",
      label: "Desconto",
      tone: "discount",
      value: "- R$ 10,00",
    },
    { key: "total", label: "Total devido", tone: "total", value: "R$ 219,90" },
  ],
};

const render = () =>
  renderToStaticMarkup(
    <SaleReceipt sale={sale} status={<span>Confirmada</span>} />
  );

describe("the sale as a receipt", () => {
  it("puts the identifier last, in mono, and not among the dates at the top", () => {
    const markup = render();
    expect(markup.split(SALE_ID)).toHaveLength(2);
    expect(markup.lastIndexOf(SALE_ID)).toBeGreaterThan(
      markup.indexOf("Pagamento")
    );
    expect(markup).toContain('class="pt-1 font-mono');
    expect(markup.indexOf("Data da venda")).toBeLessThan(
      markup.indexOf(SALE_ID)
    );
  });

  it("shows the adjustments above the perforation and the total under it", () => {
    const markup = render();
    const perforation = markup.indexOf("border-dashed");
    expect(markup.indexOf("Subtotal")).toBeLessThan(perforation);
    expect(markup.indexOf("Desconto")).toBeLessThan(perforation);
    expect(markup.indexOf("Total devido")).toBeGreaterThan(perforation);
    expect(markup).toContain("219,90");
  });

  it("names the status beside the title", () => {
    expect(render()).toContain("Confirmada");
  });
});

const row = (overrides: Partial<HistoryRow> = {}): HistoryRow => ({
  backdated: false,
  customerInitials: "AN",
  customerText: "Ana Souza",
  dateText: "14/10/2026",
  detailHref: `/sales/detail?saleId=${SALE_ID}`,
  id: SALE_ID,
  itemCountText: "2 itens",
  methodText: "Pix",
  returnsBadge: null,
  statusLabel: "Confirmada",
  statusTone: "confirmed",
  timeText: "09:30",
  totalText: "R$ 219,90",
  ...overrides,
});

describe("the history list", () => {
  it("links the date to the detail with a connection", () => {
    const markup = renderToStaticMarkup(
      <SaleHistoryList offline={false} rows={[row()]} />
    );
    expect(markup).toContain(`href="/sales/detail?saleId=${SALE_ID}"`);
  });

  it("has no link without a connection: the detail is read from the server", () => {
    const markup = renderToStaticMarkup(
      <SaleHistoryList offline rows={[row()]} />
    );
    expect(markup).not.toContain("<a ");
    expect(markup).toContain("14/10/2026");
  });

  it("shows the states of the sale as badges", () => {
    const markup = renderToStaticMarkup(
      <SaleHistoryList
        offline={false}
        rows={[
          row({
            backdated: true,
            returnsBadge: "Com devoluções",
            statusLabel: "Cancelada",
            statusTone: "cancelled",
          }),
        ]}
      />
    );
    expect(markup).toContain("Cancelada");
    expect(markup).toContain("Com devoluções");
    expect(markup).toContain("Retroativa");
  });

  it("writes customer, method and items on one line, with no 'Cliente:' prefix", () => {
    const plain = (html: string) => html.replace(/<[^>]+>/g, "");
    const markup = renderToStaticMarkup(
      <SaleHistoryList offline={false} rows={[row()]} />
    );
    expect(plain(markup)).toContain("Ana Souza · Pix · 2 itens");
    expect(markup).toContain('<span class="truncate">Ana Souza</span>');
    expect(markup).toContain("shrink-0 whitespace-pre");
    expect(markup).not.toContain("line-clamp");
    expect(markup).not.toContain("Cliente:");
    const none = renderToStaticMarkup(
      <SaleHistoryList
        offline={false}
        rows={[
          row({
            customerText: "Sem cliente",
            itemCountText: "1 item",
            methodText: "Dinheiro",
          }),
        ]}
      />
    );
    expect(plain(none)).toContain("Sem cliente · Dinheiro · 1 item");
  });

  it("ends the row in a chevron with a connection and has none without one", () => {
    const online = renderToStaticMarkup(
      <SaleHistoryList offline={false} rows={[row()]} />
    );
    const offline = renderToStaticMarkup(
      <SaleHistoryList offline rows={[row()]} />
    );
    expect(online).toContain("lucide-chevron-right");
    expect(offline).not.toContain("lucide-chevron-right");
  });
});
