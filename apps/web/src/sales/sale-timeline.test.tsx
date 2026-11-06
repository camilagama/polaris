import type { SaleDetailReadModel } from "@polaris/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
vi.mock("../lib/orpc", () => ({ orpcClient: {} }));

import { ReadyDetailTop } from "./sale-detail-page";
import { saleTimelineEvents } from "./sale-history-model";
import { SaleTimeline } from "./sale-timeline";

const ID = "00000000-0000-4000-8000-000000000070";
const ITEM_LABEL = "Camiseta — Azul / M";
const CANCEL_NOTE = "Cliente desistiu da compra";
const RETURN_NOTE = "Veio rasgada";
const CANCELLED_LINE = /^Cancelada, \d{1,2} jun \d{2}:\d{2}$/;
const REGISTERED_LINE = /^Registrada, \d{1,2} jun \d{2}:\d{2}$/;
const SALE_LINE = /^Venda feita, \d{1,2} jun \d{2}:\d{2}$/;
const OL = /<ol[\s>]/g;
const LI = /<li[\s>]/g;
const ITEM_TEXT = /<li[^>]*>(.*?)<\/li>/g;
const TAGS = /<[^>]+>/g;

const returnAt = (
  n: number,
  returnedAt: string,
  reasonNote: string | null
) => ({
  commandId: `00000000-0000-4000-8000-0000000001${n}0`,
  id: `00000000-0000-4000-8000-0000000001${n}1`,
  items: [{ position: 0, restockedQuantity: 1, returnedQuantity: 1 }],
  reasonCode: "defective" as const,
  reasonNote,
  returnedAt,
  returnedBy: "user_1",
  saleId: ID,
});

function detail(
  overrides: {
    cancelledAt?: string;
    confirmedAt?: string;
    occurredAt?: string;
    returns?: SaleDetailReadModel["returns"];
  } = {}
): SaleDetailReadModel {
  return {
    cancellation: overrides.cancelledAt
      ? {
          cancelledAt: overrides.cancelledAt,
          cancelledBy: "user_1",
          commandId: "00000000-0000-4000-8000-000000000080",
          id: "00000000-0000-4000-8000-000000000081",
          reasonCode: "other",
          reasonNote: CANCEL_NOTE,
          saleId: ID,
        }
      : null,
    customer: { customerId: null, version: 0 },
    returnSummary: [],
    returns: overrides.returns ?? [],
    sale: {
      adjustments: [],
      items: [
        {
          chargedUnitPrice: "49.90",
          listedUnitPrice: "55.00",
          position: 0,
          productId: "00000000-0000-4000-8000-000000000050",
          productLabel: ITEM_LABEL,
          quantity: 2,
          unitCost: null,
          variantId: "00000000-0000-4000-8000-000000000051",
        },
      ],
      payment: {
        amount: "99.80",
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
        commandId: "00000000-0000-4000-8000-000000000060",
        confirmedAt: overrides.confirmedAt ?? "2026-06-10T12:00:01.000Z",
        currency: "BRL",
        id: ID,
        occurredAt: overrides.occurredAt ?? "2026-06-10T12:00:00.000Z",
        occurredOn: "2026-06-10",
        recordedAt: null,
      },
      totals: {
        discountTotal: "0.00",
        freightTotal: "0.00",
        paymentSurchargeTotal: "0.00",
        subtotal: "99.80",
        surchargeTotal: "0.00",
        totalDue: "99.80",
      },
    },
  };
}

const render = (view: SaleDetailReadModel) =>
  renderToStaticMarkup(<SaleTimeline events={saleTimelineEvents(view)} />);

const lines = (html: string) =>
  [...html.matchAll(ITEM_TEXT)].map((match) =>
    (match[1] ?? "").replace(TAGS, "")
  );

describe("SaleTimeline", () => {
  it("does not render for a sale with a single event", () => {
    expect(render(detail())).toBe("");
    expect(render(detail({ confirmedAt: "2026-06-10T12:00:59.000Z" }))).toBe(
      ""
    );
  });

  it("renders from two events: a registration 60 s late, a return or a cancellation", () => {
    expect(
      render(detail({ confirmedAt: "2026-06-10T12:01:00.000Z" }))
    ).not.toBe("");
    expect(
      render(
        detail({ returns: [returnAt(0, "2026-06-11T12:00:00.000Z", null)] })
      )
    ).not.toBe("");
    expect(
      render(detail({ cancelledAt: "2026-06-11T12:00:00.000Z" }))
    ).not.toBe("");
  });

  it("is a titled ordered list with a word and a time on every line", () => {
    const html = render(
      detail({
        cancelledAt: "2026-06-22T12:00:00.000Z",
        confirmedAt: "2026-06-10T12:10:00.000Z",
      })
    );
    expect(html.match(OL)).toHaveLength(1);
    expect(html).toContain('aria-labelledby="sale-timeline-title"');
    expect(html).toContain('id="sale-timeline-title"');
    expect(html).toContain("Linha do tempo");
    expect(html.match(LI)).toHaveLength(3);
    const text = lines(html);
    expect(text).toHaveLength(3);
    expect(text[0]).toMatch(CANCELLED_LINE);
    expect(text[1]).toMatch(REGISTERED_LINE);
    expect(text[2]).toMatch(SALE_LINE);
  });

  it("gives the time as a machine-readable instant and keeps the dot out of the reading", () => {
    const html = render(detail({ cancelledAt: "2026-06-22T12:00:00.000Z" }));
    expect(html).toContain('dateTime="2026-06-22T12:00:00.000Z"');
    expect(html).toContain('<time class="');
    expect(html).toContain("tabular-nums");
    expect(html.match(/aria-hidden="true"/g)).toHaveLength(2);
    expect(html).toContain('<span class="sr-only">, </span>');
  });

  it("colors one dot by the state of the sale and no line depends on the color alone", () => {
    const open = render(
      detail({ returns: [returnAt(0, "2026-06-11T12:00:00.000Z", null)] })
    );
    expect(open.match(/bg-chart-sales/g)).toHaveLength(1);
    expect(open).not.toContain("bg-destructive");
    const cancelled = render(
      detail({ cancelledAt: "2026-06-11T12:00:00.000Z" })
    );
    expect(cancelled.match(/bg-destructive/g)).toHaveLength(1);
    expect(cancelled).not.toContain("bg-chart-sales");
    expect(lines(cancelled)[0]).toContain("Cancelada");
  });

  it("does not repeat the reason, the note or the items of the cancellation and of the returns", () => {
    const html = render(
      detail({
        cancelledAt: "2026-06-22T12:00:00.000Z",
        returns: [
          returnAt(0, "2026-06-12T12:00:00.000Z", RETURN_NOTE),
          returnAt(1, "2026-06-13T12:00:00.000Z", null),
        ],
      })
    );
    expect(lines(html).map((line) => line.split(",")[0])).toEqual([
      "Cancelada",
      "Devolução",
      "Devolução",
      "Venda feita",
    ]);
    for (const text of [
      CANCEL_NOTE,
      RETURN_NOTE,
      ITEM_LABEL,
      "Item com defeito",
      "Motivo",
      "Observação",
      "devolvidas",
    ]) {
      expect(html).not.toContain(text);
    }
  });
});

describe("the timeline inside the detail", () => {
  const top = (view: SaleDetailReadModel) =>
    renderToStaticMarkup(<ReadyDetailTop detail={view} refreshing={false} />);
  const section = (html: string) => {
    const start = html.indexOf(
      '<section aria-labelledby="sale-timeline-title"'
    );
    return html.slice(start, html.indexOf("</section>", start));
  };
  const twoReturns = detail({
    returns: [
      returnAt(0, "2026-06-12T12:00:00.000Z", RETURN_NOTE),
      returnAt(1, "2026-06-13T12:00:00.000Z", null),
    ],
  });
  const cancelled = detail({ cancelledAt: "2026-06-22T12:00:00.000Z" });

  it("sits under the receipt and before the returns", () => {
    const html = top(twoReturns);
    const receipt = html.indexOf('id="sale-detail-title"');
    const timeline = html.indexOf('id="sale-timeline-title"');
    const returns = html.indexOf('id="sale-returns-title"');
    expect(receipt).toBeGreaterThan(-1);
    expect(timeline).toBeGreaterThan(receipt);
    expect(returns).toBeGreaterThan(timeline);
  });

  it("is not in the detail of a sale with a single event", () => {
    expect(top(detail())).not.toContain("sale-timeline-title");
    expect(
      top(detail({ confirmedAt: "2026-06-10T12:00:59.000Z" }))
    ).not.toContain("Linha do tempo");
  });

  it("leaves the reason, the note and the items of the cancellation to the notice and the receipt", () => {
    const html = top(cancelled);
    expect(html.split(CANCEL_NOTE)).toHaveLength(2);
    expect(html).toContain("Motivo");
    const own = section(html);
    expect(own).toContain("Cancelada");
    for (const text of [CANCEL_NOTE, ITEM_LABEL, "Motivo", "Observação"]) {
      expect(own).not.toContain(text);
    }
  });

  it("leaves the reason, the note and the items of the returns to their card", () => {
    const html = top(twoReturns);
    expect(html.split(RETURN_NOTE)).toHaveLength(2);
    expect(html).toContain("devolvidas 1");
    const own = section(html);
    expect(own.split("Devolução")).toHaveLength(3);
    for (const text of [
      RETURN_NOTE,
      ITEM_LABEL,
      "Item com defeito",
      "devolvidas",
    ]) {
      expect(own).not.toContain(text);
    }
  });
});
