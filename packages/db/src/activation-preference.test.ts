import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ACTIVATION_PREFERENCE_STATEMENT,
  ACTIVATION_SET_TIPS_STATEMENT,
  parseActivationPreference,
} from "./activation-preference";

const drizzle = new URL("../drizzle/", import.meta.url);
const migrations = readdirSync(drizzle)
  .filter((name) => name.endsWith(".sql"))
  .map((name) => readFileSync(new URL(name, drizzle), "utf8"));
const READ_CREATED =
  /CREATE (?:OR REPLACE )?FUNCTION public\.activation_email_preference\(p_user text\)/;
const WRITE_CREATED =
  /CREATE (?:OR REPLACE )?FUNCTION public\.activation_set_tips\(p_user text, p_on boolean\)/;
const READ_GRANTED =
  /GRANT EXECUTE ON FUNCTION public\.activation_email_preference\(text\) TO polaris_pr11_runtime;/;
const WRITE_GRANTED =
  /GRANT EXECUTE ON FUNCTION public\.activation_set_tips\(text, boolean\) TO polaris_pr11_runtime;/;
const BILLING_GRANT =
  /GRANT EXECUTE ON FUNCTION public\.activation_(?:email_preference|set_tips)\([^)]*\) TO polaris_billing_runtime/;

describe("the preference of the tips for the session", () => {
  it("calls the two functions a migration creates, with their arguments, on the tenant runtime that executes them", () => {
    expect(migrations.filter((sql) => READ_CREATED.test(sql))).toHaveLength(1);
    expect(migrations.filter((sql) => WRITE_CREATED.test(sql))).toHaveLength(1);
    expect(migrations.some((sql) => READ_GRANTED.test(sql))).toBe(true);
    expect(migrations.some((sql) => WRITE_GRANTED.test(sql))).toBe(true);
    expect(migrations.some((sql) => BILLING_GRANT.test(sql))).toBe(false);
    expect(ACTIVATION_PREFERENCE_STATEMENT).toBe(
      "SELECT public.activation_email_preference($1::text) AS preference"
    );
    expect(ACTIVATION_SET_TIPS_STATEMENT).toBe(
      "SELECT public.activation_set_tips($1::text, $2::boolean) AS preference"
    );
  });

  it("reads the two fields of the answer and nothing else", () => {
    expect(parseActivationPreference({ sent: 2, tips: false })).toEqual({
      sent: 2,
      tips: false,
    });
    expect(parseActivationPreference({ sent: 0, tips: true })).toEqual({
      sent: 0,
      tips: true,
    });
  });

  it.each([
    ["null", null],
    ["a string", "tips"],
    ["a missing count", { tips: true }],
    ["a missing switch", { sent: 1 }],
    ["a switch that is not a boolean", { sent: 1, tips: "true" }],
    ["a negative count", { sent: -1, tips: true }],
    ["a fractional count", { sent: 1.5, tips: true }],
    ["a count as text", { sent: "1", tips: true }],
  ])("refuses %s", (_label, value) => {
    expect(() => parseActivationPreference(value)).toThrow(
      "The activation preference has an unexpected shape."
    );
  });
});
