import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfirmedSaleView } from "./sale-form-model";
import type { HistoryRow } from "./sale-history-model";

const state = vi.hoisted(() => ({ hidden: false }));

vi.mock("@/lib/hidden-values", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/hidden-values")>()),
  useHiddenValues: () => [state.hidden, () => undefined],
}));

const { SaleHistoryList } = await import("./sale-history-list");
const { SaleReceipt } = await import("./sale-receipt");

const FRAME = /\bborder|\bring|\bshadow/;
const DETAILS_BLOCK =
  /<div\b[^>]*\bdata-receipt-block="[^"]*"[^>]*><dl\b[^>]*>/g;
const PERFORATION = "data-receipt-perforation";
const MONO_CELL = /<(?:dd|span|p)\b[^>]*class="[^"]*font-mono[^"]*"[^>]*>/g;
const TOTALS_STRIP = /<dl\b[^>]*\bdata-receipt-totals\b/;
const DD = /<dd class="([^"]*)"/g;
const ITEM_PRICES =
  /<p class="[^"]*justify-between[^"]*font-mono[^"]*"><span[^>]*><span class="whitespace-nowrap">2 × <span[^>]*>R\$ /;
const ITEM_AMOUNTS = /114,95|139,90|229,90/;
const ITEM_LINE = /<p class="[^"]*justify-between[^"]*font-mono[^"]*">.*?<\/p>/;
const ID_LABEL =
  /<span class="[^"]*text-support[^"]*">Identificador da venda<\/span>/;
const PIX_CELL = /text-right text-sm[^"]*">Pix</;
const NOT_APPLICABLE_CELL =
  /text-right text-sm[^"]*"><span class="text-muted-foreground">não se aplica/;
const MONO_ITEM_NAME = /font-mono[^>]*>Calça jeans/;
const MONO_DATE = /font-mono[^>]*>15\/10\/2026/;
const MASKED_TOTAL =
  /data-money-currency="">R\$ <\/span><span data-money-number="">••••</;
const TOTAL_PARTS =
  /data-money-currency="">R\$ <\/span><span data-money-number="">219<\/span><span[^>]*data-money-cents="">,90</;
const SALE_ID = "77777777-7777-4777-8777-777777777777";

const sale: ConfirmedSaleView = {
  headline: "Venda confirmada",
  items: [
    {
      costText: "Custo desconhecido. Margem indeterminada.",
      chargedText: "2 × R$ 114,95",
      key: "0-v1",
      label: "Calça jeans — 42",
      listedText: "tabela R$ 139,90",
      totalText: "R$ 229,90",
    },
  ],
  note: "O método de pagamento registrado não comprova liquidação.",
  paymentDetails: [
    { label: "Método", tone: "plain", value: "Pix" },
    { label: "Valor do pagamento", tone: "known", value: "R$ 219,90" },
    {
      label: "Taxa de processamento",
      tone: "known",
      value: "R$ 5,50 (2,5% do total devido)",
    },
    {
      label: "Taxa de antecipação",
      tone: "not_applicable",
      value: "não se aplica",
    },
  ],
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
  summary: { itemCount: 2 },
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

beforeEach(() => {
  state.hidden = false;
});

describe("the sale as a receipt", () => {
  it("puts the identifier last, in mono, and not among the dates at the top", () => {
    const markup = render();
    expect(markup.split(SALE_ID)).toHaveLength(2);
    expect(markup.lastIndexOf(SALE_ID)).toBeGreaterThan(
      markup.indexOf("Pagamento")
    );
    expect(markup).toMatch(ID_LABEL);
    expect(markup).toContain('class="font-mono text-muted-foreground text-xs');
    expect(markup.indexOf("Data da venda")).toBeLessThan(
      markup.indexOf(SALE_ID)
    );
  });

  it("writes the label of the identifier as visible text, once, and keeps the code unchanged", () => {
    const markup = render();
    expect(markup.split("Identificador da venda")).toHaveLength(2);
    expect(markup).not.toContain('sr-only">Identificador');
    expect(markup).toContain(`[overflow-wrap:anywhere]">${SALE_ID}</span>`);
  });

  it("writes an item with two ends: quantity and charged price at the left, the total of the item at the right, with no equals sign", () => {
    const line = render().match(ITEM_LINE)?.[0] ?? "";
    const text = line
      .split("<")
      .map((piece) => piece.slice(piece.indexOf(">") + 1))
      .join("");
    expect(text).toBe(
      "2 × R$ 114,95, tabela R$ 139,90Total do item: R$ 229,90"
    );
    expect(text).not.toContain("=");
    expect(line.indexOf("2 ×")).toBeLessThan(line.indexOf("tabela"));
    expect(line.indexOf("tabela")).toBeLessThan(line.indexOf("Total do item"));
    expect(line).toContain("justify-between");
    expect(line).toContain("ml-auto");
  });

  it("writes 'tabela' only when the table price differs from the charged one", () => {
    const same = renderToStaticMarkup(
      <SaleReceipt
        sale={{
          ...sale,
          items: sale.items.map((line) => ({ ...line, listedText: null })),
        }}
        status={<span>Confirmada</span>}
      />
    );
    expect(same).not.toContain("tabela");
    expect(render()).toContain("tabela");
  });

  it("masks the charged price, the table price and the total of the item with the values hidden", () => {
    state.hidden = true;
    const line = render().match(ITEM_LINE)?.[0] ?? "";
    expect(line).not.toMatch(ITEM_AMOUNTS);
    expect(line.match(/data-masked-money/g)).toHaveLength(3);
  });

  it("shows the total right under the title and the perforation after it, above the items and the adjustments", () => {
    const markup = render();
    const perforation = markup.indexOf(PERFORATION);
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

  it("sets the dates and the payment back as two rounded, padded blocks with no border; the dates in two columns from 760 px, the payment as lines", () => {
    const markup = render();
    const blocks = markup.match(DETAILS_BLOCK) ?? [];
    expect(blocks).toHaveLength(2);
    for (const block of blocks) {
      expect(block).toContain("rounded-lg");
      expect(block).toContain("p-4");
      expect(block).not.toMatch(FRAME);
    }
    expect(blocks[0]).toContain("md:grid-cols-2");
    expect(blocks[1]).not.toContain("md:grid-cols-2");
    expect(markup).toContain(
      'class="text-muted-foreground text-xs">Data da venda<'
    );
  });

  it("writes every amount of the lines in Geist Mono, at the right: items, subtotal, discount, total and the payment amounts", () => {
    const markup = render();
    const mono = markup.match(MONO_CELL) ?? [];
    // the 8 cells (the total and the count of the strip, the item prices, the subtotal, the discount, the payment amount and the processing fee, the identifier) and the 7 amounts of `Money` inside them
    expect(mono).toHaveLength(15);
    expect(markup).toMatch(ITEM_PRICES);
    const lines = markup.slice(markup.indexOf(PERFORATION));
    const cells = [...lines.matchAll(DD)].map((match) => match[1] ?? "");
    const monoCells = cells.filter((cell) => cell.includes("font-mono"));
    expect(monoCells).toHaveLength(4);
    for (const cell of monoCells) {
      expect(cell).toContain("tabular-nums");
      expect(cell).toContain("text-right");
    }
  });

  it("keeps the names, the labels, the words of the payment and the dates in Geist", () => {
    const markup = render();
    const paymentStart = markup.indexOf("Método");
    const payment = markup.slice(paymentStart);
    expect(payment).toMatch(PIX_CELL);
    expect(payment).toMatch(NOT_APPLICABLE_CELL);
    expect(markup).not.toMatch(MONO_ITEM_NAME);
    expect(markup).not.toMatch(MONO_DATE);
  });

  it("keeps the mask in the same cells: mono, at the right, '••••' where the amount was", () => {
    const shown = render();
    state.hidden = true;
    const masked = render();
    expect(masked).not.toContain("219,90");
    expect(masked).toContain("data-masked-money");
    expect(masked.match(MONO_CELL)).toHaveLength(
      shown.match(MONO_CELL)?.length ?? -1
    );
    expect(masked.match(DD)).toEqual(shown.match(DD));
    expect(masked).toMatch(MASKED_TOTAL);
  });

  it("keeps the three dates in one block, after the items and the adjustments", () => {
    const markup = render();
    const start = markup.indexOf('data-receipt-block="dates"');
    const dateBlock = markup.slice(start, markup.indexOf("</dl>", start));
    expect(dateBlock).toContain("Data da venda");
    expect(dateBlock).toContain("Registrada no dispositivo");
    expect(dateBlock).toContain("Confirmada no servidor");
    expect(markup.indexOf("Desconto")).toBeLessThan(start);
    expect(start).toBeLessThan(markup.indexOf("Pagamento"));
  });

  it("writes the total once, in a strip of two terms: Total devido and Itens", () => {
    const markup = render();
    expect(markup.split("Total devido")).toHaveLength(2);
    expect(markup.match(TOTAL_PARTS)).toHaveLength(1);
    const strip = markup.slice(
      markup.search(TOTALS_STRIP),
      markup.indexOf(PERFORATION)
    );
    const terms = [...strip.matchAll(/<dt[^>]*>([^<]*)<\/dt>/g)].map(
      (match) => match[1]
    );
    expect(terms).toEqual(["Total devido", "Itens"]);
    expect(strip.match(/<dd/g)).toHaveLength(2);
    expect(markup).not.toContain("Recebido");
  });

  it("writes Item in the singular for a sale of one line, as the history does", () => {
    const markup = renderToStaticMarkup(
      <SaleReceipt
        sale={{ ...sale, summary: { itemCount: 1 } }}
        status={<span>Confirmada</span>}
      />
    );
    const terms = [...markup.matchAll(/<dt[^>]*>([^<]*)<\/dt>/g)].map(
      (match) => match[1]
    );
    expect(terms.slice(0, 2)).toEqual(["Total devido", "Item"]);
    expect(markup).toContain(">1</dd>");
  });

  it("writes the count of items from the sale, and masks the total of the strip with the values hidden", () => {
    const strip = (markup: string) =>
      markup.slice(markup.search(TOTALS_STRIP), markup.indexOf(PERFORATION));
    expect(strip(render())).toMatch(TOTAL_PARTS);
    expect(strip(render())).toContain(">2</dd>");
    state.hidden = true;
    const masked = strip(render());
    expect(masked).not.toContain("219");
    expect(masked.match(/data-masked-money/g)).toHaveLength(1);
    expect(masked).toContain(">2</dd>");
  });

  it("keeps the strip with the cancellation notice above it", () => {
    const markup = renderToStaticMarkup(
      <SaleReceipt
        before={<p>Venda cancelada</p>}
        sale={sale}
        status={<span>Cancelada</span>}
      />
    );
    expect(markup.indexOf("Venda cancelada")).toBeLessThan(
      markup.indexOf("Total devido")
    );
    expect(markup).toContain("Total devido");
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
  splitPayment: false,
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

  it("puts the methods of a sale in two parts on a line of their own, with no dot after the name", () => {
    const markup = renderToStaticMarkup(
      <SaleHistoryList
        offline={false}
        rows={[row({ methodText: "Pix + Crédito", splitPayment: true })]}
      />
    );
    expect(markup).toContain('<span class="truncate">Ana Souza</span>');
    expect(markup).not.toContain("whitespace-pre");
    expect(markup).toContain(
      '<span class="min-w-0 max-w-full basis-full">Pix + Crédito ·\u00A02 itens</span>'
    );
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
    expect(markup).toContain('<span class="truncate">Ana Souza</span>');
    expect(markup).not.toContain("whitespace-pre");
    expect(markup).toContain(
      '<span class="min-w-0 max-w-full">·\u00A0Pix ·\u00A02 itens</span>'
    );
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
    expect(none).toContain('<span class="truncate">Sem cliente</span>');
    expect(none).toContain("·\u00A0Dinheiro ·\u00A01 item</span>");
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
