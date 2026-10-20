import { integer, property } from "fast-check";
import { describe, expect, it } from "vitest";
import {
  assertProperty,
  DEFAULT_PROPERTY_RUNS,
  DEFAULT_PROPERTY_SEED,
  minimumSeen,
  propertyReplayHint,
  propertySettings,
} from "./property";

describe("the property test settings", () => {
  it("uses 300 runs and a fixed seed by default", () => {
    expect(DEFAULT_PROPERTY_RUNS).toBe(300);
    expect(propertySettings({})).toEqual({
      numRuns: DEFAULT_PROPERTY_RUNS,
      seed: DEFAULT_PROPERTY_SEED,
      source: "fixed",
    });
    expect(
      propertySettings({
        GITHUB_SHA: " ",
        POLARIS_PROPERTY_RUNS: "",
        POLARIS_PROPERTY_SEED: " ",
      })
    ).toEqual({
      numRuns: DEFAULT_PROPERTY_RUNS,
      seed: DEFAULT_PROPERTY_SEED,
      source: "fixed",
    });
  });

  it("takes the runs and the seed from the environment", () => {
    expect(
      propertySettings({
        POLARIS_PROPERTY_RUNS: "5000",
        POLARIS_PROPERTY_SEED: "-42",
      })
    ).toEqual({ numRuns: 5000, seed: -42, source: "environment" });
  });

  it("seeds from the commit in CI, so each commit explores other cases and the same commit repeats them", () => {
    const sha = "69dbbed1c2f0a9b8e7d6c5b4a39281706f5e4d3c";
    const settings = propertySettings({ GITHUB_SHA: sha });
    expect(settings).toEqual({
      numRuns: DEFAULT_PROPERTY_RUNS,
      seed: 0x69_db_be_d1 % 2 ** 31,
      source: "commit",
    });
    expect(propertySettings({ GITHUB_SHA: sha }).seed).toBe(settings.seed);
    expect(
      propertySettings({ GITHUB_SHA: `dafa56d${sha.slice(7)}` }).seed
    ).not.toBe(settings.seed);
    expect(settings.seed).toBeLessThan(2 ** 31);
    expect(settings.seed).toBeGreaterThanOrEqual(0);
  });

  it("lets an explicit seed win over the commit", () => {
    expect(
      propertySettings({
        GITHUB_SHA: "69dbbed1c2f0a9b8",
        POLARIS_PROPERTY_SEED: "7",
      })
    ).toMatchObject({ seed: 7, source: "environment" });
  });

  it("draws a new seed on request", () => {
    const { seed } = propertySettings({ POLARIS_PROPERTY_SEED: "random" });
    expect(Number.isInteger(seed)).toBe(true);
  });

  it("never runs below the floor of a property, whatever the environment says", () => {
    expect(propertySettings({}, 500).numRuns).toBe(500);
    expect(
      propertySettings({ POLARIS_PROPERTY_RUNS: "100" }, 500).numRuns
    ).toBe(500);
    expect(
      propertySettings({ POLARIS_PROPERTY_RUNS: "5000" }, 500).numRuns
    ).toBe(5000);
    expect(propertySettings({}, 100).numRuns).toBe(DEFAULT_PROPERTY_RUNS);
  });

  it("refuses a value it cannot read instead of falling back", () => {
    for (const runs of ["0", "-1", "1.5", "many"]) {
      expect(() => propertySettings({ POLARIS_PROPERTY_RUNS: runs })).toThrow(
        "POLARIS_PROPERTY_RUNS"
      );
    }
    for (const seed of ["1.5", "abc", "99999999999"]) {
      expect(() => propertySettings({ POLARIS_PROPERTY_SEED: seed })).toThrow(
        "POLARIS_PROPERTY_SEED"
      );
    }
    for (const sha of ["xyz", "12", "not a sha"]) {
      expect(() => propertySettings({ GITHUB_SHA: sha })).toThrow("GITHUB_SHA");
    }
  });
});

describe("minimumSeen", () => {
  it("is five at the default size and shrinks with a quick pass, but never reaches zero", () => {
    expect(minimumSeen({})).toBe(5);
    expect(minimumSeen({ POLARIS_PROPERTY_RUNS: "40" })).toBe(2);
    for (const runs of ["1", "5", "19"]) {
      expect(minimumSeen({ POLARIS_PROPERTY_RUNS: runs })).toBe(1);
    }
  });
});

describe("assertProperty", () => {
  it("runs exactly numRuns cases", () => {
    let cases = 0;
    assertProperty(
      property(integer(), () => {
        cases += 1;
        return true;
      }),
      { environment: { POLARIS_PROPERTY_RUNS: "37" } }
    );
    expect(cases).toBe(37);
  });

  it("runs the floor of the property when the environment asks for less", () => {
    let cases = 0;
    assertProperty(
      property(integer(), () => {
        cases += 1;
        return true;
      }),
      { environment: { POLARIS_PROPERTY_RUNS: "10" }, minRuns: 50 }
    );
    expect(cases).toBe(50);
  });

  it("generates the same cases for the same seed", () => {
    const run = (seed: string) => {
      const seen: number[] = [];
      assertProperty(
        property(integer(), (value) => {
          seen.push(value);
          return true;
        }),
        {
          environment: {
            POLARIS_PROPERTY_RUNS: "20",
            POLARIS_PROPERTY_SEED: seed,
          },
        }
      );
      return seen;
    };
    expect(run("7")).toEqual(run("7"));
    expect(run("7")).not.toEqual(run("8"));
  });

  it("prints the seed and a replay line with the real file path when a property fails", () => {
    const failing = () =>
      assertProperty(
        property(integer(), (value) => value < 0),
        {
          environment: {
            POLARIS_PROPERTY_RUNS: "50",
            POLARIS_PROPERTY_SEED: "123",
          },
        }
      );
    const path = "packages/domain/src/testing/property.test.ts";
    expect(failing).toThrow("seed: 123");
    expect(failing).toThrow(
      propertyReplayHint({ numRuns: 50, seed: 123 }, path)
    );
    expect(failing).not.toThrow("<file>");
  });
});
