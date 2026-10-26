import { describe, expect, it } from "vitest";
import type { PreferenceStorage } from "./current-organization-model";
import {
  clearOrganizationResultCopies,
  clearPeriodSummaryCaches,
  isPeriodSummary,
  readPeriodSummaryCache,
  type StoredPeriodSummary,
  writePeriodSummaryCache,
} from "./period-summary-cache";

const ORG = "0199c2d0-0000-7000-8000-00000000a001";
const OTHER = "0199c2d0-0000-7000-8000-00000000a002";
const ALLOWED = { offlineRuntimeEnabled: true, signingOut: false };

/** A summary of `month` read by the server at `generatedAt`. */
const summaryOf = (
  month: string,
  generatedAt = `${month}-28T12:00:00.000Z`,
  netSales = "130.00"
): StoredPeriodSummary => ({
  cards: {
    items: 3,
    marginPercent: "52.69",
    netSales,
    operatingResult: "38.50",
    salesCount: 2,
    ticket: "65.00",
  },
  chain: {
    anticipationFees: "0.00",
    cogs: "60.00",
    commercialSurcharges: "5.00",
    contributionMargin: "68.50",
    discounts: "10.00",
    estimatedOperatingResult: "38.50",
    grossProfit: "70.00",
    grossSales: "150.00",
    linkedExpenses: "2.00",
    netSales,
    operatingExpenses: "30.00",
    processingFees: "4.50",
    returns: "10.00",
  },
  generatedAt,
  period: { from: `${month}-01`, to: `${month}-28` },
  quality: {
    anticipationFeesUnknown: 0,
    itemLines: 2,
    itemLinesWithUnknownCost: 0,
    level: "complete",
    linkedExpenses: 1,
    missing: [],
    operatingExpenses: 1,
    processingFeesUnknown: 0,
    salesCount: 2,
  },
});

function memoryStorage() {
  const values = new Map<string, string>();
  const storage: PreferenceStorage & Pick<Storage, "key" | "length"> = {
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
  return { storage, values };
}

const keyOf = (organizationId: string, month: string) =>
  `polaris.offline.periodSummary.${organizationId}.${month}`;

describe("the last confirmed result kept for opening the dashboard without a connection", () => {
  it("reads back what was written, per organization and per month", () => {
    const { storage } = memoryStorage();
    writePeriodSummaryCache(
      storage,
      ORG,
      "2026-10",
      summaryOf("2026-10"),
      ALLOWED
    );

    expect(readPeriodSummaryCache(storage, ORG, "2026-10")).toEqual(
      summaryOf("2026-10")
    );
    expect(readPeriodSummaryCache(storage, ORG, "2026-09")).toBeNull();
    expect(readPeriodSummaryCache(storage, OTHER, "2026-10")).toBeNull();
  });

  it("never offers the copy of another month, even under the wrong key", () => {
    const { storage, values } = memoryStorage();
    writePeriodSummaryCache(
      storage,
      ORG,
      "2026-09",
      summaryOf("2026-09"),
      ALLOWED
    );
    values.set(
      keyOf(ORG, "2026-10"),
      values.get(keyOf(ORG, "2026-09")) as string
    );

    expect(readPeriodSummaryCache(storage, ORG, "2026-10")).toBeNull();
  });

  it("drops a copy that is not the shape the screen reads", () => {
    const { storage, values } = memoryStorage();
    const broken = (change: (summary: Record<string, unknown>) => void) => {
      const summary = structuredClone(
        summaryOf("2026-10")
      ) as unknown as Record<string, unknown>;
      change(summary);
      values.set(
        keyOf(ORG, "2026-10"),
        JSON.stringify({ month: "2026-10", summary })
      );
      return readPeriodSummaryCache(storage, ORG, "2026-10");
    };

    expect(broken(() => undefined)).not.toBeNull();
    expect(
      broken((summary) => {
        summary.generatedAt = undefined;
      })
    ).toBeNull();
    expect(
      broken((summary) => {
        summary.generatedAt = "yesterday";
      })
    ).toBeNull();
    expect(
      broken((summary) => {
        summary.chain = undefined;
      })
    ).toBeNull();
    expect(
      broken((summary) => {
        (summary.cards as Record<string, unknown>).netSales = 130;
      })
    ).toBeNull();
    expect(
      broken((summary) => {
        (summary.cards as Record<string, unknown>).items = -1;
      })
    ).toBeNull();
    expect(
      broken((summary) => {
        (summary.quality as Record<string, unknown>).level = "great";
      })
    ).toBeNull();
    expect(
      broken((summary) => {
        (summary.quality as Record<string, unknown>).missing = ["nothing"];
      })
    ).toBeNull();
    expect(
      broken((summary) => {
        summary.period = { from: "2026-09-01", to: "2026-09-30" };
      })
    ).toBeNull();

    // a date that does not exist is not read as the next month's day
    for (const date of ["2026-13-45", "2026-02-30", "2026-04-31"]) {
      expect(
        broken((summary) => {
          summary.period = { from: "2026-10-01", to: date };
        })
      ).toBeNull();
    }
    // text that is not money or a percent is not a copy: a sum or a figure on screen would break on it
    for (const [group, field, text] of [
      ["cards", "netSales", "R$ 130,00"],
      ["cards", "operatingResult", "38.505"],
      ["cards", "ticket", "sem ticket"],
      ["cards", "marginPercent", "52,69%"],
      ["chain", "cogs", "<b>60</b>"],
      ["chain", "grossSales", ""],
    ] as const) {
      expect(
        broken((summary) => {
          (summary[group] as Record<string, unknown>)[field] = text;
        })
      ).toBeNull();
    }
    expect(
      broken((summary) => {
        (summary.cards as Record<string, unknown>).marginPercent = null;
        (summary.cards as Record<string, unknown>).ticket = null;
      })
    ).not.toBeNull();

    values.set(keyOf(ORG, "2026-10"), "{not json");
    expect(readPeriodSummaryCache(storage, ORG, "2026-10")).toBeNull();
    values.set(keyOf(ORG, "2026-10"), "[]");
    expect(readPeriodSummaryCache(storage, ORG, "2026-10")).toBeNull();
  });

  it("does not write a summary that is not the expected shape, or a month that is not one", () => {
    const { storage, values } = memoryStorage();
    writePeriodSummaryCache(
      storage,
      ORG,
      "2026-10",
      { ...summaryOf("2026-10"), generatedAt: "x" },
      ALLOWED
    );
    writePeriodSummaryCache(
      storage,
      ORG,
      "2026-13",
      summaryOf("2026-10"),
      ALLOWED
    );
    writePeriodSummaryCache(
      storage,
      ORG,
      "october",
      summaryOf("2026-10"),
      ALLOWED
    );
    expect(values.size).toBe(0);
  });

  it("keeps the last six months of an organization and drops the oldest read", () => {
    const { storage, values } = memoryStorage();
    // written out of order: the oldest read is the one dropped, not the first written
    for (const month of [
      "2026-04",
      "2026-10",
      "2026-05",
      "2026-06",
      "2026-07",
      "2026-08",
      "2026-09",
    ]) {
      writePeriodSummaryCache(storage, ORG, month, summaryOf(month), ALLOWED);
    }
    writePeriodSummaryCache(
      storage,
      OTHER,
      "2026-04",
      summaryOf("2026-04"),
      ALLOWED
    );

    expect(
      [...values.keys()].filter((key) => key.includes(ORG)).sort()
    ).toEqual(
      ["2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"].map(
        (month) => keyOf(ORG, month)
      )
    );
    expect(readPeriodSummaryCache(storage, ORG, "2026-04")).toBeNull();
    // another organization has its own six
    expect(readPeriodSummaryCache(storage, OTHER, "2026-04")).not.toBeNull();
  });

  it("replaces a month with its newer read instead of keeping both", () => {
    const { storage, values } = memoryStorage();
    writePeriodSummaryCache(
      storage,
      ORG,
      "2026-10",
      summaryOf("2026-10"),
      ALLOWED
    );
    writePeriodSummaryCache(
      storage,
      ORG,
      "2026-10",
      summaryOf("2026-10", "2026-10-29T08:00:00.000Z", "140.00"),
      ALLOWED
    );

    expect(values.size).toBe(1);
    expect(
      readPeriodSummaryCache(storage, ORG, "2026-10")?.cards.netSales
    ).toBe("140.00");
  });

  it("writes nothing when the offline runtime is off or sign-out has started", () => {
    const { storage, values } = memoryStorage();
    writePeriodSummaryCache(storage, ORG, "2026-10", summaryOf("2026-10"), {
      offlineRuntimeEnabled: false,
      signingOut: false,
    });
    writePeriodSummaryCache(storage, ORG, "2026-10", summaryOf("2026-10"), {
      offlineRuntimeEnabled: true,
      signingOut: true,
    });
    expect(values.size).toBe(0);
  });

  it("clears every summary and nothing else", () => {
    const { storage, values } = memoryStorage();
    writePeriodSummaryCache(
      storage,
      ORG,
      "2026-10",
      summaryOf("2026-10"),
      ALLOWED
    );
    writePeriodSummaryCache(
      storage,
      OTHER,
      "2026-09",
      summaryOf("2026-09"),
      ALLOWED
    );
    values.set("polaris.offline.paymentProfiles.x", "[]");
    values.set("polaris.preferredOrganizationId", ORG);

    clearPeriodSummaryCaches(storage);

    expect([...values.keys()].sort()).toEqual([
      "polaris.offline.paymentProfiles.x",
      "polaris.preferredOrganizationId",
    ]);
    expect(() => clearPeriodSummaryCaches(null)).not.toThrow();
  });

  it("does not throw without usable storage", () => {
    const refusing: PreferenceStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("quota");
      },
    };
    expect(() =>
      writePeriodSummaryCache(
        refusing,
        ORG,
        "2026-10",
        summaryOf("2026-10"),
        ALLOWED
      )
    ).not.toThrow();
    expect(() =>
      writePeriodSummaryCache(
        null,
        ORG,
        "2026-10",
        summaryOf("2026-10"),
        ALLOWED
      )
    ).not.toThrow();
    expect(readPeriodSummaryCache(refusing, ORG, "2026-10")).toBeNull();
    expect(readPeriodSummaryCache(null, ORG, "2026-10")).toBeNull();
    expect(() => clearPeriodSummaryCaches(refusing)).not.toThrow();
  });
});

describe("the daily series and the ranking in a kept summary", () => {
  const PRODUCT = "0199c2d0-0000-7000-8000-00000000b001";
  const withSeries = (): StoredPeriodSummary => ({
    ...summaryOf("2026-10"),
    daily: Array.from({ length: 28 }, (_, index) => ({
      date: `2026-10-${String(index + 1).padStart(2, "0")}`,
      netSales: index === 0 ? "130.00" : "0.00",
      salesCount: index === 0 ? 2 : 0,
    })),
    topProducts: [
      {
        deleted: false,
        name: "Camiseta",
        netSales: "130.00",
        productId: PRODUCT,
        quantity: 3,
      },
    ],
  });

  it("accepts a copy written before the series existed, and one with the series and the ranking", () => {
    expect(isPeriodSummary(summaryOf("2026-10"))).toBe(true);
    expect(isPeriodSummary(withSeries())).toBe(true);
    const { storage } = memoryStorage();
    writePeriodSummaryCache(storage, ORG, "2026-10", withSeries(), ALLOWED);
    expect(readPeriodSummaryCache(storage, ORG, "2026-10")).toEqual(
      withSeries()
    );
  });

  it.each([
    ["a series that is not a list", { daily: "130.00" }],
    ["an empty series", { daily: [] }],
    [
      "a series that skips a day",
      {
        daily: withSeries().daily?.filter((day) => day.date !== "2026-10-10"),
      },
    ],
    [
      "a series with a day past the end of the period",
      {
        daily: [
          ...(withSeries().daily ?? []),
          { date: "2026-10-29", netSales: "0.00", salesCount: 0 },
        ],
      },
    ],
    [
      "a period that starts on an impossible date",
      { period: { from: "2026-13-45", to: "2026-10-28" } },
    ],
    [
      "a series that stops before the end of the period",
      { daily: withSeries().daily?.slice(0, 27) },
    ],
    [
      "a day with a negative count",
      {
        daily: withSeries().daily?.map((day, index) =>
          index === 3 ? { ...day, salesCount: -1 } : day
        ),
      },
    ],
    [
      "a day with an amount that is not text",
      {
        daily: withSeries().daily?.map((day, index) =>
          index === 3 ? { ...day, netSales: 0 } : day
        ),
      },
    ],
    [
      "a period that ends on a date that is not one",
      { period: { from: "2026-10-01", to: "x" } },
    ],
    [
      "a day with an amount that is not money",
      {
        daily: withSeries().daily?.map((day, index) =>
          index === 3 ? { ...day, netSales: "abc" } : day
        ),
      },
    ],
    [
      "a day with an amount of three decimals",
      {
        daily: withSeries().daily?.map((day, index) =>
          index === 3 ? { ...day, netSales: "1.234" } : day
        ),
      },
    ],
    ["a ranking that is not a list", { topProducts: {} }],
    [
      "a ranked product without an ID",
      {
        topProducts: [
          { deleted: false, name: "x", netSales: "1.00", quantity: 1 },
        ],
      },
    ],
    [
      "a ranked product with no units",
      {
        topProducts: [
          {
            deleted: false,
            name: "x",
            netSales: "0.00",
            productId: PRODUCT,
            quantity: 0,
          },
        ],
      },
    ],
  ])("refuses %s, and the screen falls back to no copy", (_label, broken) => {
    const malformed = { ...withSeries(), ...broken };
    expect(isPeriodSummary(malformed)).toBe(false);
    const { storage, values } = memoryStorage();
    values.set(
      keyOf(ORG, "2026-10"),
      JSON.stringify({ month: "2026-10", summary: malformed })
    );
    expect(readPeriodSummaryCache(storage, ORG, "2026-10")).toBeNull();
  });
});

describe("the costs of the day in the kept series", () => {
  const dayOf = (index: number) => ({
    date: `2026-10-${String(index + 1).padStart(2, "0")}`,
    netSales: "0.00",
    salesCount: 0,
  });
  const withDay = (day: Record<string, unknown>): unknown => ({
    ...summaryOf("2026-10"),
    daily: Array.from({ length: 28 }, (_, index) =>
      index === 3 ? { ...dayOf(index), ...day } : dayOf(index)
    ),
  });

  it.each([
    ["a copy written before the costs of the day", {}],
    [
      "costs and result as money",
      { costs: "1850.50", operatingResult: "-12.5" },
    ],
    ["costs and result unknown", { costs: null, operatingResult: null }],
    ["costs only", { costs: "0.00" }],
    ["operating expenses as money", { operatingExpenses: "62.34" }],
    [
      "operating expenses filled while costs are unknown",
      { costs: null, operatingExpenses: "50.00", operatingResult: null },
    ],
  ])("accepts %s", (_label, day) => {
    expect(isPeriodSummary(withDay(day))).toBe(true);
  });

  it.each([
    ["costs that are a number", { costs: 0 }],
    ["costs that are not money", { costs: "abc" }],
    ["costs of three decimals", { costs: "1.234" }],
    ["costs that are empty text", { costs: "" }],
    ["operating expenses that are null", { operatingExpenses: null }],
    ["operating expenses that are a number", { operatingExpenses: 0 }],
    ["operating expenses that are not money", { operatingExpenses: "1,50" }],
    ["operating expenses of three decimals", { operatingExpenses: "1.234" }],
    ["a result that is a boolean", { operatingResult: false }],
    ["a result that is not money", { operatingResult: "1,50" }],
  ])("refuses %s", (_label, day) => {
    expect(isPeriodSummary(withDay(day))).toBe(false);
  });

  it("keeps an unknown day as null, never as zero, through the device storage", () => {
    const summary = withDay({ costs: null, operatingResult: null });
    const { storage } = memoryStorage();
    writePeriodSummaryCache(
      storage,
      ORG,
      "2026-10",
      summary as StoredPeriodSummary,
      ALLOWED
    );
    const read = readPeriodSummaryCache(storage, ORG, "2026-10");
    expect(read?.daily?.[3]).toMatchObject({
      costs: null,
      operatingResult: null,
    });
  });
});

describe("a day's amount in the kept series", () => {
  it.each(["-12.5", "320.10", "0", "-0.01"])("accepts %s", (netSales) => {
    const summary: StoredPeriodSummary = {
      ...summaryOf("2026-10"),
      daily: Array.from({ length: 28 }, (_, index) => ({
        date: `2026-10-${String(index + 1).padStart(2, "0")}`,
        netSales: index === 3 ? netSales : "0.00",
        salesCount: 0,
      })),
    };
    expect(isPeriodSummary(summary)).toBe(true);
  });
});

describe("the costs of the day in the kept series (AC-9)", () => {
  const withCosts = (
    costs: (index: number) => unknown,
    operatingResult: (index: number) => unknown = () => "0.00"
  ) =>
    ({
      ...summaryOf("2026-10"),
      daily: Array.from({ length: 28 }, (_, index) => ({
        costs: costs(index),
        date: `2026-10-${String(index + 1).padStart(2, "0")}`,
        netSales: "0.00",
        operatingResult: operatingResult(index),
        salesCount: 0,
      })),
    }) as unknown;

  it("accepts the costs as money, as unknown (null) or absent", () => {
    expect(isPeriodSummary(withCosts(() => "12.30"))).toBe(true);
    expect(
      isPeriodSummary(withCosts((index) => (index === 4 ? null : "0.00")))
    ).toBe(true);
    expect(
      isPeriodSummary(
        withCosts(
          () => undefined,
          () => undefined
        )
      )
    ).toBe(true);
    // one field known and the other absent is still a shape the screen reads (it draws neither)
    expect(
      isPeriodSummary(
        withCosts(
          () => "5.00",
          () => undefined
        )
      )
    ).toBe(true);
  });

  it.each([
    ["a number", 12.3],
    ["text that is not money", "abc"],
    ["three decimals", "1.234"],
    ["an empty text", ""],
    ["a boolean", false],
    ["an object", {}],
  ])("refuses costs that are %s", (_label, value) => {
    expect(
      isPeriodSummary(withCosts((index) => (index === 2 ? value : "1.00")))
    ).toBe(false);
    expect(
      isPeriodSummary(
        withCosts(
          () => "1.00",
          (index) => (index === 2 ? value : "1.00")
        )
      )
    ).toBe(false);
  });

  it("keeps the costs and the unknown days through a write and a read", () => {
    const summary = withCosts((index) =>
      index === 4 ? null : "3.50"
    ) as StoredPeriodSummary;
    const { storage } = memoryStorage();
    writePeriodSummaryCache(storage, ORG, "2026-10", summary, ALLOWED);
    const read = readPeriodSummaryCache(storage, ORG, "2026-10");
    expect(read).toEqual(summary);
    expect(read?.daily?.[4]?.costs).toBeNull();
  });
});

describe("forgetting the copies of one organization (clearOrganizationResultCopies)", () => {
  it("removes the months and the Início's copies (blocks and map) of that organization only", () => {
    const { storage, values } = memoryStorage();
    for (const organization of [ORG, OTHER]) {
      writePeriodSummaryCache(
        storage,
        organization,
        "2026-10",
        summaryOf("2026-10"),
        ALLOWED
      );
      writePeriodSummaryCache(
        storage,
        organization,
        "2026-09",
        summaryOf("2026-09"),
        ALLOWED
      );
      values.set(`polaris.offline.home.${organization}`, "{}");
      values.set(`polaris.offline.dailySales.${organization}`, "{}");
    }
    values.set("polaris.offline.paymentProfiles.x", "[]");
    values.set("polaris.preferredOrganizationId", ORG);

    clearOrganizationResultCopies(storage, ORG);

    expect([...values.keys()].sort()).toEqual([
      `polaris.offline.dailySales.${OTHER}`,
      `polaris.offline.home.${OTHER}`,
      "polaris.offline.paymentProfiles.x",
      keyOf(OTHER, "2026-09"),
      keyOf(OTHER, "2026-10"),
      "polaris.preferredOrganizationId",
    ]);
  });

  it("does not throw without usable storage", () => {
    expect(() => clearOrganizationResultCopies(null, ORG)).not.toThrow();
    const refusing: PreferenceStorage = {
      getItem: () => null,
      removeItem: () => {
        throw new Error("blocked");
      },
      setItem: () => undefined,
    };
    expect(() => clearOrganizationResultCopies(refusing, ORG)).not.toThrow();
  });
});
