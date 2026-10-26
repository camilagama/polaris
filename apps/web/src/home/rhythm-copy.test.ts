import { describe, expect, it } from "vitest";
import type { PreferenceStorage } from "../lib/current-organization-model";
import {
  clearOrganizationResultCopies,
  clearPeriodSummaryCaches,
} from "../lib/period-summary-cache";
import { readRhythmCopy, writeRhythmCopy } from "./rhythm-copy";

const ORG = "0199c2d0-0000-7000-8000-00000000a001";
const OTHER = "0199c2d0-0000-7000-8000-00000000a002";
const ALLOWED = { offlineRuntimeEnabled: true, signingOut: false };
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
  it("reads back the series written for the organization, under its own key", () => {
    const { storage, values } = memoryStorage();
    writeRhythmCopy(storage, ORG, SERIES, ALLOWED);

    expect([...values.keys()]).toEqual([`polaris.offline.dailySales.${ORG}`]);
    expect(readRhythmCopy(storage, ORG)).toEqual(SERIES);
    expect(readRhythmCopy(storage, OTHER)).toBeNull();
  });

  it("writes nothing with the runtime off or once sign-out started", () => {
    const { storage, values } = memoryStorage();
    writeRhythmCopy(storage, ORG, SERIES, {
      offlineRuntimeEnabled: false,
      signingOut: false,
    });
    writeRhythmCopy(storage, ORG, SERIES, {
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
    writeRhythmCopy(storage, ORG, SERIES, ALLOWED);
    writeRhythmCopy(storage, OTHER, SERIES, ALLOWED);

    clearOrganizationResultCopies(storage, ORG);
    expect([...values.keys()]).toEqual([`polaris.offline.dailySales.${OTHER}`]);

    clearPeriodSummaryCaches(storage);
    expect(values.size).toBe(0);
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
    expect(() => writeRhythmCopy(refusing, ORG, SERIES, ALLOWED)).not.toThrow();
    expect(readRhythmCopy(refusing, ORG)).toBeNull();
    expect(readRhythmCopy(null, ORG)).toBeNull();
  });
});
