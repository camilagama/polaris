import { describe, expect, it } from "vitest";
import {
  FOLDERS,
  isComplete,
  parseDeadline,
  remainingMs,
  stateOfRun,
} from "./mutation-run";

const NOW = Date.UTC(2026, 9, 28, 8, 0, 0);

describe("parseDeadline", () => {
  it("is no limit when unset or empty", () => {
    expect(parseDeadline(undefined, NOW)).toBeNull();
    expect(parseDeadline("", NOW)).toBeNull();
  });

  it("adds the minutes to the clock it is given", () => {
    expect(parseDeadline("15", NOW)).toBe(NOW + 15 * 60_000);
    expect(parseDeadline("0.5", NOW)).toBe(NOW + 30_000);
  });

  it.each(["15min", "0", "-3", "NaN", "Infinity", " abc"])(
    "refuses %j instead of switching the limit off",
    (value) => {
      expect(parseDeadline(value, NOW)).toBe("invalid");
    }
  );
});

describe("remainingMs", () => {
  it("is null without a deadline and goes to zero or below when it passed", () => {
    expect(remainingMs(null, NOW)).toBeNull();
    expect(remainingMs(NOW + 1000, NOW)).toBe(1000);
    expect(remainingMs(NOW, NOW)).toBe(0);
    expect(remainingMs(NOW - 1, NOW)).toBe(-1);
  });
});

describe("stateOfRun", () => {
  it("tells a finished run, a run the deadline cut and a failed one apart", () => {
    expect(stateOfRun({ status: 0, timedOut: false })).toBe("complete");
    expect(stateOfRun({ status: 143, timedOut: true })).toBe("cut");
    expect(stateOfRun({ status: null, timedOut: true })).toBe("cut");
    expect(stateOfRun({ status: 1, timedOut: false })).toBe("failed");
    expect(stateOfRun({ status: null, timedOut: false })).toBe("failed");
  });
});

describe("isComplete", () => {
  const all = FOLDERS.map(() => "complete" as const);

  it("marks the commit only when the four folders, asked for together, finished", () => {
    expect(isComplete(all, true)).toBe(true);
  });

  it("does not mark a run cut or failed in any folder", () => {
    for (const state of ["cut", "failed", "not-run"] as const) {
      expect(isComplete([...all.slice(1), state], true)).toBe(false);
    }
  });

  it("does not mark a run of some folders, even when they all finished", () => {
    expect(isComplete(["complete"], false)).toBe(false);
    expect(isComplete(["complete"], true)).toBe(false);
  });
});

describe("FOLDERS", () => {
  it("are the four folders of the scope, each once", () => {
    expect([...FOLDERS].sort()).toEqual([
      "economics",
      "inventory",
      "money",
      "sales",
    ]);
  });
});
