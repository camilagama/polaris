import type { SaleListEntryReadModel } from "@polaris/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SaleHistoryList, SaleStatusBadges } from "./sale-history-list";
import { historyRows } from "./sale-history-model";

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

const SALES = [
  sale(1),
  sale(2, { cancelledAt: "2026-10-14T13:00:00.000Z", status: "cancelled" }),
  sale(3, { hasReturns: true }),
  sale(4, { occurredOn: "2026-10-10" }),
];

const STATE_TEXT =
  /<span class="sr-only">(Confirmada)<\/span>|<span[^>]*data-slot="badge"[^>]*>([^<]*)<\/span>/g;
const BADGE = /<span[^>]*data-slot="badge"[^>]*>([^<]*)<\/span>/g;

function renderedRows(offline = false) {
  const html = renderToStaticMarkup(
    <SaleHistoryList
      offline={offline}
      rows={historyRows({
        hasMore: false,
        list: "ready",
        listError: null,
        loadingMore: false,
        listKey: "k",
        moreError: null,
        refresh: "idle",
        sales: SALES,
      })}
    />
  );
  return html.split("<li").slice(1);
}

const badgesOf = (row: string) =>
  [...row.matchAll(BADGE)].map((match) => match[1]);

describe("o selo de estado da linha do Histórico", () => {
  it("a venda comum não tem selo visível e diz Confirmada só ao leitor de tela", () => {
    const [common] = renderedRows();
    expect(badgesOf(common ?? "")).toEqual([]);
    expect(common).toContain('<span class="sr-only">Confirmada</span>');
  });

  it("Cancelada, Com devoluções e Retroativa continuam como selos", () => {
    const [, cancelled, returned, backdated] = renderedRows();
    expect(badgesOf(cancelled ?? "")).toEqual(["Cancelada"]);
    expect(badgesOf(returned ?? "")).toEqual(["Com devoluções"]);
    expect(badgesOf(backdated ?? "")).toEqual(["Retroativa"]);
  });

  it("o nome de cada linha traz o estado, na ordem de hoje: data, estado, devoluções e Retroativa antes da linha de apoio", () => {
    const states = renderedRows().map((row) =>
      [...row.matchAll(STATE_TEXT)].map((match) => match[1] ?? match[2])
    );
    expect(states).toEqual([
      ["Confirmada"],
      ["Cancelada"],
      ["Confirmada", "Com devoluções"],
      ["Confirmada", "Retroativa"],
    ]);
    for (const row of renderedRows()) {
      const firstState = row.search(STATE_TEXT);
      expect(firstState).toBeGreaterThan(row.indexOf("2026"));
      expect(firstState).toBeLessThan(row.indexOf("Sem cliente"));
    }
  });

  it("sem conexão a regra é a mesma", () => {
    const [common, cancelled] = renderedRows(true);
    expect(badgesOf(common ?? "")).toEqual([]);
    expect(common).toContain('<span class="sr-only">Confirmada</span>');
    expect(badgesOf(cancelled ?? "")).toEqual(["Cancelada"]);
  });
});

describe("SaleStatusBadges fora da lista (o Detalhe)", () => {
  it("sem a opção da lista, Confirmada continua um selo visível", () => {
    const html = renderToStaticMarkup(
      <SaleStatusBadges
        returnsBadge={null}
        statusLabel="Confirmada"
        statusTone="confirmed"
      />
    );
    expect(badgesOf(html)).toEqual(["Confirmada"]);
    expect(html).not.toContain("sr-only");
  });
});

const BARE_SIZE_9 = /[\s"]size-9[\s"]/;
const BARE_HIDDEN = /[\s"]hidden[\s"]/;
const BARE_GRID = /[\s"]grid[\s"]/;
const INITIALS_CIRCLE = /<span[^>]*data-row-initials=""[^>]*>/;

describe("o círculo de iniciais da linha do Histórico", () => {
  const circleOf = (customerName: string | null) => {
    const html = renderToStaticMarkup(
      <SaleHistoryList
        offline={false}
        rows={historyRows({
          hasMore: false,
          list: "ready",
          listError: null,
          loadingMore: false,
          listKey: "k",
          moreError: null,
          refresh: "idle",
          sales: [sale(1, { customerId: "c1", customerName })],
        })}
      />
    );
    return html.match(INITIALS_CIRCLE)?.[0] ?? "";
  };

  it("com cliente tem fundo e as iniciais; a 32 px no celular, 36 a partir de md, e só aparece em 22,5 rem ou mais", () => {
    const circle = circleOf("Ana Lima");
    expect(circle).toContain("bg-muted");
    expect(circle).toContain("size-8");
    expect(circle).toContain("md:size-9");
    expect(circle).not.toMatch(BARE_SIZE_9);
    expect(circle).toMatch(BARE_HIDDEN);
    expect(circle).not.toMatch(BARE_GRID);
    expect(circle).toContain("@max-[17.9rem]:hidden");
    expect(circle).toContain("min-[22.5rem]:grid");
  });

  it("sem cliente deixa o espaço sem fundo", () => {
    const circle = circleOf(null);
    expect(circle).not.toContain("bg-muted");
    expect(circle).toContain("bg-transparent");
  });
});
