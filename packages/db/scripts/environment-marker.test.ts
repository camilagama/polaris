import { describe, expect, it } from "vitest";
import {
  declaredEnvironment,
  type EnvironmentReadings,
  hasMarkerText,
  markerComment,
  readsAsEnvironment,
} from "./environment-marker";

const readings = (
  overrides: Partial<EnvironmentReadings>
): EnvironmentReadings => ({
  comment: null,
  current: null,
  stored: null,
  ...overrides,
});

describe("the environment marker", () => {
  it("writes the exact comment the runbook tells the owner to run", () => {
    expect(markerComment("staging")).toBe("polaris.environment=staging");
  });

  it.each(["staging", "production", "restore-drill"])(
    "accepts the exact comment for %s",
    (environment) => {
      expect(
        declaredEnvironment(readings({ comment: markerComment(environment) }))
      ).toBe(environment);
    }
  );

  it("accepts the old stored form, alone or equal to the comment", () => {
    expect(declaredEnvironment(readings({ stored: "staging" }))).toBe(
      "staging"
    );
    expect(
      declaredEnvironment(
        readings({ comment: "polaris.environment=staging", stored: "staging" })
      )
    ).toBe("staging");
  });

  it.each([
    ["a trailing space", "polaris.environment=staging "],
    ["a leading space", " polaris.environment=staging"],
    ["a capital letter", "polaris.environment=Staging"],
    ["a capital in the key", "Polaris.environment=staging"],
    ["spaces around the equal sign", "polaris.environment = staging"],
    ["a line break at the end", "polaris.environment=staging\n"],
    ["a second line", "polaris.environment=staging\nother"],
    ["another key", "polaris.env=staging"],
    ["only the name", "staging"],
    ["an empty value", "polaris.environment="],
    ["an empty comment", ""],
  ])(
    "does not take a comment with %s as a marker (control: the exact one is)",
    (_label, comment) => {
      expect(declaredEnvironment(readings({ comment }))).toBeNull();
      expect(
        declaredEnvironment(
          readings({ comment: "polaris.environment=staging" })
        )
      ).toBe("staging");
    }
  );

  it("names another environment for a name that only starts like staging, so it is not staging", () => {
    for (const value of [
      readings({ comment: "polaris.environment=staging-x" }),
      readings({ stored: "staging-x" }),
    ]) {
      expect(declaredEnvironment(value)).toBe("staging-x");
      expect(declaredEnvironment(value)).not.toBe("staging");
    }
  });

  it("does not take a missing marker, or the session alone, as a marker", () => {
    expect(declaredEnvironment(readings({}))).toBeNull();
    expect(declaredEnvironment(readings({ current: "staging" }))).toBeNull();
  });

  it("does not take a stored value with other case or spaces as a marker", () => {
    expect(declaredEnvironment(readings({ stored: " Staging " }))).toBeNull();
  });

  it("refuses the readings that disagree", () => {
    expect(
      declaredEnvironment(
        readings({
          comment: "polaris.environment=staging",
          stored: "production",
        })
      )
    ).toBeNull();
    expect(
      declaredEnvironment(
        readings({
          comment: "polaris.environment=staging",
          current: "production",
        })
      )
    ).toBeNull();
  });

  it("reads a refusal through case and spaces, from any reading", () => {
    const refused = ["production", "staging", "restore-drill"];
    expect(
      readsAsEnvironment(readings({ current: " Production " }), refused)
    ).toBe(true);
    expect(readsAsEnvironment(readings({ stored: "STAGING" }), refused)).toBe(
      true
    );
    for (const comment of [
      "polaris.environment=restore-drill",
      "POLARIS.ENVIRONMENT=Production",
      " polaris.environment=staging ",
    ]) {
      expect(readsAsEnvironment(readings({ comment }), refused)).toBe(true);
    }
  });

  it("does not refuse what names no listed environment (control)", () => {
    const refused = ["production", "staging", "restore-drill"];
    for (const value of [
      readings({}),
      readings({ comment: "default administrative connection database" }),
      readings({ comment: "production" }),
      readings({ comment: "polaris.environment=staging-x" }),
      readings({ current: "gate" }),
    ]) {
      expect(readsAsEnvironment(value, refused)).toBe(false);
    }
  });

  it("sees marker text only where there is some", () => {
    expect(hasMarkerText(readings({}))).toBe(false);
    expect(
      hasMarkerText(
        readings({ comment: "default administrative connection database" })
      )
    ).toBe(false);
    expect(hasMarkerText(readings({ comment: "polaris.environment=x" }))).toBe(
      true
    );
    expect(hasMarkerText(readings({ comment: "Polaris.Environment" }))).toBe(
      true
    );
    expect(hasMarkerText(readings({ stored: "x" }))).toBe(true);
    expect(hasMarkerText(readings({ current: "x" }))).toBe(true);
  });
});
