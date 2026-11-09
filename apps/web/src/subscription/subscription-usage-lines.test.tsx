import type { BillingPlanView } from "@polaris/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PlanCard } from "./subscription-parts";

const PLAN: BillingPlanView = {
  accessEndsAt: null,
  cycleMonths: null,
  kept: { historyMonths: 3, products: 18, sales: 47 },
  limits: { goals: 3, images: 50, variants: 50 },
  method: null,
  nextCharge: null,
  offer: {
    methods: ["card", "pix_automatic"],
    prices: [
      { amount: "24.90", cycleMonths: 1 },
      { amount: "249.00", cycleMonths: 12 },
    ],
  },
  recovery: null,
  refund: null,
  refundPending: false,
  refundWindowEndedOn: null,
  renewalCancelled: false,
  resubscribeFrom: null,
  state: "free",
  trialAvailable: true,
  usage: { goals: 4, images: 12, variants: 26 },
};

const HEADLINE = { badge: null, support: null, title: "Plano Free" };

function render(plan: BillingPlanView = PLAN): string {
  return renderToStaticMarkup(<PlanCard headline={HEADLINE} plan={plan} />);
}

const PARAGRAPHS = /<p class="[^"]*">(.*?)<\/p>/g;
const CLASSES = /<(?:div|p)\b[^>]*?\bclass="([^"]*)"/g;
const BOX_CLASS = /\b(border|ring|shadow|rounded-lg|uppercase)\b/;
const PROGRESS_LABELS = /role="progressbar"[^>]*aria-label="([^"]*)"/g;

function progressNames(html: string): string[] {
  return [...html.matchAll(PROGRESS_LABELS)].map((found) => found[1] ?? "");
}

describe("the three usage lines of the Assinatura", () => {
  it("keep the numbers and the accessible name of each bar", () => {
    const html = render();
    expect(progressNames(html)).toEqual([
      "Variantes: 26 de 50",
      "Imagens: 12 de 50",
      "Metas em andamento: 4 de 3, acima do limite",
    ]);
    const rows = [...html.matchAll(PARAGRAPHS)].map((found) => found[1] ?? "");
    expect(rows.some((row) => row === "Variantes")).toBe(true);
    expect(rows.some((row) => row === "Imagens")).toBe(true);
    expect(rows.some((row) => row === "Metas em andamento")).toBe(true);
    expect(html).toContain(">26</span> de 50</span>");
    expect(html).toContain(">12</span> de 50</span>");
    expect(html).toContain(">4</span> de 3</span>");
    expect(html).toContain(">acima do limite</span>");
  });

  it("have no box of their own: no border, no ring, no rounded block, no capital letters", () => {
    const html = render();
    const start = html.indexOf("data-usage-lines");
    const end = html.indexOf("O que a sua loja", start);
    const classes = [...html.slice(start, end).matchAll(CLASSES)].map(
      (found) => found[1] ?? ""
    );
    expect(classes.length).toBeGreaterThanOrEqual(9);
    for (const value of classes) {
      expect(value).not.toMatch(BOX_CLASS);
    }
  });

  it("read the label, then the number, then the bar", () => {
    const html = render();
    const label = html.indexOf(">Variantes<");
    const number = html.indexOf(">26<");
    const bar = html.indexOf("Variantes: 26 de 50");
    expect(label).toBeGreaterThan(-1);
    expect(label).toBeLessThan(number);
    expect(number).toBeLessThan(bar);
  });

  it("draw only the number, with no bar, for a limit that does not exist", () => {
    const html = render({ ...PLAN, limits: { ...PLAN.limits, goals: null } });
    expect(progressNames(html)).toHaveLength(2);
    expect(html).toContain(">Metas em andamento<");
  });
});
