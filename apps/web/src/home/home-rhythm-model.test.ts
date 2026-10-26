import { describe, expect, it } from "vitest";
import { addDays } from "./home-model";
import {
  type DailySeries,
  isDailySeries,
  RHYTHM_WEEKS,
  type RhythmDay,
  rhythmDays,
  rhythmInsight,
  rhythmPeriod,
  rhythmRangesText,
  rhythmReading,
  rhythmReadingText,
  rhythmStart,
  rhythmSummary,
  rhythmView,
  weekdayOf,
} from "./home-rhythm-model";

// Sunday 25/10/2026: the 26 weeks start on Sunday 03/05/2026
const TODAY = "2026-10-25";

/** The series the server returns for the period of `today`, with a value per date. */
function seriesFor(
  today: string,
  value: (date: string) => [string, number] = () => ["0.00", 0]
): DailySeries {
  const { from, to } = rhythmPeriod(today);
  const net: string[] = [];
  const count: number[] = [];
  for (let date = from; date <= to; date = addDays(date, 1)) {
    const [amount, sales] = value(date);
    net.push(amount);
    count.push(sales);
  }
  return { count, from, net };
}

function monthFor(
  today: string,
  value: (date: string) => [string, number] = () => ["0.00", 0]
) {
  const days: RhythmDay[] = [];
  for (
    let date = `${today.slice(0, 7)}-01`;
    date <= today;
    date = addDays(date, 1)
  ) {
    const [netSales, salesCount] = value(date);
    days.push({ date, netSales, salesCount });
  }
  return days;
}

describe("the period of the map", () => {
  it("reads from the first Sunday of the 26 weeks to the eve of the month, within the 182 days of the contract", () => {
    expect(rhythmStart(TODAY)).toBe("2026-05-03");
    expect(weekdayOf(rhythmStart(TODAY))).toBe(0);
    expect(rhythmPeriod(TODAY)).toEqual({
      from: "2026-05-03",
      to: "2026-09-30",
    });
    // a Saturday, the last day of its week, and the first of a month
    for (const today of [
      "2026-10-31",
      "2026-11-01",
      "2026-03-01",
      "2026-12-31",
    ]) {
      const { from, to } = rhythmPeriod(today);
      const days = (Date.parse(to) - Date.parse(from)) / 86_400_000 + 1;
      expect(weekdayOf(from), today).toBe(0);
      expect(days, today).toBeLessThanOrEqual(182);
      expect(from <= to, today).toBe(true);
    }
  });

  it("13 weeks on a phone start 12 weeks before the Sunday of this week", () => {
    expect(rhythmStart(TODAY, 13)).toBe("2026-08-02");
    expect(rhythmStart("2026-10-24", 13)).toBe("2026-07-26");
  });
});

describe("the series as the server sends it", () => {
  it("accepts one entry per date of the period, with money and counts", () => {
    const series = seriesFor(TODAY);
    expect(isDailySeries(series, rhythmPeriod(TODAY))).toBe(true);
    expect(isDailySeries(series)).toBe(true);
  });

  it("refuses another period, a short series, a mismatch, a number for money or a negative count", () => {
    const series = seriesFor(TODAY);
    const period = rhythmPeriod(TODAY);
    expect(isDailySeries({ ...series, from: "2026-05-04" }, period)).toBe(
      false
    );
    expect(
      isDailySeries(
        { ...series, count: series.count.slice(1), net: series.net.slice(1) },
        period
      )
    ).toBe(false);
    expect(isDailySeries({ ...series, count: series.count.slice(1) })).toBe(
      false
    );
    expect(
      isDailySeries({ ...series, net: [12, ...series.net.slice(1)] })
    ).toBe(false);
    expect(
      isDailySeries({ ...series, count: [-1, ...series.count.slice(1)] })
    ).toBe(false);
    expect(isDailySeries({ ...series, from: "2026-02-30" })).toBe(false);
    expect(isDailySeries(null)).toBe(false);
    expect(isDailySeries("<html>")).toBe(false);
  });
});

describe("one series from two sources (rhythmDays)", () => {
  it("takes the days before the month from the light series and the month from the figures", () => {
    const series = seriesFor(TODAY, (date) =>
      date === "2026-09-30" ? ["10.00", 1] : ["0.00", 0]
    );
    const month = monthFor(TODAY, (date) =>
      date === TODAY ? ["320.10", 4] : ["0.00", 0]
    );
    const days = rhythmDays(series, month, TODAY);
    expect(days).not.toBeNull();
    expect(days?.[0]?.date).toBe("2026-05-03");
    expect(days?.at(-1)).toEqual({
      date: TODAY,
      netSales: "320.10",
      salesCount: 4,
    });
    expect(days?.find((day) => day.date === "2026-09-30")?.netSales).toBe(
      "10.00"
    );
    expect(days).toHaveLength(176);
  });

  it("is null, never zeros, when a day is missing from its source", () => {
    const series = seriesFor(TODAY);
    // the month without today
    expect(rhythmDays(series, monthFor("2026-10-24"), TODAY)).toBeNull();
    // a series that starts after the first Sunday (a copy of another period)
    expect(
      rhythmDays(
        {
          ...series,
          count: series.count.slice(1),
          from: "2026-05-04",
          net: series.net.slice(1),
        },
        monthFor(TODAY),
        TODAY
      )
    ).toBeNull();
    // a series that ends before the eve of the month
    expect(
      rhythmDays(
        {
          ...series,
          count: series.count.slice(0, -1),
          net: series.net.slice(0, -1),
        },
        monthFor(TODAY),
        TODAY
      )
    ).toBeNull();
  });

  it("a series that starts earlier still serves (a copy read the day before)", () => {
    const yesterday = seriesFor("2026-10-24");
    expect(rhythmDays(yesterday, monthFor(TODAY), TODAY)).toHaveLength(176);
  });
});

/** Days from the first Sunday of `weeks` weeks to today with the given values in cents (zero elsewhere). */
function daysWith(values: Record<string, [string, number]>): RhythmDay[] {
  const days: RhythmDay[] = [];
  for (let date = rhythmStart(TODAY); date <= TODAY; date = addDays(date, 1)) {
    const [netSales, salesCount] = values[date] ?? ["0.00", 0];
    days.push({ date, netSales, salesCount });
  }
  return days;
}

describe("the map of the weeks shown (rhythmView)", () => {
  it("has a cell per day of the weeks from Sunday, the days to come with nothing in them", () => {
    const view = rhythmView(daysWith({}), RHYTHM_WEEKS);
    expect(view.cells).toHaveLength(26 * 7);
    expect(view.cells[0]?.date).toBe("2026-05-03");
    expect(view.today).toBe(175);
    expect(view.cells[175]?.date).toBe(TODAY);
    // Monday 26 to Saturday 31 are to come: never a zero
    expect(view.cells.slice(176).every((cell) => cell.netSales === null)).toBe(
      true
    );
    expect(view.best).toBeNull();
    expect(view.thresholds).toBeNull();
    expect(view.cells[0]?.level).toBe(0);
  });

  it("puts the store's days in four levels by its own quartiles; a day with no sale is level 0", () => {
    // eight days that sold: 10, 20, ..., 80 reais
    const values: Record<string, [string, number]> = {};
    for (let index = 1; index <= 8; index += 1) {
      values[addDays("2026-10-01", index)] = [`${index * 10}.00`, 1];
    }
    const view = rhythmView(daysWith(values), RHYTHM_WEEKS);
    // sorted 10..80: the 25th is the 3rd (30), the 50th the 5th (50), the 75th the 7th (70)
    expect(view.thresholds).toEqual(["30.00", "50.00", "70.00"]);
    const levelOf = (date: string) =>
      view.cells.find((cell) => cell.date === date)?.level;
    expect(levelOf("2026-10-02")).toBe(1); // 10
    expect(levelOf("2026-10-04")).toBe(1); // 30: up to the top of level 1
    expect(levelOf("2026-10-05")).toBe(2); // 40
    expect(levelOf("2026-10-07")).toBe(3); // 60
    expect(levelOf("2026-10-09")).toBe(4); // 80
    expect(levelOf("2026-10-01")).toBe(0);
    expect(rhythmRangesText(view)).toBe(
      "Vazio: sem venda · até R$ 30,00 · até R$ 50,00 · até R$ 70,00 · acima"
    );
  });

  it("with fewer than four days that sold, the levels are quarters of the best day", () => {
    const view = rhythmView(
      daysWith({ "2026-10-10": ["100.01", 2] }),
      RHYTHM_WEEKS
    );
    // 25.0025, 50.005 and 75.0075 rounded half-up in cents
    expect(view.thresholds).toEqual(["25.00", "50.01", "75.01"]);
    expect(view.cells.find((cell) => cell.date === "2026-10-10")?.level).toBe(
      4
    );
  });

  it("the best day is the first with the highest net sales; returns (net below zero) are level 0", () => {
    const view = rhythmView(
      daysWith({
        "2026-10-03": ["412.40", 5],
        "2026-10-10": ["412.40", 3],
        "2026-10-12": ["-15.00", 1],
      }),
      RHYTHM_WEEKS
    );
    expect(view.cells[view.best ?? -1]?.date).toBe("2026-10-03");
    expect(view.cells.find((cell) => cell.date === "2026-10-12")?.level).toBe(
      0
    );
  });

  it("13 weeks take only the last 13 weeks, levels and best day included", () => {
    const view = rhythmView(
      daysWith({ "2026-06-01": ["900.00", 9], "2026-10-20": ["50.00", 1] }),
      13
    );
    expect(view.cells).toHaveLength(91);
    expect(view.cells[0]?.date).toBe("2026-08-02");
    expect(view.cells[view.best ?? -1]?.date).toBe("2026-10-20");
    expect(view.today).toBe(84);
  });

  it("the mean by weekday divides by the days of that weekday shown, half-up, and names the best", () => {
    // every Saturday of the 26 weeks sold 100.00 but one, which sold 100.05; one Monday sold 10.00
    const values: Record<string, [string, number]> = {};
    for (let date = "2026-05-09"; date <= TODAY; date = addDays(date, 7)) {
      values[date] = ["100.00", 2];
    }
    values["2026-10-17"] = ["100.05", 2];
    values["2026-10-19"] = ["10.00", 1];
    const view = rhythmView(daysWith(values), RHYTHM_WEEKS);
    // 25 Saturdays up to 24/10 (31/10 is to come): (2500.05 / 25) = 100.002 → 100.00
    expect(view.weekdays.means[6]).toBe("100.00");
    // 25 Mondays shown, 04/05 to 19/10 (26/10 is to come): 10 / 25 = 0.40
    expect(view.weekdays.means[1]).toBe("0.40");
    expect(view.weekdays.best).toBe(6);
    expect(view.soldWeeks).toBe(25);
    expect(rhythmInsight(view)).toEqual({
      kind: "weekday",
      text: "Sábado é o seu melhor dia da semana: média de R$ 100,00.",
    });
  });

  it("with few weeks of sales the sentence says the map fills up, with the days that sold", () => {
    const view = rhythmView(
      daysWith({ "2026-10-20": ["50.00", 1], "2026-10-21": ["20.00", 1] }),
      RHYTHM_WEEKS
    );
    expect(view.soldWeeks).toBe(1);
    expect(rhythmInsight(view)).toEqual({
      detail: "2 dias com venda até agora.",
      kind: "few",
      text: "Poucas semanas de vendas ainda: o mapa enche conforme você vende.",
    });
  });
});

describe("the reading of a day and the summary", () => {
  const view = rhythmView(
    daysWith({
      "2026-10-17": ["412.40", 5],
      "2026-10-18": ["12.00", 1],
      "2026-10-24": ["30.00", 1],
    }),
    RHYTHM_WEEKS
  );
  const indexOf = (date: string) =>
    view.cells.findIndex((cell) => cell.date === date);

  it("says the weekday, the date, the amount, the sales and whether it is the best day or today", () => {
    expect(rhythmReading(view, indexOf("2026-10-17"))).toEqual({
      day: "Sábado, 17/10",
      note: "melhor dia",
      value: "R$ 412,40 · 5 vendas",
    });
    expect(
      rhythmReadingText(
        rhythmReading(view, indexOf("2026-10-18")) ?? {
          day: "",
          note: null,
          value: "",
        }
      )
    ).toBe("Domingo, 18/10 · R$ 12,00 · 1 venda");
    expect(rhythmReading(view, view.today)).toEqual({
      day: "Domingo, 25/10",
      note: "hoje",
      value: "sem venda",
    });
  });

  it("a day to come or out of the map has no reading", () => {
    expect(rhythmReading(view, view.today + 1)).toBeNull();
    expect(rhythmReading(view, 999)).toBeNull();
  });

  it("the summary says in words what the map shows; the numbers are in the table", () => {
    expect(rhythmSummary(view)).toBe(
      "Vendas por dia nas últimas 26 semanas: 3 dias com venda. Melhor dia 17/10, R$ 412,40. Os números estão em Ver os números."
    );
    expect(rhythmSummary(rhythmView(daysWith({}), 13))).toBe(
      "Vendas por dia nas últimas 13 semanas: nenhum dia com venda."
    );
  });
});
