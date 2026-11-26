import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ACTIVATION_EMAIL_EVENT_STATEMENT,
  parseActivationEmailEventOutcome,
} from "./activation-email-events";

const drizzle = new URL("../drizzle/", import.meta.url);
const migrations = readdirSync(drizzle)
  .filter((name) => name.endsWith(".sql"))
  .map((name) => readFileSync(new URL(name, drizzle), "utf8"));
const CREATED =
  /CREATE (?:OR REPLACE )?FUNCTION public\.activation_record_email_event\(p_event_id text, p_kind text, p_key_id text, p_hmacs bytea\[\]\)/;
const GRANTED =
  /GRANT EXECUTE ON FUNCTION public\.activation_record_email_event\(text, text, text, bytea\[\]\) TO polaris_billing_runtime;/;
const OTHER_GRANT =
  /GRANT EXECUTE ON FUNCTION public\.activation_record_email_event\([^)]*\) TO (?!polaris_billing_runtime)/;

describe("the write of the provider's webhook", () => {
  it("calls the function a migration creates, with its four arguments, on the billing runtime that executes it", () => {
    expect(migrations.filter((sql) => CREATED.test(sql))).toHaveLength(1);
    expect(migrations.some((sql) => GRANTED.test(sql))).toBe(true);
    expect(migrations.some((sql) => OTHER_GRANT.test(sql))).toBe(false);
    expect(ACTIVATION_EMAIL_EVENT_STATEMENT).toContain(
      "public.activation_record_email_event("
    );
    expect(ACTIVATION_EMAIL_EVENT_STATEMENT).toContain("$4::text[]");
  });

  it("reads the two shapes of the answer", () => {
    expect(parseActivationEmailEventOutcome({ duplicate: true })).toEqual({
      duplicate: true,
    });
    expect(
      parseActivationEmailEventOutcome({
        duplicate: false,
        stopped: true,
        suppressed: 2,
      })
    ).toEqual({ duplicate: false, stopped: true, suppressed: 2 });
  });

  it.each([
    ["no answer", null],
    ["a text", "duplicate"],
    ["an empty object", {}],
    ["a fresh event without counts", { duplicate: false }],
    ["a negative count", { duplicate: false, stopped: false, suppressed: -1 }],
    [
      "a count that is not an integer",
      { duplicate: false, stopped: false, suppressed: 1.5 },
    ],
    [
      "a stop that is not a flag",
      { duplicate: false, stopped: "yes", suppressed: 0 },
    ],
  ])("refuses %s as a fault of the database", (_label, answer) => {
    expect(() => parseActivationEmailEventOutcome(answer)).toThrow(
      "The activation email event has an unexpected shape."
    );
  });
});
