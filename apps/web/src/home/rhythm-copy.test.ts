import { beforeEach, describe, expect, it } from "vitest";
import type { PreferenceStorage } from "../lib/current-organization-model";
import {
  clearOrganizationResultCopies,
  clearPeriodSummaryCaches,
} from "../lib/period-summary-cache";
import {
  readRhythmCopy,
  todaysRhythmCopy,
  writeRhythmCopy,
} from "./rhythm-copy";

const ORG = "0199c2d0-0000-7000-8000-00000000a001";
const OTHER = "0199c2d0-0000-7000-8000-00000000a002";
const ALLOWED = { offlineRuntimeEnabled: true, signingOut: false };
const TODAY = "2026-10-23";
const PERIOD = { from: "2026-09-28", to: "2026-09-30" };
const SERIES = {
  count: [0, 2, 1],
  from: "2026-09-28",
  net: ["0.00", "130.00", "12.50"],
};

function memoryStorage() {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  return { storage, values };
}

describe("the copy of the Início's map (rhythm-copy)", () => {
  // the page's memory is one per module: each test starts without it
  beforeEach(() => clearPeriodSummaryCaches(null));

  it("reads back the series written for the organization, under its own key", () => {
    const { storage, values } = memoryStorage();
    writeRhythmCopy(storage, ORG, SERIES, TODAY, ALLOWED);

    expect([...values.keys()]).toEqual([`polaris.offline.dailySales.${ORG}`]);
    expect(readRhythmCopy(storage, ORG)).toEqual(SERIES);
    expect(readRhythmCopy(storage, OTHER)).toBeNull();
  });

  it("writes nothing with the runtime off or once sign-out started", () => {
    const { storage, values } = memoryStorage();
    writeRhythmCopy(storage, ORG, SERIES, TODAY, {
      offlineRuntimeEnabled: false,
      signingOut: false,
    });
    writeRhythmCopy(storage, ORG, SERIES, TODAY, {
      offlineRuntimeEnabled: true,
      signingOut: true,
    });

    expect(values.size).toBe(0);
  });

  it("does not keep a series that is not the server's shape, and drops a corrupt copy on reading", () => {
    const { storage, values } = memoryStorage();
    writeRhythmCopy(
      storage,
      ORG,
      { ...SERIES, count: [1] } as typeof SERIES,
      TODAY,
      ALLOWED
    );
    expect(values.size).toBe(0);

    values.set(`polaris.offline.dailySales.${ORG}`, "{not json");
    expect(readRhythmCopy(storage, ORG)).toBeNull();
    values.set(
      `polaris.offline.dailySales.${ORG}`,
      JSON.stringify({ ...SERIES, net: [0, 130, 12.5] })
    );
    expect(readRhythmCopy(storage, ORG)).toBeNull();
  });

  it("goes with the session (clearPeriodSummaryCaches) and with a refusal of the store, only that store's", () => {
    const { storage, values } = memoryStorage();
    writeRhythmCopy(storage, ORG, SERIES, TODAY, ALLOWED);
    writeRhythmCopy(storage, OTHER, SERIES, TODAY, ALLOWED);

    clearOrganizationResultCopies(storage, ORG);
    expect([...values.keys()]).toEqual([`polaris.offline.dailySales.${OTHER}`]);

    clearPeriodSummaryCaches(storage);
    expect(values.size).toBe(0);
  });

  it("is the series of today only when read on the store's today for the same period (the daily cache)", () => {
    const { storage, values } = memoryStorage();
    writeRhythmCopy(storage, ORG, SERIES, TODAY, ALLOWED);

    expect(todaysRhythmCopy(storage, ORG, PERIOD, TODAY)).toEqual(SERIES);
    // read yesterday: asked again today
    expect(todaysRhythmCopy(storage, ORG, PERIOD, "2026-10-24")).toBeNull();
    // the month turned, the period with it
    expect(
      todaysRhythmCopy(
        storage,
        ORG,
        { from: "2026-09-28", to: "2026-10-31" },
        TODAY
      )
    ).toBeNull();
    expect(todaysRhythmCopy(storage, OTHER, PERIOD, TODAY)).toBeNull();
    // a copy kept before the day of the reading existed: offline it still draws, online it is read again
    clearPeriodSummaryCaches(null);
    values.set(`polaris.offline.dailySales.${ORG}`, JSON.stringify(SERIES));
    expect(readRhythmCopy(storage, ORG)).toEqual(SERIES);
    expect(todaysRhythmCopy(storage, ORG, PERIOD, TODAY)).toBeNull();
  });

  it("with the runtime off, the day's series stays in the page's memory only, and goes with the copies", () => {
    const { storage, values } = memoryStorage();
    const off = { offlineRuntimeEnabled: false, signingOut: false };
    writeRhythmCopy(storage, ORG, SERIES, TODAY, off);
    writeRhythmCopy(null, OTHER, SERIES, TODAY, off);

    expect(values.size).toBe(0);
    expect(readRhythmCopy(storage, ORG)).toBeNull();
    expect(todaysRhythmCopy(null, ORG, PERIOD, TODAY)).toEqual(SERIES);
    expect(todaysRhythmCopy(null, ORG, PERIOD, "2026-10-24")).toBeNull();

    // the store refused this person: only its series goes; the session ended: every one
    clearOrganizationResultCopies(null, ORG);
    expect(todaysRhythmCopy(null, ORG, PERIOD, TODAY)).toBeNull();
    expect(todaysRhythmCopy(null, OTHER, PERIOD, TODAY)).toEqual(SERIES);
    clearPeriodSummaryCaches(null);
    expect(todaysRhythmCopy(null, OTHER, PERIOD, TODAY)).toBeNull();
  });

  it("once sign-out started, not even the page's memory keeps the series", () => {
    writeRhythmCopy(null, ORG, SERIES, TODAY, {
      offlineRuntimeEnabled: false,
      signingOut: true,
    });
    expect(todaysRhythmCopy(null, ORG, PERIOD, TODAY)).toBeNull();
  });

  it("does not throw without usable storage", () => {
    const refusing: PreferenceStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => undefined,
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(() =>
      writeRhythmCopy(refusing, ORG, SERIES, TODAY, ALLOWED)
    ).not.toThrow();
    expect(readRhythmCopy(refusing, ORG)).toBeNull();
    expect(readRhythmCopy(null, ORG)).toBeNull();
  });
});
