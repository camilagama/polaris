import { readdirSync, readFileSync } from "node:fs";
import { sep } from "node:path";
import { fileURLToPath } from "node:url";
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

  it("is the map alone: no chart of the mean by weekday and no line that changes with the day read", () => {
    const html = render({ saturdays: true });
    expect(html).not.toContain("data-weekday-bars");
    expect(html).not.toContain("data-rhythm-reading");
    expect(textBetweenTags(html)).not.toContain("Média por dia da semana");
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

const TABLE = /<table[^>]*id="([^"]*)"[^>]*>[\s\S]*?<\/table>/;
const ROWS = /<tr[ >]/g;
const HIDDEN_WRAPPER =
  /<div class="[^"]*overflow-hidden[^"]*" data-chart-data-table="hidden">/;
const CAPTION =
  /<caption[^>]*>Vendas por dia, do mais novo ao mais antigo\. Meses anteriores atualizados até ontem\.<\/caption>/;
const HEADERS = /<th[^>]*scope="col"/g;
const ATTRIBUTES = /(?:aria-label|aria-valuetext|title)="[^"]*"/g;
const HEAD = /<thead[^>]*>[\s\S]*<\/thead>/;
const NEWEST_ROW = /<tbody[^>]*><tr[^>]*>([\s\S]*?)<\/tr>/;

describe("the numbers of the Ritmo, for assistive technology", () => {
  it("has no 'Ver os números' button: the days are an invisible table tied to the map", () => {
    const html = render({ saturdays: true });
    expect(textBetweenTags(html)).not.toContain("Ver os números");
    const table = html.match(TABLE);
    expect(table).not.toBeNull();
    const id = table?.[1] ?? "";
    expect(html).toContain(`data-chart-data-table="hidden"`);
    expect(html).toContain(`aria-details="${id}"`);
    expect(html).toMatch(HIDDEN_WRAPPER);
  });

  it("is a real table: a caption, a header per column and one row per day read, newest first", () => {
    const html = render({ saturdays: true });
    const table = html.match(TABLE)?.[0] ?? "";
    expect(table).toMatch(CAPTION);
    expect(table.match(HEADERS)).toHaveLength(3);
    expect(textBetweenTags(table.match(HEAD)?.[0] ?? "")).toBe(
      "DiaVendas líquidasVendas"
    );
    // the days read (the one to come is not a row), plus the header row
    expect(table.match(ROWS)).toHaveLength(182);
    const newest = textBetweenTags(table.match(NEWEST_ROW)?.[1] ?? "");
    expect(newest).toBe("23/10/2026R$ 320,102 vendas");
  });

  it("says the same numbers the map reads: today, and a day with sales", () => {
    const html = render({ saturdays: true });
    const table = html.match(TABLE)?.[0] ?? "";
    expect(textBetweenTags(table)).toContain("27/06/2026R$ 541,194 vendas");
  });

  it("holds no digit of an amount while the values are hidden, in the table, its text or the summary", () => {
    hiddenValues.hidden = true;
    const html = render({ saturdays: true });
    const table = html.match(TABLE)?.[0] ?? "";
    expect(textBetweenTags(table)).not.toMatch(MONEY_WITH_DIGIT);
    expect(table).not.toContain("541,19");
    expect(table).toContain("R$ ••••");
    expect(table).toContain("valor escondido");
  });

  it("keeps every text the block said before, in the page or in the table: only the visible list went", () => {
    const html = render({ saturdays: true });
    const text = textBetweenTags(html);
    const attributes = html.match(ATTRIBUTES)?.join(" ") ?? "";
    const everywhere = `${text} ${attributes}`;
    for (const said of [
      "Ritmo de vendas",
      "Últimas 26 semanas",
      "Sábado é o seu melhor dia da semana nas últimas 13 semanas: média de R$ 100,00.",
      "Menos",
      "Mais",
      "Vazio: sem venda · até R$",
      "Vendas por dia nas últimas 26 semanas: 26 dias com venda. Melhor dia 27/06, R$ 541,19.",
      "Meses anteriores atualizados até ontem.",
      "Dia",
      "Vendas líquidas",
      "27/06/2026",
      "sem venda",
      "Sexta, 23/10 · R$ 320,10 · 2 vendas · hoje",
    ]) {
      expect(everywhere, said).toContain(said);
    }
  });
});

const SRC = fileURLToPath(new URL("../", import.meta.url));
const PHRASE = "Ver os números";
const SOURCE_FILE = /\.tsx?$/;
const TEST_FILE = /\.test\.tsx?$/;
/** The files of `src` that say the phrase: the Início's blocks are not among them, the Resultado's go with their own change. */
const STILL_SAYING = [
  "dashboard/result-chart.tsx",
  "dashboard/result-series.ts",
];

function sayingThePhrase(files: [string, string][]) {
  return files
    .filter(([, source]) => source.includes(PHRASE))
    .map(([file]) => file)
    .sort();
}

describe("no 'Ver os números' comes back to the Início", () => {
  const files = readdirSync(SRC, { encoding: "utf8", recursive: true })
    .filter((file) => SOURCE_FILE.test(file) && !TEST_FILE.test(file))
    .map((file): [string, string] => [
      file.split(sep).join("/"),
      readFileSync(`${SRC}${file}`, "utf8"),
    ]);

  it("lists exactly the files that still say it, so one more is a failure and one less lowers the list", () => {
    expect(files.length).toBeGreaterThan(300);
    expect(sayingThePhrase(files)).toEqual(STILL_SAYING);
  });

  it("fails on a planted copy in the files of the Início, in code and in a comment", () => {
    const planted: [string, string][] = [
      ["home/home-chart.tsx", `<Button>${PHRASE}</Button>`],
      ["home/home-rhythm.tsx", `<Button>${PHRASE}</Button>`],
      ["home/home-rhythm-model.ts", `// ${PHRASE}`],
      ["ui/charts/area-chart.tsx", `/** ${PHRASE} */`],
    ];
    expect(sayingThePhrase(planted)).toEqual([
      "home/home-chart.tsx",
      "home/home-rhythm-model.ts",
      "home/home-rhythm.tsx",
      "ui/charts/area-chart.tsx",
    ]);
  });
});
