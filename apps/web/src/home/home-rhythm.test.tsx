import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { addDays } from "./home-model";
import { rhythmPeriod } from "./home-rhythm-model";
import type { HomeFigures } from "./use-home";

const hiddenValues = vi.hoisted(() => ({ hidden: false }));

// the server snapshot of the hook says "shown": the choice of the device is set here
vi.mock("../lib/hidden-values", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/hidden-values")>()),
  useHiddenValues: () => [hiddenValues.hidden, () => undefined],
}));

const { RhythmBlock } = await import("./home-rhythm");

// Friday 23/10/2026: the 26 weeks go from Sunday 26/04 to today, the 181st day shown (index 180)
const TODAY = "2026-10-23";
const BEST_DAY = "2026-06-27";
const TODAY_INDEX = 180;
const RANGE = /<input[^>]*type="range"[^>]*>/;
const NO_RETRY = () => undefined;
const READING_OF_TODAY = "Sexta, 23/10 · R$ 320,10 · 2 vendas · hoje";

function render({ sold = true }: { sold?: boolean } = {}) {
  const { from, to } = rhythmPeriod(TODAY);
  const net: string[] = [];
  const count: number[] = [];
  for (let date = from; date <= to; date = addDays(date, 1)) {
    const best = sold && date === BEST_DAY;
    net.push(best ? "541.19" : "0.00");
    count.push(best ? 4 : 0);
  }
  const daily: Array<{ date: string; netSales: string; salesCount: number }> =
    [];
  for (
    let date = `${TODAY.slice(0, 7)}-01`;
    date <= TODAY;
    date = addDays(date, 1)
  ) {
    const today = sold && date === TODAY;
    daily.push({
      date,
      netSales: today ? "320.10" : "0.00",
      salesCount: today ? 2 : 0,
    });
  }
  const figures = { month: { daily }, today: TODAY } as unknown as HomeFigures;
  return renderToStaticMarkup(
    <RhythmBlock
      figures={figures}
      onRetry={NO_RETRY}
      source={{ data: { count, from, net }, status: "copy" }}
    />
  );
}

/** The text of a piece of markup: what is outside the tags (read one character at a time, no pattern to get wrong). */
function textBetweenTags(markup: string) {
  let text = "";
  let inTag = false;
  for (const char of markup) {
    if (char === "<") {
      inTag = true;
    } else if (char === ">") {
      inTag = false;
    } else if (!inTag) {
      text += char;
    }
  }
  return text;
}

/** The text of the paragraph that carries `attribute` (null when there is none). */
function textOf(html: string, attribute: string) {
  const match = html.match(new RegExp(`<p[^>]*${attribute}[^>]*>(.*?)</p>`));
  return match?.[1] === undefined ? null : textBetweenTags(match[1]);
}

beforeEach(() => {
  hiddenValues.hidden = false;
});

describe("Ritmo de vendas at rest", () => {
  it("reads today, not the best day of the months before", () => {
    const reading = textOf(render(), "data-rhythm-reading");
    expect(reading).toBe(READING_OF_TODAY);
    expect(reading).not.toContain("27/06");
  });

  it("reads today without a sale as 'sem venda'", () => {
    expect(textOf(render({ sold: false }), "data-rhythm-reading")).toBe(
      "Sexta, 23/10 · sem venda · hoje"
    );
  });

  it("puts the keyboard control and the finger on today", () => {
    const range = render().match(RANGE)?.[0] ?? "";
    expect(range).toContain(`value="${TODAY_INDEX}"`);
    expect(range).toContain(`max="${TODAY_INDEX}"`);
    expect(range).toContain(`aria-valuetext="${READING_OF_TODAY}"`);
  });

  it("says the best day on a line of its own, under the legend", () => {
    const html = render();
    expect(textOf(html, "data-rhythm-best")).toBe(
      "Melhor dia: 27/06, R$ 541,19"
    );
    expect(html.indexOf("data-rhythm-best")).toBeGreaterThan(
      html.indexOf("Mais</span>")
    );
  });

  it("has no best-day line when no day sold", () => {
    expect(render({ sold: false })).not.toContain("data-rhythm-best");
  });

  it("masks the amounts of the reading and of the best-day line with the values hidden, and keeps the summary as it is", () => {
    hiddenValues.hidden = true;
    const html = render();
    const best = textOf(html, "data-rhythm-best");
    expect(best).toContain("Melhor dia: 27/06, ");
    expect(best).not.toContain("541");
    expect(textOf(html, "data-rhythm-reading")).not.toContain("320,10");
    expect(textOf(html, "data-rhythm-reading")).toContain("2 vendas");
    expect(html).not.toContain("541,19");
    // the summary already says "valor escondido" for the amount
    expect(html).toContain("Melhor dia 27/06, valor escondido.");
  });
});
