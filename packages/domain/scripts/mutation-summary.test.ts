import { describe, expect, it } from "vitest";
import {
  type MutationReport,
  renderSummary,
  scoreOf,
  survivorsOf,
} from "./mutation-summary";

type Status =
  | "Killed"
  | "Survived"
  | "NoCoverage"
  | "Timeout"
  | "CompileError"
  | "RuntimeError"
  | "Ignored";

function mutant(
  id: string,
  status: Status,
  line: number,
  mutatorName = "ArithmeticOperator",
  replacement = "a - b"
) {
  return {
    id,
    location: {
      end: { column: 9, line },
      start: { column: 1, line },
    },
    mutatorName,
    replacement,
    status,
  };
}

function report(files: MutationReport["files"]): MutationReport {
  return { files };
}

describe("scoreOf", () => {
  it("counts timeouts as detected and ignores errors and ignored mutants", () => {
    const score = scoreOf(
      report({
        "src/money/money.ts": {
          mutants: [
            mutant("1", "Killed", 1),
            mutant("2", "Timeout", 2),
            mutant("3", "Survived", 3),
            mutant("4", "NoCoverage", 4),
            mutant("5", "CompileError", 5),
            mutant("6", "RuntimeError", 6),
            mutant("7", "Ignored", 7),
          ],
        },
      })
    );

    expect(score).toEqual({
      detected: 2,
      noCoverage: 1,
      percentage: 50,
      survived: 1,
      total: 4,
    });
  });

  it("has no percentage when no mutant is valid", () => {
    const score = scoreOf(
      report({
        "src/money/money.ts": { mutants: [mutant("1", "CompileError", 1)] },
      })
    );

    expect(score.percentage).toBeNull();
    expect(score.total).toBe(0);
  });
});

describe("survivorsOf", () => {
  it("lists survivors and uncovered mutants by file and line, in order", () => {
    const survivors = survivorsOf(
      report({
        "src/sales/confirm-sale.ts": {
          mutants: [mutant("d", "Survived", 5)],
        },
        "src/sales/sale.ts": {
          mutants: [
            mutant("a", "Survived", 30),
            mutant("b", "Killed", 31),
            mutant("c", "NoCoverage", 12),
          ],
        },
      })
    );

    expect(
      survivors.map(({ file, line, status }) => [file, line, status])
    ).toEqual([
      ["src/sales/confirm-sale.ts", 5, "Survived"],
      ["src/sales/sale.ts", 12, "NoCoverage"],
      ["src/sales/sale.ts", 30, "Survived"],
    ]);
  });
});

describe("renderSummary", () => {
  const money = report({
    "src/money/money.ts": {
      mutants: [
        mutant("1", "Killed", 1),
        mutant("2", "Survived", 42, "EqualityOperator", "a >= b"),
      ],
    },
  });
  const onlyKilled = report({
    "src/money/money.ts": { mutants: [mutant("1", "Killed", 1)] },
  });

  it("shows the score per folder and the survivors with file and line", () => {
    const text = renderSummary([
      { folder: "money", report: money, state: "complete" },
    ]);

    expect(text).toContain("| money | 50.00% | 1 | 1 | 0 | 2 |");
    expect(text).toContain(
      "- `src/money/money.ts:42` EqualityOperator: `a >= b`"
    );
  });

  it("puts a replacement with backticks and line breaks on one line, keeping pipes as they are", () => {
    const text = renderSummary([
      {
        folder: "money",
        report: report({
          "src/money/money.ts": {
            mutants: [
              mutant("1", "Survived", 7, "StringLiteral", "a | `b`\nc"),
            ],
          },
        }),
        state: "complete",
      },
    ]);

    expect(text).toContain(
      "- `src/money/money.ts:7` StringLiteral: `a | 'b' c`\n"
    );
  });

  it("cuts the list of each folder at the limit, so one folder does not hide the next", () => {
    const many = (file: string) =>
      report({
        [file]: {
          mutants: Array.from({ length: 5 }, (_, index) =>
            mutant(String(index), "Survived", index + 1)
          ),
        },
      });
    const text = renderSummary(
      [
        {
          folder: "money",
          report: many("src/money/money.ts"),
          state: "complete",
        },
        {
          folder: "sales",
          report: many("src/sales/sale.ts"),
          state: "complete",
        },
      ],
      3
    );

    expect(text).toContain("`src/money/money.ts:3`");
    expect(text).not.toContain("`src/money/money.ts:4`");
    expect(text).toContain("- money: 2 more survivors");
    expect(text).toContain("`src/sales/sale.ts:3`");
    expect(text).toContain("- sales: 2 more survivors");
  });

  it("says nothing survived only when every folder finished", () => {
    const text = renderSummary([
      { folder: "money", report: onlyKilled, state: "complete" },
    ]);

    expect(text).toContain("No surviving mutants.");
    expect(text).not.toContain("Partial run");
  });

  it("says the run was partial, and why, instead of claiming no survivors", () => {
    const text = renderSummary([
      { folder: "money", report: onlyKilled, state: "complete" },
      { folder: "sales", report: null, state: "cut" },
      { folder: "inventory", report: null, state: "failed" },
      { folder: "economics", report: null, state: "not-run" },
    ]);

    expect(text).toContain(
      "| sales | cut by the deadline, continues in the next run |"
    );
    expect(text).toContain("| inventory | Stryker failed |");
    expect(text).toContain("| economics | not run |");
    expect(text).toContain("Partial run");
    expect(text).toContain(
      "No surviving mutants in the folders that finished."
    );
    expect(text).not.toContain("No surviving mutants.");
  });

  it("does not count a folder that finished without a readable report", () => {
    const text = renderSummary([
      { folder: "money", report: null, state: "complete" },
    ]);

    expect(text).toContain("| money | no report |");
    expect(text).toContain("Partial run");
  });
});
