import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ConfirmedSaleView } from "./sale-form-model";
import { SaleHistoryList } from "./sale-history-list";
import type { HistoryRow } from "./sale-history-model";
import { SaleReceipt } from "./sale-receipt";

const FRAME = /\bborder|\bring|\bshadow/;
const MUTED_BLOCK = /<dl class="[^"]*bg-muted[^"]*"/g;
const TOTAL_PARTS =
  /data-money-currency="">R\$ <\/span><span data-money-number="">219<\/span><span[^>]*data-money-cents="">,90</;
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
    {
      label: "Registrada no dispositivo",
      tone: "plain",
      value: "15/10/2026, 09:01",
    },
    {
      label: "Confirmada no servidor",
      tone: "plain",
      value: "15/10/2026, 09:02",
    },
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

  it("shows the total right under the title and the perforation after it, above the items and the adjustments", () => {
    const markup = render();
    const perforation = markup.indexOf("border-dashed");
    expect(markup.indexOf("Total devido")).toBeLessThan(perforation);
    expect(markup.indexOf("Subtotal")).toBeGreaterThan(perforation);
    expect(markup.indexOf("Desconto")).toBeGreaterThan(perforation);
    expect(markup).toMatch(TOTAL_PARTS);
  });

  it("reads in the order: title, state, total, items, adjustments, dates, payment", () => {
    const markup = render();
    const order = [
      ">Venda<",
      "Confirmada",
      "Total devido",
      ">Itens<",
      "Subtotal",
      "Data da venda",
      ">Pagamento<",
    ].map((text) => markup.indexOf(text));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("sets the dates and the payment back as a muted block with no border, two columns from 760 px", () => {
    const markup = render();
    const blocks = markup.match(MUTED_BLOCK) ?? [];
    expect(blocks).toHaveLength(2);
    for (const block of blocks) {
      expect(block).toContain("rounded-lg");
      expect(block).toContain("p-4");
      expect(block).toContain("md:grid-cols-2");
      expect(block).not.toMatch(FRAME);
    }
    expect(markup).toContain('class="text-muted-foreground text-xs">Método<');
  });

  it("keeps the three dates in one block, after the items and the adjustments", () => {
    const markup = render();
    const start = markup.indexOf('<dl class="grid gap-3 rounded-lg bg-muted');
    const dateBlock = markup.slice(start, markup.indexOf("</dl>", start));
    expect(dateBlock).toContain("Data da venda");
    expect(dateBlock).toContain("Registrada no dispositivo");
    expect(dateBlock).toContain("Confirmada no servidor");
    expect(markup.indexOf("Desconto")).toBeLessThan(start);
    expect(start).toBeLessThan(markup.indexOf("Pagamento"));
  });

  it("has no ink button: the receipt only reads", () => {
    expect(render()).not.toContain("<button");
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
    const markup = renderToStaticMarkup(
      <SaleHistoryList offline={false} rows={[row()]} />
    );
    expect(markup).toContain(
      '<span class="min-w-[5ch] truncate">Ana Souza</span>'
    );
    expect(markup).toContain(
      '<span class="overflow-hidden text-ellipsis"> · Pix</span>'
    );
    expect(markup).toContain('<span class="shrink-0"> · 2 itens</span>');
    expect(markup).toContain("shrink-0 whitespace-pre");
    expect(markup).toContain("min-w-0 flex-1");
    expect(markup).toContain("overflow-hidden");
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
    expect(none).toContain(
      '<span class="min-w-[5ch] truncate">Sem cliente</span>'
    );
    expect(none).toContain(" · Dinheiro</span>");
    expect(none).toContain('<span class="shrink-0"> · 1 item</span>');
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
