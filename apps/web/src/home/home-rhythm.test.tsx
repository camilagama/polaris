import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { addDays } from "./home-model";
import { rhythmPeriod, weekdayOf } from "./home-rhythm-model";
import type { HomeFigures } from "./use-home";

const hiddenValues = vi.hoisted(() => ({ hidden: false }));

// the server snapshot of the hook says "shown": the choice of the device is set here
vi.mock("../lib/hidden-values", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/hidden-values")>()),
  useHiddenValues: () => [hiddenValues.hidden, () => undefined],
}));

const { RhythmBlock } = await import("./home-rhythm");

// Friday `23/10/2026`: the 26 weeks go from Sunday `26/04` to today, the 181st day shown (index 180)
const TODAY = "2026-10-23";
const BEST_DAY = "2026-06-27";
const TODAY_INDEX = 180;
const RANGE = /<input[^>]*type="range"[^>]*>/;
const NO_RETRY = () => undefined;
const MONEY_WITH_DIGIT = /R\$ \d/;
const READING_OF_TODAY = "Sexta, 23/10 · R$ 320,10 · 2 vendas · hoje";

/** The net sales and the count of a day: the best day, a Saturday of the weekly rhythm, today, or nothing. */
function figuresOf(
  best: boolean,
  saturday: boolean,
  today: boolean
): [string, number] {
  if (best) {
    return ["541.19", 4];
  }
  if (today) {
    return ["320.10", 2];
  }
  return saturday ? ["100.00", 1] : ["0.00", 0];
}

function render({
  saturdays = false,
  sold = true,
}: {
  saturdays?: boolean;
  sold?: boolean;
} = {}) {
  const { from, to } = rhythmPeriod(TODAY);
  const net: string[] = [];
  const count: number[] = [];
  for (let date = from; date <= to; date = addDays(date, 1)) {
    const saturday = saturdays && weekdayOf(date) === 6;
    const best = sold && date === BEST_DAY;
    const [netSales, salesCount] = figuresOf(best, saturday, false);
    net.push(netSales);
    count.push(salesCount);
  }
  const daily: Array<{ date: string; netSales: string; salesCount: number }> =
    [];
  for (
    let date = `${TODAY.slice(0, 7)}-01`;
    date <= TODAY;
    date = addDays(date, 1)
  ) {
    const today = sold && date === TODAY;
    const saturday = saturdays && weekdayOf(date) === 6;
    daily.push({
      date,
      netSales: figuresOf(false, saturday, today)[0],
      salesCount: figuresOf(false, saturday, today)[1],
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
  it("says what only the rhythm knows over the map, not the day of today", () => {
    const html = render({ saturdays: true });
    expect(html).not.toContain("data-rhythm-reading");
    expect(textOf(html, "data-rhythm-insight")).toBe(
      "Sábado é o seu melhor dia da semana nas últimas 13 semanas: média de R$ 100,00."
    );
    expect(textBetweenTags(html)).not.toContain("23/10 · R$");
  });

  it("keeps the few-weeks warning in the line of the insight, not in a line of its own", () => {
    const html = render();
    expect(textOf(html, "data-rhythm-insight")).toBe(
      "Poucas semanas de vendas ainda: o mapa enche conforme você vende. 1 dia com venda nas últimas 13 semanas."
    );
    expect(html.match(/data-rhythm-insight/g)).toHaveLength(1);
  });

  it("puts the keyboard control and the finger on today, which the control says though the line does not", () => {
    const range = render().match(RANGE)?.[0] ?? "";
    expect(range).toContain(`value="${TODAY_INDEX}"`);
    expect(range).toContain(`max="${TODAY_INDEX}"`);
    expect(range).toContain(`aria-valuetext="${READING_OF_TODAY}"`);
  });

  it("says 'sem venda · hoje' in the control when today has no sale, though the line does not read it", () => {
    const html = render({ sold: false });
    expect(html).not.toContain("data-rhythm-reading");
    expect(html.match(RANGE)?.[0]).toContain(
      'aria-valuetext="Sexta, 23/10 · sem venda · hoje"'
    );
  });

  it("has no best-day line and no ranges in reais at rest: the ranges are in the (i) and the title of the legend", () => {
    const html = render({ saturdays: true });
    expect(html).not.toContain("data-rhythm-best");
    expect(textBetweenTags(html)).not.toContain("Vazio: sem venda");
    expect(html).toContain('title="Vazio: sem venda · até ');
    expect(textBetweenTags(html)).toContain("Menos");
    expect(textBetweenTags(html)).toContain("Mais");
  });

  it("masks the amounts of the legend title with the values hidden, and keeps the summary as it is", () => {
    hiddenValues.hidden = true;
    const html = render();
    expect(html).not.toContain("541,19");
    expect(html).toContain('title="Vazio: sem venda · até R$ ••••');
    // the summary already says "valor escondido" for the amount
    expect(html).toContain("Melhor dia 27/06, valor escondido.");
  });

  it("masks the amount of the weekday insight with the values hidden, and the value of today in the control", () => {
    hiddenValues.hidden = true;
    const html = render({ saturdays: true });
    const insight = textOf(html, "data-rhythm-insight") ?? "";
    expect(insight).toBe(
      "Sábado é o seu melhor dia da semana nas últimas 13 semanas: média de R$ ••••valor escondido."
    );
    expect(insight).not.toMatch(MONEY_WITH_DIGIT);
    expect(html).not.toContain("100,00");
    const range = html.match(RANGE)?.[0] ?? "";
    expect(range).toContain("valor escondido");
    expect(range).not.toContain("320,10");
  });
});
