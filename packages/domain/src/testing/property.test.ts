import { integer, property } from "fast-check";
import { describe, expect, it } from "vitest";
import {
  assertProperty,
  DEFAULT_PROPERTY_RUNS,
  DEFAULT_PROPERTY_SEED,
  propertyReplayHint,
  propertySettings,
} from "./property";

describe("the property test settings", () => {
  it("uses few runs and a fixed seed by default", () => {
    expect(propertySettings({})).toEqual({
      numRuns: DEFAULT_PROPERTY_RUNS,
      seed: DEFAULT_PROPERTY_SEED,
    });
    expect(
      propertySettings({
        POLARIS_PROPERTY_RUNS: "",
        POLARIS_PROPERTY_SEED: " ",
      })
    ).toEqual({ numRuns: DEFAULT_PROPERTY_RUNS, seed: DEFAULT_PROPERTY_SEED });
  });

  it("takes the runs and the seed from the environment", () => {
    expect(
      propertySettings({
        POLARIS_PROPERTY_RUNS: "5000",
        POLARIS_PROPERTY_SEED: "-42",
      })
    ).toEqual({ numRuns: 5000, seed: -42 });
  });

  it("draws a new seed on request", () => {
    const { seed } = propertySettings({ POLARIS_PROPERTY_SEED: "random" });
    expect(Number.isInteger(seed)).toBe(true);
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
      { POLARIS_PROPERTY_RUNS: "37" }
    );
    expect(cases).toBe(37);
  });

  it("generates the same cases for the same seed", () => {
    const run = (seed: string) => {
      const seen: number[] = [];
      assertProperty(
        property(integer(), (value) => {
          seen.push(value);
          return true;
        }),
        { POLARIS_PROPERTY_RUNS: "20", POLARIS_PROPERTY_SEED: seed }
      );
      return seen;
    };
    expect(run("7")).toEqual(run("7"));
    expect(run("7")).not.toEqual(run("8"));
  });

  it("prints the seed and the replay line when a property fails", () => {
    const failing = () =>
      assertProperty(
        property(integer(), (value) => value < 0),
        { POLARIS_PROPERTY_RUNS: "50", POLARIS_PROPERTY_SEED: "123" }
      );
    expect(failing).toThrow("seed: 123");
    expect(failing).toThrow(propertyReplayHint({ numRuns: 50, seed: 123 }));
  });
});
