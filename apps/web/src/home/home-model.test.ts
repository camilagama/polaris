import type { GoalReadModel } from "@polaris/contracts";
import { describe, expect, it } from "vitest";
import {
  attentionLines,
  bestDayText,
  checklistLink,
  checklistNext,
  copyStanding,
  goalDaysLeftText,
  goalPeriodShort,
  goalProjection,
  homePeriods,
  homeReads,
  lastDays,
  monthTitle,
  msUntilNextMidnight,
  newSaleOfflineText,
  offlineGoal,
  pickGoal,
  shouldRefreshOnReturn,
  storeToday,
  sumNetSales,
} from "./home-model";

type Daily = { date: string; netSales: string; salesCount: number }[];

/** Every day from `from` to `to`, with the amount and count of `pick` (zero when it gives nothing). */
function series(
  from: string,
  to: string,
  pick: (date: string) => [string, number] | undefined = () => undefined
): Daily {
  const days: Daily = [];
  for (
    let day = new Date(`${from}T00:00:00Z`);
    day <= new Date(`${to}T00:00:00Z`);
    day = new Date(day.getTime() + 86_400_000)
  ) {
    const date = day.toISOString().slice(0, 10);
    const [netSales, salesCount] = pick(date) ?? ["0.00", 0];
    days.push({ date, netSales, salesCount });
  }
  return days;
}

describe("homePeriods (§ 2.4)", () => {
  it("reads the whole month in A and, in B, the previous month up to the eve of the 1st", () => {
    expect(homePeriods("2026-10-23")).toEqual({
      before: { from: "2026-09-01", to: "2026-09-30" },
      month: { from: "2026-10-01", to: "2026-10-31" },
    });
  });

  it("starts B 29 days before today when that is before the previous month (30 days on 1 March)", () => {
    expect(homePeriods("2027-03-01")).toEqual({
      before: { from: "2027-01-31", to: "2027-02-28" },
      month: { from: "2027-03-01", to: "2027-03-31" },
    });
    expect(homePeriods("2028-03-01").before).toEqual({
      from: "2028-02-01",
      to: "2028-02-29",
    });
  });

  it("turns the year: on 1 January B starts on 1 December of the year before", () => {
    expect(homePeriods("2027-01-01")).toEqual({
      before: { from: "2026-12-01", to: "2026-12-31" },
      month: { from: "2027-01-01", to: "2027-01-31" },
    });
  });

  it("changes both periods when the month turns (31/10 to 01/11)", () => {
    expect(homePeriods("2026-10-31").month).toEqual({
      from: "2026-10-01",
      to: "2026-10-31",
    });
    expect(homePeriods("2026-11-01")).toEqual({
      before: { from: "2026-10-01", to: "2026-10-31" },
      month: { from: "2026-11-01", to: "2026-11-30" },
    });
  });

  it("knows February of 28 (2027) and of 29 days (2028)", () => {
    expect(homePeriods("2027-02-10").month.to).toBe("2027-02-28");
    expect(homePeriods("2028-02-10").month.to).toBe("2028-02-29");
  });
});

describe("the store's today and the turn of the day (§ 5.1)", () => {
  // 03:30 UTC is still the day before in Brasília (−3), Manaus (−4) and Rio Branco (−5)
  const nearMidnightUtc = Date.parse("2026-10-24T03:30:00.000Z");

  it("takes today from the server's clock in the store's zone, not from the device", () => {
    expect(storeToday("2026-10-24T02:59:00.000Z", "America/Sao_Paulo")).toBe(
      "2026-10-23"
    );
    expect(storeToday("2026-10-24T03:00:00.000Z", "America/Sao_Paulo")).toBe(
      "2026-10-24"
    );
    expect(storeToday("2026-10-24T03:30:00.000Z", "America/Manaus")).toBe(
      "2026-10-23"
    );
    expect(storeToday("2026-10-24T04:59:00.000Z", "America/Rio_Branco")).toBe(
      "2026-10-23"
    );
    expect(storeToday("2026-10-24T05:00:00.000Z", "America/Rio_Branco")).toBe(
      "2026-10-24"
    );
  });

  it("waits until the next midnight of the store's zone, plus a second", () => {
    const second = 1000;
    // Brasília is already at 00:30 of the 24th: the next midnight is 23 h 30 away
    expect(msUntilNextMidnight(nearMidnightUtc, "America/Sao_Paulo")).toBe(
      (23 * 60 + 30) * 60 * second + second
    );
    // Manaus is at 23:30 of the 23rd: half an hour
    expect(msUntilNextMidnight(nearMidnightUtc, "America/Manaus")).toBe(
      30 * 60 * second + second
    );
    // Rio Branco is at 22:30 of the 23rd: an hour and a half
    expect(msUntilNextMidnight(nearMidnightUtc, "America/Rio_Branco")).toBe(
      90 * 60 * second + second
    );
  });

  it("from 23:59 the next read is in the new day", () => {
    const at2359 = Date.parse("2026-10-24T02:59:00.000Z");
    const wait = msUntilNextMidnight(at2359, "America/Sao_Paulo");
    expect(wait).toBe(61_000);
    expect(
      storeToday(new Date(at2359 + wait).toISOString(), "America/Sao_Paulo")
    ).toBe("2026-10-24");
  });

  it("re-reads on return at most once every 30 s", () => {
    expect(shouldRefreshOnReturn(0, 29_999)).toBe(false);
    expect(shouldRefreshOnReturn(0, 30_000)).toBe(true);
  });
});

describe("the chart comes from the series of A and B (AC-17)", () => {
  const before = series("2026-09-01", "2026-09-30", (date) =>
    date >= "2026-09-25" ? ["10.00", 1] : undefined
  );
  const month = series("2026-10-01", "2026-10-31", (date) => {
    if (date === "2026-10-02") {
      return ["25.50", 2];
    }
    return date === "2026-10-23" ? ["100.10", 3] : undefined;
  });

  it("the last 7 or 30 days end today and cross into B at the start of the month", () => {
    const week = lastDays(before, month, "2026-10-03", 7);
    expect(week.map((day) => day.date)).toEqual([
      "2026-09-27",
      "2026-09-28",
      "2026-09-29",
      "2026-09-30",
      "2026-10-01",
      "2026-10-02",
      "2026-10-03",
    ]);
    expect(sumNetSales(week)).toBe("65.50");
    const thirty = lastDays(before, month, "2026-10-23", 30);
    expect(thirty).toHaveLength(30);
    expect(thirty[0]?.date).toBe("2026-09-24");
    expect(sumNetSales(thirty)).toBe("185.60");
  });

  it("the series adds up to the month's figure", () => {
    expect(sumNetSales(month)).toBe("125.60");
  });

  it("writes the best day once, and none when nothing sold", () => {
    expect(bestDayText(lastDays(before, month, "2026-10-23", 7))).toBe(
      "Melhor dia: 23/10, R$ 100,10"
    );
    expect(bestDayText(series("2026-10-01", "2026-10-07"))).toBeNull();
  });
});

describe("monthTitle (AC-6)", () => {
  it("names the month, never 'até hoje'", () => {
    expect(monthTitle("2026-10-23")).toBe("Outubro");
    expect(monthTitle("2027-03-01")).toBe("Março");
  });
});

function goal(overrides: Partial<GoalReadModel>): GoalReadModel {
  return {
    achievedValue: null,
    createdAt: "2026-10-01T12:00:00.000Z",
    endsOn: "2026-10-31",
    id: "0199c2d0-0000-7000-8000-000000000001",
    kind: "net_sales",
    name: null,
    organizationId: "org",
    paused: false,
    progress: {
      percent: "40.0",
      periodEnded: false,
      reached: false,
      value: "400.00",
    },
    settledAt: null,
    startsOn: "2026-10-01",
    status: "active",
    target: "1000.00",
    updatedAt: "2026-10-01T12:00:00.000Z",
    version: 1,
    ...overrides,
  };
}

describe("pickGoal (AC-10, AC-11, § 5.3)", () => {
  const zone = "America/Sao_Paulo";

  it("shows the active goal that ends first, with how many others", () => {
    const view = pickGoal(
      [
        goal({
          endsOn: "2026-12-31",
          id: "0199c2d0-0000-7000-8000-000000000002",
        }),
        goal({ endsOn: "2026-10-31" }),
      ],
      "2026-10-23",
      zone
    );
    expect(view).toMatchObject({ kind: "active", others: 1 });
    expect(view.kind === "active" && view.goal.endsOn).toBe("2026-10-31");
  });

  it("with none active, the last settled in the last 7 days of the store, never a cancelled one", () => {
    const settled = goal({
      achievedValue: "1200.00",
      endsOn: "2026-09-30",
      settledAt: "2026-10-01T03:10:00.000Z",
      startsOn: "2026-09-01",
      status: "completed",
    });
    const cancelled = goal({
      settledAt: null,
      status: "cancelled",
      updatedAt: "2026-10-05T12:00:00.000Z",
    });
    // settled on 01/10 of the store: shown from 01/10 to 07/10, seven days, and gone on the eighth
    expect(pickGoal([settled, cancelled], "2026-10-07", zone)).toMatchObject({
      kind: "settled",
    });
    expect(pickGoal([settled, cancelled], "2026-10-08", zone)).toEqual({
      kind: "none",
    });
    expect(pickGoal([cancelled], "2026-10-08", zone)).toEqual({ kind: "none" });
  });

  it("with no goal, none: the card offers 'Definir meta'", () => {
    expect(pickGoal([], "2026-10-23", zone)).toEqual({ kind: "none" });
  });

  it("writes the period as 'de dd/mm a dd/mm'", () => {
    expect(goalPeriodShort(goal({}))).toBe("de 01/10 a 31/10");
  });
});

describe("attentionLines (AC-12 to AC-14)", () => {
  const nothing = {
    refused: 0,
    soldWithoutCost: 0,
    unknownCost: null,
    withoutStock: { count: 0, more: false },
  };

  it("is empty when nothing needs attention (the block then says so)", () => {
    expect(attentionLines(nothing)).toEqual([]);
  });

  it("keeps the order: this device, the unknown cost, the stock; at most three", () => {
    const lines = attentionLines({
      refused: 2,
      soldWithoutCost: 4,
      unknownCost: { count: 1, more: false },
      withoutStock: { count: 3, more: false },
    });
    expect(lines).toEqual([
      {
        href: "/attention",
        id: "device",
        next: "Corrija e envie de novo.",
        text: "2 operações deste aparelho precisam de atenção",
      },
      {
        href: "/inventory?filtro=sem-custo",
        id: "unknown-cost",
        next: "Informe para as próximas vendas.",
        text: "1 variante sem custo",
      },
      {
        href: "/inventory?filtro=sem-saldo",
        id: "without-stock",
        next: "Dê entrada no estoque.",
        text: "3 variantes sem saldo",
      },
    ]);
  });

  it("says '100 ou mais' past a page (AC-13)", () => {
    expect(
      attentionLines({
        ...nothing,
        withoutStock: { count: 100, more: true },
      })[0]?.text
    ).toBe("100 ou mais variantes sem saldo");
    expect(
      attentionLines({
        ...nothing,
        withoutStock: { count: 99, more: false },
      })[0]?.text
    ).toBe("99 variantes sem saldo");
    expect(
      attentionLines({
        ...nothing,
        withoutStock: { count: 100, more: false },
      })[0]?.text
    ).toBe("100 variantes sem saldo");
  });

  it("drops the unknown cost line without the list, with an empty list, or with no sale without cost (AC-14)", () => {
    const list = { count: 30, more: false };
    expect(
      attentionLines({ ...nothing, soldWithoutCost: 1, unknownCost: null })
    ).toEqual([]);
    expect(
      attentionLines({
        ...nothing,
        soldWithoutCost: 1,
        unknownCost: { count: 0, more: false },
      })
    ).toEqual([]);
    expect(
      attentionLines({ ...nothing, soldWithoutCost: 0, unknownCost: list })
    ).toEqual([]);
    expect(
      attentionLines({ ...nothing, soldWithoutCost: 1, unknownCost: list })[0]
        ?.id
    ).toBe("unknown-cost");
  });
});

describe("checklist (AC-22, § 5.4)", () => {
  const productId = "0199c2d0-0000-7000-8000-0000000000aa";

  it("asks for the first product, then for stock on that product, then for the sale", () => {
    // the step has its own two ways (À mão, Importar planilha): no button repeats them
    expect(checklistLink(checklistNext(null, false))).toBeNull();
    expect(checklistLink(checklistNext(productId, false))).toEqual({
      href: `/products?produto=${productId}`,
      label: "Dar entrada no estoque",
    });
    expect(checklistLink(checklistNext(productId, true))).toEqual({
      href: "/sales",
      label: "Fazer a 1ª venda",
    });
  });
});

describe("homeReads (§ 2.4)", () => {
  it("the owner reads every block", () => {
    expect(homeReads("owner")).toEqual({
      goals: true,
      inventory: true,
      report: true,
      sales: true,
      unknownCost: true,
    });
  });

  it("a role with no capability reads nothing, so no block is shown", () => {
    expect(homeReads("synthetic-viewer")).toEqual({
      goals: false,
      inventory: false,
      report: false,
      sales: false,
      unknownCost: false,
    });
  });
});

describe("copyStanding (§ 7.2, AC-31)", () => {
  const READ = "2026-10-15T15:00:00.000Z";
  const HOUR = 3_600_000;
  const at = (iso: string) => Date.parse(iso);

  it("a cópia de 23 h não está desatualizada e a de 25 h está", () => {
    expect(
      copyStanding(READ, READ, at(READ) + 23 * HOUR, "America/Sao_Paulo").stale
    ).toBe(false);
    expect(
      copyStanding(READ, READ, at(READ) + 25 * HOUR, "America/Sao_Paulo").stale
    ).toBe(true);
  });

  it("a idade conta da leitura confirmada mais antiga, não da leitura do mês", () => {
    const older = "2026-10-14T10:00:00.000Z";
    expect(
      copyStanding(older, READ, at(READ) + HOUR, "America/Sao_Paulo")
    ).toMatchObject({ stale: true });
  });

  it("um relógio do aparelho 1 h antes da leitura do servidor está errado: desatualizado e sem o Hoje", () => {
    expect(
      copyStanding(READ, READ, at(READ) - HOUR, "America/Sao_Paulo")
    ).toEqual({ stale: true, todayShown: false });
  });

  it("no mesmo dia da loja o Hoje aparece", () => {
    // 17:00 in São Paulo, two hours after a read at noon of the same day
    expect(
      copyStanding(
        READ,
        READ,
        at("2026-10-15T20:00:00.000Z"),
        "America/Sao_Paulo"
      ).todayShown
    ).toBe(true);
  });

  it.each([
    [
      "America/Sao_Paulo",
      "2026-10-16T02:59:00.000Z",
      "2026-10-16T03:00:00.000Z",
    ],
    [
      "America/Rio_Branco",
      "2026-10-16T04:59:00.000Z",
      "2026-10-16T05:00:00.000Z",
    ],
    ["America/Manaus", "2026-10-16T03:59:00.000Z", "2026-10-16T04:00:00.000Z"],
  ])(
    "em %s o Hoje some na meia-noite da loja, não na do UTC",
    (zone, beforeMidnight, afterMidnight) => {
      const read = "2026-10-15T20:00:00.000Z";
      expect(
        copyStanding(read, read, at(beforeMidnight), zone).todayShown
      ).toBe(true);
      expect(copyStanding(read, read, at(afterMidnight), zone).todayShown).toBe(
        false
      );
    }
  );
});

describe("offlineGoal (§ 7.3)", () => {
  const zone = "America/Sao_Paulo";
  const active = (overrides: Partial<GoalReadModel> = {}) =>
    ({
      goal: goal({ endsOn: "2026-10-31", ...overrides }),
      kind: "active",
      others: 0,
    }) as const;

  it.each([
    ["na véspera do fim", "2026-10-30", false],
    ["no dia do fim", "2026-10-31", false],
    ["no dia seguinte ao fim", "2026-11-01", true],
  ])("meta ativa %s: ended = %s", (_label, today, ended) => {
    expect(offlineGoal(active(), today, zone)).toMatchObject({
      ended,
      kind: "active",
    });
  });

  it("meta pausada depois do fim fica como foi lida", () => {
    expect(offlineGoal(active({ paused: true }), "2026-11-05", zone)).toEqual({
      ended: false,
      goal: goal({ endsOn: "2026-10-31", paused: true }),
      kind: "active",
    });
  });

  it("sem cópia da meta, ela só vem com conexão", () => {
    expect(offlineGoal(null, "2026-10-15", zone)).toEqual({
      kind: "online-only",
    });
  });

  it("meta liquidada há 3 dias continua aparecendo, há 10 dias não", () => {
    const settled = goal({
      achievedValue: "1200.00",
      endsOn: "2026-09-30",
      settledAt: "2026-10-12T15:00:00.000Z",
      startsOn: "2026-09-01",
      status: "completed",
    });
    expect(
      offlineGoal({ goal: settled, kind: "settled" }, "2026-10-15", zone)
    ).toEqual({ goal: settled, kind: "settled" });
    expect(
      offlineGoal({ goal: settled, kind: "settled" }, "2026-10-22", zone)
    ).toEqual({ kind: "online-only" });
  });

  it("sem meta, a meta só vem com conexão", () => {
    expect(offlineGoal({ kind: "none" }, "2026-10-15", zone)).toEqual({
      kind: "online-only",
    });
  });
});

describe("newSaleOfflineText (AC-30)", () => {
  it("promete a venda sem internet só quando o aparelho pode vender", () => {
    expect(newSaleOfflineText(true)).toBe(
      "Você pode vender sem internet. A venda é enviada quando a conexão voltar."
    );
    expect(newSaleOfflineText(false)).toBe(
      "Sem internet: para vender é preciso conexão."
    );
  });
});

describe("goalDaysLeftText (v7 § 3 item 9)", () => {
  const period = { endsOn: "2026-10-31", startsOn: "2026-10-01" };

  it("counts the days after today up to the last one", () => {
    expect(goalDaysLeftText(period, "2026-10-25")).toBe("faltam 6 dias");
    expect(goalDaysLeftText(period, "2026-10-30")).toBe("falta 1 dia");
    expect(goalDaysLeftText(period, "2026-10-31")).toBe("último dia");
  });

  it("says nothing before the goal begins or after it ends", () => {
    expect(goalDaysLeftText(period, "2026-09-30")).toBeNull();
    expect(goalDaysLeftText(period, "2026-11-01")).toBeNull();
  });
});

describe("goalProjection (v7 § 3 item 9): only from what is known", () => {
  const today = "2026-10-25";
  // 18/10 to 24/10, the 7 whole days before today: R$ 100,00 and 2 sales each, R$ 700,00 and 14 sales in all
  const month = series("2026-10-01", "2026-10-31", (date) =>
    date >= "2026-10-18" && date <= "2026-10-24" ? ["100.00", 2] : undefined
  );
  const before = series("2026-09-01", "2026-09-30");
  const known = { before, month };
  // R$ 1.500,00 by default: the rhythm (R$ 1.000,00 on the 31st) falls short of it
  const g = (overrides: Partial<GoalReadModel>) =>
    goal({ target: "1500.00", ...overrides });
  // the figure of the estimate that falls short of the target
  const shortValue = (
    projection: ReturnType<typeof goalProjection>
  ): string | undefined =>
    projection?.kind === "short" ? projection.value : undefined;

  it("adds the mean of the 7 days before today for each day left, in exact cents", () => {
    // 6 days left: 400,00 + 700,00 × 6 ÷ 7 = 400,00 + 600,00
    expect(goalProjection(g({}), known, today)).toEqual({
      kind: "short",
      on: "31/10",
      value: "R$ 1.000,00",
    });
  });

  it("rounds the share of the days left half-up, once, in cents", () => {
    const odd = series("2026-10-01", "2026-10-31", (date) =>
      date === "2026-10-24" ? ["0.01", 1] : undefined
    );
    // 0,01 × 6 ÷ 7 = 0,00857… → 0,01
    expect(
      shortValue(goalProjection(g({}), { before, month: odd }, today))
    ).toBe("R$ 400,01");
    // 0,01 × 3 ÷ 7 = 0,00428… → 0,00
    expect(
      shortValue(
        goalProjection(
          g({ endsOn: "2026-10-28" }),
          { before, month: odd },
          today
        )
      )
    ).toBe("R$ 400,00");
  });

  it("projects a number of sales in sales", () => {
    const count = g({
      kind: "sale_count",
      progress: {
        percent: "50.0",
        periodEnded: false,
        reached: false,
        value: "20",
      },
      target: "40",
    });
    // 20 + 14 × 6 ÷ 7 = 32
    expect(goalProjection(count, known, today)).toEqual({
      kind: "short",
      on: "31/10",
      value: "32 vendas",
    });
  });

  it("takes the days before the month from the series before it", () => {
    const early = series("2026-10-01", "2026-10-31");
    const september = series("2026-09-01", "2026-09-30", (date) =>
      date >= "2026-09-27" ? ["70.00", 1] : undefined
    );
    // on 03/10 the 7 days are 26/09 to 02/10: 4 × 70,00 = 280,00; 28 days left → 280,00 × 28 ÷ 7 = 1.120,00
    expect(
      shortValue(
        goalProjection(
          g({ target: "2000.00" }),
          { before: september, month: early },
          "2026-10-03"
        )
      )
    ).toBe("R$ 1.520,00");
  });

  it("says nothing when the 7 days returned more than they sold, or when a value is not the server's", () => {
    const returns = series("2026-10-01", "2026-10-31", (date) =>
      date === "2026-10-20" ? ["-50.00", 0] : undefined
    );
    expect(goalProjection(g({}), { before, month: returns }, today)).toBeNull();
    const odd = {
      percent: "40.0",
      periodEnded: false,
      reached: false,
      value: "quatrocentos",
    };
    expect(goalProjection(g({ progress: odd }), known, today)).toBeNull();
    expect(
      goalProjection(g({ kind: "sale_count", progress: odd }), known, today)
    ).toBeNull();
  });

  it("says nothing for the estimated result: its rhythm needs the cost of every day", () => {
    expect(
      goalProjection(g({ kind: "operating_result" }), known, today)
    ).toBeNull();
  });

  it("says nothing without the daily series, or with a day of the 7 missing from it", () => {
    expect(
      goalProjection(g({}), { before: undefined, month }, today)
    ).toBeNull();
    expect(
      goalProjection(g({}), { before, month: undefined }, today)
    ).toBeNull();
    const gap = month.filter((day) => day.date !== "2026-10-20");
    expect(goalProjection(g({}), { before, month: gap }, today)).toBeNull();
  });

  it("says nothing for a goal paused, reached, not begun, on its last day or over", () => {
    const progress = {
      percent: "40.0",
      periodEnded: false,
      reached: false,
      value: "400.00",
    };
    expect(goalProjection(g({ paused: true }), known, today)).toBeNull();
    expect(
      goalProjection(
        g({ progress: { ...progress, reached: true } }),
        known,
        today
      )
    ).toBeNull();
    expect(
      goalProjection(
        g({ progress: { ...progress, periodEnded: true } }),
        known,
        today
      )
    ).toBeNull();
    expect(goalProjection(g({ progress: null }), known, today)).toBeNull();
    expect(
      goalProjection(g({ startsOn: "2026-10-26" }), known, today)
    ).toBeNull();
    expect(goalProjection(g({ endsOn: today }), known, today)).toBeNull();
  });

  it("says the day the rhythm crosses the target, from the daily total", () => {
    // 400,00 + 100,00 a day: 1.000,00 is crossed on the 6th day after today, 31/10, the last one; 800,00 on the 4th
    expect(goalProjection(g({ target: "800.00" }), known, today)).toEqual({
      kind: "reaches",
      on: "29/10",
      onLastDay: false,
    });
  });

  it("says 'até' when the crossing is exactly on the last day of the goal", () => {
    expect(goalProjection(g({ target: "1000.00" }), known, today)).toEqual({
      kind: "reaches",
      on: "31/10",
      onLastDay: true,
    });
    // one cent more is not reached: it falls short, by exactly one cent
    expect(goalProjection(g({ target: "1000.01" }), known, today)).toEqual({
      kind: "short",
      on: "31/10",
      value: "R$ 1.000,00",
    });
  });

  it("crosses a number of sales target on the day the projected count gets there", () => {
    const count = g({
      kind: "sale_count",
      progress: {
        percent: "50.0",
        periodEnded: false,
        reached: false,
        value: "20",
      },
      target: "26",
    });
    // 20 + 2 a day: 26 on the 3rd day after today
    expect(goalProjection(count, known, today)).toEqual({
      kind: "reaches",
      on: "28/10",
      onLastDay: false,
    });
  });

  it("says there is nothing to estimate with no sale in the 7 days", () => {
    const quiet = series("2026-10-01", "2026-10-31");
    expect(goalProjection(g({}), { before, month: quiet }, today)).toEqual({
      kind: "no_sales",
    });
    expect(
      goalProjection(
        g({
          kind: "sale_count",
          progress: {
            percent: "50.0",
            periodEnded: false,
            reached: false,
            value: "20",
          },
          target: "40",
        }),
        { before, month: quiet },
        today
      )
    ).toEqual({ kind: "no_sales" });
  });
});
