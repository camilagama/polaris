import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { MissingInput } from "../dashboard/missing-input";
import { unknownDaysFit, unknownDaysText } from "./home-kpis";

/**
 * `e2e/dashboard.e2e.ts` writes the rule of the "N de M dias sem custo" line (the limit and the text) by hand, because
 * importing `home/home-kpis.ts` from `e2e/` pulls the `@/` alias in, which the `tsconfig.node.json` that type-checks that
 * folder does not have. This test reads the copy from the source and holds it to the app: the limit is the one
 * `unknownDaysFit` enforces and the text is the one `unknownDaysText` writes, so the e2e cannot keep proving a rule the
 * app no longer has.
 */
const E2E_SOURCE = readFileSync(
  fileURLToPath(new URL("../../e2e/dashboard.e2e.ts", import.meta.url)),
  "utf8"
);

const WORD_INPUT = { custo: "cost", taxa: "fee" } as const satisfies Record<
  string,
  MissingInput
>;

const MONTHS = Array.from({ length: 12 }, (_, index) =>
  new Date(Date.UTC(2025, index, 1)).toLocaleDateString("pt-BR", {
    month: "long",
    timeZone: "UTC",
  })
).flatMap((name, index) => [name, `${name} de 202${index % 2 === 0 ? 5 : 4}`]);

const LIMIT_DECLARATION = /const UNKNOWN_DAYS_MAX_CHARS = (\d+);/g;
const LINE_DECLARATION =
  /const unknownDaysLine = \(([^)]*)\)\s*=>\s*(`[^`]*`);/g;

type UnknownDaysLine = (
  month: string,
  unknown: number,
  total: number,
  word: "custo" | "taxa"
) => string;

function copiedLimit(source: string): number {
  const found = [...source.matchAll(LIMIT_DECLARATION)];
  expect(found, "UNKNOWN_DAYS_MAX_CHARS declarado uma vez").toHaveLength(1);
  return Number(found[0]?.[1]);
}

function copiedLine(source: string): UnknownDaysLine {
  const found = [...source.matchAll(LINE_DECLARATION)];
  expect(found, "unknownDaysLine declarada uma vez").toHaveLength(1);
  const names = (found[0]?.[1] ?? "")
    .split(",")
    .map((parameter) => parameter.split(":")[0]?.trim() ?? "")
    .filter((name) => name !== "");
  expect(names).toEqual(["month", "unknown", "total", "word"]);
  return new Function(...names, `return ${found[0]?.[2]};`) as UnknownDaysLine;
}

function appLengthsByFit(): { fit: number[]; unfit: number[] } {
  const fit: number[] = [];
  const unfit: number[] = [];
  for (const month of MONTHS) {
    for (const input of ["cost", "fee"] as const) {
      for (const total of [1, 9, 10, 31, 99]) {
        for (const unknown of [1, total]) {
          const missing = { input, month, total, unknown };
          (unknownDaysFit(missing) ? fit : unfit).push(
            unknownDaysText(missing).length
          );
        }
      }
    }
  }
  return { fit, unfit };
}

function expectLimitIsTheApps(source: string): void {
  const limit = copiedLimit(source);
  const { fit, unfit } = appLengthsByFit();
  expect(fit.length).toBeGreaterThan(0);
  expect(unfit.length).toBeGreaterThan(0);
  expect(Math.max(...fit), "o texto mais largo que o app aceita").toBe(limit);
  expect(Math.min(...unfit), "o texto mais curto que o app recusa").toBe(
    limit + 1
  );
}

function expectTextIsTheApps(source: string): number {
  const line = copiedLine(source);
  let compared = 0;
  for (const month of MONTHS) {
    for (const word of ["custo", "taxa"] as const) {
      for (let total = 1; total <= 31; total += 1) {
        for (let unknown = 1; unknown <= total; unknown += 1) {
          expect(line(month, unknown, total, word)).toBe(
            unknownDaysText({ input: WORD_INPUT[word], month, total, unknown })
          );
          compared += 1;
        }
      }
    }
  }
  return compared;
}

describe("o e2e do Início guarda a regra dos dias sem custo do app", () => {
  it("o teto escrito no e2e é o que unknownDaysFit aplica", () => {
    expectLimitIsTheApps(E2E_SOURCE);
  });

  it("o texto escrito no e2e é o que unknownDaysText escreve", () => {
    expect(expectTextIsTheApps(E2E_SOURCE)).toBe(
      MONTHS.length * 2 * ((31 * 32) / 2)
    );
  });

  it("controle: teto ou texto copiado que difere do app reprova", () => {
    for (const limit of [1, 1000]) {
      const otherLimit = E2E_SOURCE.replace(
        LIMIT_DECLARATION,
        `const UNKNOWN_DAYS_MAX_CHARS = ${limit};`
      );
      expect(otherLimit).not.toBe(E2E_SOURCE);
      expect(() => expectLimitIsTheApps(otherLimit)).toThrow();
    }

    const otherText = E2E_SOURCE.replace(`"dias"`, `"d"`);
    expect(otherText).not.toBe(E2E_SOURCE);
    expect(() => expectTextIsTheApps(otherText)).toThrow();

    const withoutDeclaration = E2E_SOURCE.replace(
      "const unknownDaysLine",
      "const lineOfDays"
    );
    expect(() => expectTextIsTheApps(withoutDeclaration)).toThrow();
  });
});
