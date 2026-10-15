import type { PeriodSummaryReadModel } from "@polaris/contracts";
import { describe, expect, it } from "vitest";
import type { PreferenceStorage } from "./current-organization-model";
import {
  clearPeriodSummaryCaches,
  readPeriodSummaryCache,
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
): PeriodSummaryReadModel => ({
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
