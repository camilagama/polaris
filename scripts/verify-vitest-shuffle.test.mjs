import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { VITEST_SHUFFLE_LIST } from "./verify-vitest-shuffle.list.mjs";
import {
  ADVICE,
  checkRepository,
  shuffledKeys,
  shuffleProblems,
} from "./verify-vitest-shuffle.mjs";

const FILE = "vitest.sample.config.ts";
const BOTH = { [FILE]: { needs: ["files", "tests"], reason: "r" } };
const TESTS_ONLY = { [FILE]: { needs: ["tests"], reason: "r" } };

function config(sequence) {
  return `export default defineConfig({ test: { ${sequence} } });\n`;
}

function problemsFor(source, list = BOTH) {
  return shuffleProblems({ [FILE]: source }, list);
}

describe("what turns the random order on", () => {
  it.each([
    ["sequence: { shuffle: { files: true, tests: true } }", ["files", "tests"]],
    ["sequence: { shuffle: true }", ["files", "tests"]],
    ["sequence: { shuffle: { tests: true } }", ["tests"]],
    [
      "sequence: { seed: 7, shuffle: { files: true, tests: true } }",
      ["files", "tests"],
    ],
    [
      "sequence: {\n  shuffle: {\n    files: true,\n    tests: true,\n  },\n}",
      ["files", "tests"],
    ],
    ["sequence: { shuffle: { files: false, tests: true } }", ["tests"]],
    ["sequence: { shuffle: false }", []],
    ["sequence: { seed: 7 }", []],
    ["sequence: { shuffle: someOptions }", []],
    ["", []],
  ])("%s → %j", (sequence, keys) => {
    expect([...shuffledKeys(config(sequence))].sort()).toEqual(keys);
  });
});

describe("the check", () => {
  it("passes a config that orders files and tests", () => {
    expect(
      problemsFor(config("sequence: { shuffle: { files: true, tests: true } }"))
    ).toEqual([]);
  });

  it("passes a project that the list asks only for the tests", () => {
    expect(
      problemsFor(config("sequence: { shuffle: { tests: true } }"), TESTS_ONLY)
    ).toEqual([]);
  });

  it("refuses a config that lost the sequence", () => {
    expect(problemsFor(config("name: 'x'"))).toEqual([
      `${FILE}: falta \`files: true\` e \`tests: true\` em \`sequence: { shuffle: ... }\`. ${ADVICE}`,
    ]);
  });

  it("refuses a config whose sequence lost the shuffle", () => {
    expect(problemsFor(config("sequence: { seed: 3 }"))).toHaveLength(1);
    expect(problemsFor(config("sequence: { shuffle: false }"))).toHaveLength(1);
  });

  it("refuses a config that lost `files` where the list asks for it", () => {
    expect(
      problemsFor(config("sequence: { shuffle: { tests: true } }"))
    ).toEqual([
      `${FILE}: falta \`files: true\` em \`sequence: { shuffle: ... }\`. ${ADVICE}`,
    ]);
    expect(
      problemsFor(
        config("sequence: { shuffle: { files: false, tests: true } }")
      )
    ).toHaveLength(1);
  });

  it("refuses a config that lost `tests`", () => {
    expect(
      problemsFor(config("sequence: { shuffle: { files: true } }"), TESTS_ONLY)
    ).toEqual([
      `${FILE}: falta \`tests: true\` em \`sequence: { shuffle: ... }\`. ${ADVICE}`,
    ]);
  });

  it("refuses a listed config that is gone and says how to fix the list", () => {
    const [problem] = shuffleProblems({}, BOTH);
    expect(problem).toContain(`${FILE}: o config da lista não existe`);
    expect(problem).toContain("scripts/verify-vitest-shuffle.list.mjs");
  });

  it("does not take a comment for code", () => {
    const commented = `export default defineConfig({
  test: {
    // sequence: { shuffle: { files: true, tests: true } }
    /* shuffle: true */
    name: "x",
  },
});
`;
    expect(problemsFor(commented)).toHaveLength(1);
    const wordOnly = config(
      "/* shuffle goes here */ sequence: { seed: 1 } // shuffle: { files: true, tests: true }"
    );
    expect(problemsFor(wordOnly)).toHaveLength(1);
  });

  it("counts the code next to a comment that names the shuffle", () => {
    const both = `export default defineConfig({
  test: {
    // the project below does not inherit the shuffle of the root
    sequence: { shuffle: { files: true, tests: true } },
  },
});
`;
    expect(problemsFor(both)).toEqual([]);
  });

  it("does not read a config that is not in the list", () => {
    expect(
      shuffleProblems({ "vitest.other.config.ts": config("name: 'x'") }, {})
    ).toEqual([]);
  });

  it("tells the agent how to fix it", () => {
    expect(ADVICE).toContain("sequence: { shuffle:");
    expect(ADVICE).toContain("não herda");
  });
});

describe("the list", () => {
  it("names the nine configs that have the shuffle today", () => {
    expect(Object.keys(VITEST_SHUFFLE_LIST)).toEqual([
      "apps/admin/vitest.workers-db.config.ts",
      "apps/admin/vitest.workers.config.ts",
      "apps/catalog/vitest.workers-db.config.ts",
      "apps/web/vitest.workers-db.config.ts",
      "vitest.admin-worker.config.ts",
      "vitest.catalog-worker.config.ts",
      "vitest.config.ts",
      "vitest.datas.config.ts",
      "vitest.web-worker.config.ts",
    ]);
  });

  it("plants a repository: a config that loses the shuffle is the only problem", () => {
    const base = mkdtempSync(path.join(tmpdir(), "vitest-shuffle-"));
    try {
      const list = {
        "a/vitest.config.ts": { needs: ["tests"], reason: "r" },
        "b/vitest.config.ts": { needs: ["files", "tests"], reason: "r" },
      };
      for (const [file, sequence] of [
        ["a/vitest.config.ts", "sequence: { shuffle: { tests: true } }"],
        [
          "b/vitest.config.ts",
          "sequence: { shuffle: { files: false, tests: true } }",
        ],
      ]) {
        mkdirSync(path.dirname(path.join(base, file)), { recursive: true });
        writeFileSync(path.join(base, file), config(sequence));
      }
      expect(
        checkRepository(base, list).map((problem) => problem.split(":")[0])
      ).toEqual(["b/vitest.config.ts"]);
    } finally {
      rmSync(base, { force: true, recursive: true });
    }
  });

  it("holds for the real configs", () => {
    expect(checkRepository()).toEqual([]);
  });
});
