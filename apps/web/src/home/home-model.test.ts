import type { GoalReadModel } from "@polaris/contracts";
import { describe, expect, it } from "vitest";
import {
  attentionLines,
  bestDayText,
  checklistLink,
  checklistNext,
  copyStanding,
  goalPeriodShort,
  homePeriods,
  homeReads,
  lastDays,
  monthComparison,
  monthTitle,
  monthUntilToday,
  msUntilNextMidnight,
  newSaleOfflineText,
  offlineGoal,
  pickGoal,
  shouldRefreshOnReturn,
  storeToday,
  sumNetSales,
  todayFigures,
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

describe("Hoje, the miniatures and the chart come from the same series (AC-5, AC-8, AC-17)", () => {
  const before = series("2026-09-01", "2026-09-30", (date) =>
    date >= "2026-09-25" ? ["10.00", 1] : undefined
  );
  const month = series("2026-10-01", "2026-10-31", (date) => {
    if (date === "2026-10-02") {
      return ["25.50", 2];
    }
    return date === "2026-10-23" ? ["100.10", 3] : undefined;
  });

  it("Hoje is the day of today in the month's series, a day with nothing is zero", () => {
    expect(todayFigures(month, "2026-10-23")).toEqual({
      date: "2026-10-23",
      netSales: "100.10",
      salesCount: 3,
    });
    expect(todayFigures(month, "2026-10-22").netSales).toBe("0.00");
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

  it("the miniature of the Mês stops today, and the series adds up to the month's figure", () => {
    expect(monthUntilToday(month, "2026-10-23")).toHaveLength(23);
    expect(sumNetSales(month)).toBe("125.60");
  });

  it("writes the best day once, and none when nothing sold", () => {
    expect(bestDayText(lastDays(before, month, "2026-10-23", 7))).toBe(
      "Melhor dia: 23/10, R$ 100,10"
    );
    expect(bestDayText(series("2026-10-01", "2026-10-07"))).toBeNull();
  });
});

describe("monthComparison (AC-7)", () => {
  const sold =
    (amount: string, until: string) =>
    (date: string): [string, number] | undefined =>
      date <= until ? [amount, 1] : undefined;

  it("compares the net sales with the same days of the previous month", () => {
    const before = series(
      "2026-09-01",
      "2026-09-30",
      sold("10.00", "2026-09-30")
    );
    const month = series(
      "2026-10-01",
      "2026-10-31",
      sold("30.00", "2026-10-31")
    );
    // 23 days: 690,00 against 230,00
    expect(monthComparison(before, month, "2026-10-23")).toBe(
      "R$ 460,00 a mais que no mesmo período de setembro"
    );
  });

  it("says less, and the same", () => {
    const before = series(
      "2026-09-01",
      "2026-09-30",
      sold("30.00", "2026-09-30")
    );
    const less = series(
      "2026-10-01",
      "2026-10-31",
      sold("10.00", "2026-10-31")
    );
    expect(monthComparison(before, less, "2026-10-02")).toBe(
      "R$ 40,00 a menos que no mesmo período de setembro"
    );
    const same = series(
      "2026-10-01",
      "2026-10-31",
      sold("30.00", "2026-10-31")
    );
    expect(monthComparison(before, same, "2026-10-02")).toBe(
      "Igual ao mesmo período de setembro"
    );
  });

  it.each([
    // on 31 March, 1 to 28 February (2027) or 29 (2028)
    ["2027-03-31", "2027-02-01", "2027-02-28", "R$ 3,00 a mais"],
    ["2028-03-31", "2028-02-01", "2028-02-29", "R$ 2,00 a mais"],
    // 31 October against 30 days of September
    ["2026-10-31", "2026-09-01", "2026-09-30", "R$ 1,00 a mais"],
    // 30 November against 30 days of October
    ["2026-11-30", "2026-10-01", "2026-10-31", "Igual ao"],
  ])(
    "on %s compares with the previous month cut to its length",
    (today, from, to, start) => {
      const before = series(from, to, () => ["1.00", 1]);
      const first = `${today.slice(0, 7)}-01`;
      const month = series(first, today, () => ["1.00", 1]);
      expect(monthComparison(before, month, today)?.startsWith(start)).toBe(
        true
      );
    }
  );

  it("says nothing when either period has no sale: never a percent over zero", () => {
    const empty = series("2026-09-01", "2026-09-30");
    const month = series(
      "2026-10-01",
      "2026-10-31",
      sold("30.00", "2026-10-31")
    );
    expect(monthComparison(empty, month, "2026-10-23")).toBeNull();
    expect(
      monthComparison(month, series("2026-10-01", "2026-10-31"), "2026-10-23")
    ).toBeNull();
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
        text: "2 operações deste aparelho precisam de atenção",
      },
      {
        href: "/inventory?filtro=sem-custo",
        id: "unknown-cost",
        text: "1 variante sem custo. Informe para as próximas vendas.",
      },
      {
        href: "/inventory?filtro=sem-saldo",
        id: "without-stock",
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
    expect(checklistLink(checklistNext(null, false))).toEqual({
      href: "/products?novo=1",
      label: "Cadastrar produto",
    });
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
      "Você pode vender sem internet; a venda é enviada quando voltar"
    );
    expect(newSaleOfflineText(false)).toBe(
      "Sem internet: para vender é preciso conexão"
    );
  });
});
