import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ACTIVATION_OPT_OUT_STATEMENT } from "./activation-opt-out";

const drizzle = new URL("../drizzle/", import.meta.url);
const CREATED =
  /CREATE (?:OR REPLACE )?FUNCTION public\.activation_record_opt_out\(p_user text\)/;
const GRANTED =
  /GRANT EXECUTE ON FUNCTION public\.activation_record_opt_out\(text\) TO polaris_billing_runtime;/;

describe("the write of the page that stops the tips", () => {
  it("calls the function a migration creates, with its one text argument, on the role that executes it", () => {
    const migrations = readdirSync(drizzle)
      .filter((name) => name.endsWith(".sql"))
      .map((name) => readFileSync(new URL(name, drizzle), "utf8"));

    expect(migrations.filter((sql) => CREATED.test(sql))).toHaveLength(1);
    expect(migrations.some((sql) => GRANTED.test(sql))).toBe(true);
    expect(ACTIVATION_OPT_OUT_STATEMENT).toBe(
      "SELECT public.activation_record_opt_out($1::text)"
    );
  });
});
