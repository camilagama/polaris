import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GUARDRAIL_GROUPS } from "../e2e-pwa/ui-guardrails/groups";

const GROUP_FILE = /^telas-\d+\.e2e\.ts$/;
const REGISTRATION = /registerScreenChecks\(\d+\)/g;

const folder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../e2e-pwa/ui-guardrails"
);

describe("ui-guardrails split", () => {
  it("has one telas-NN file per group, each registering its own group", () => {
    const files = readdirSync(folder)
      .filter((name) => GROUP_FILE.test(name))
      .sort();
    const expected = Array.from(
      { length: GUARDRAIL_GROUPS },
      (_, index) => `telas-${String(index + 1).padStart(2, "0")}.e2e.ts`
    );
    expect(files).toEqual(expected);
    for (const [index, name] of expected.entries()) {
      const source = readFileSync(path.join(folder, name), "utf8");
      expect(source.match(REGISTRATION)).toEqual([
        `registerScreenChecks(${index + 1})`,
      ]);
    }
  });
});
