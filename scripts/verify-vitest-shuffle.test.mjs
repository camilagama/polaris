import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { trackTree } from "./track-tree.mjs";
import { VITEST_SHUFFLE_LIST } from "./verify-vitest-shuffle.list.mjs";
import {
  checkRepository,
  LIST_FILE,
  missingShuffle,
  shuffleProblems,
} from "./verify-vitest-shuffle.mjs";

const both = ["files", "tests"];

const config = (sequence) =>
  `export default defineConfig({ test: { include: ["a"], ${sequence} } });`;

describe("what counts as the random order being on", () => {
  it.each([
    [
      "files and tests",
      "sequence: { shuffle: { files: true, tests: true } },",
      both,
    ],
    [
      "tests only, as a project asks",
      "sequence: { shuffle: { tests: true } },",
      ["tests"],
    ],
    ["the short form", "sequence: { shuffle: true },", both],
    [
      "a seed beside the shuffle",
      "sequence: { seed: 3, shuffle: { files: true, tests: true } },",
      both,
    ],
    [
      "the multi-line form",
      "sequence: {\n  shuffle: {\n    files: true,\n    tests: true,\n  },\n},",
      both,
    ],
  ])("%s", (_name, sequence, needs) => {
    expect(missingShuffle(config(sequence), needs)).toEqual([]);
  });
});

describe("what the guard refuses, and what it says is missing", () => {
  it.each([
    ["no `sequence` at all", "", both, ["`sequence`"]],
    [
      "a `sequence` without `shuffle`",
      "sequence: { seed: 3 },",
      both,
      ["`shuffle` dentro de `sequence`"],
    ],
    [
      "the shuffle turned off",
      "sequence: { shuffle: false },",
      both,
      ["`shuffle: false` fora (ou dentro) do `sequence` do config"],
    ],
    [
      "`files` left out",
      "sequence: { shuffle: { tests: true } },",
      both,
      ["`files: true`"],
    ],
    [
      "`files` turned off",
      "sequence: { shuffle: { files: false, tests: true } },",
      both,
      ["`files: true`"],
    ],
    [
      "`tests` left out",
      "sequence: { shuffle: { files: true } },",
      both,
      ["`tests: true`"],
    ],
    [
      "an empty shuffle",
      "sequence: { shuffle: {} },",
      both,
      ["`files: true`", "`tests: true`"],
    ],
    [
      "a project without `tests`",
      "sequence: { shuffle: { files: true } },",
      ["tests"],
      ["`tests: true`"],
    ],
  ])("%s", (_name, sequence, needs, lacking) => {
    expect(missingShuffle(config(sequence), needs)).toEqual(lacking);
  });

  it("does not take the word in a comment for code", () => {
    const source = [
      "// sequence: { shuffle: { files: true, tests: true } }",
      "export default defineConfig({",
      "  test: {",
      "    /* it does not inherit the shuffle: sequence: { shuffle: true } */",
      "    // sequence: { shuffle: true },",
      "  },",
      "});",
    ].join("\n");
    expect(missingShuffle(source, both)).toEqual(["`sequence`"]);
  });

  it("does not take a comment beside a `sequence` without `shuffle` for the shuffle", () => {
    const source = config(
      "sequence: { seed: 1 }, // shuffle: { files: true, tests: true }"
    );
    expect(missingShuffle(source, both)).toEqual([
      "`shuffle` dentro de `sequence`",
    ]);
  });

  it("does not let a `sequence` of an inline project stand in for the one the config lost", () => {
    const source = `export default defineConfig({ test: {
      projects: [{ test: { sequence: { shuffle: { files: true, tests: true } } } }],
    } });`;
    expect(missingShuffle(source, both)).toEqual(["`sequence`"]);
  });

  it("refuses an inline project that turns the shuffle off", () => {
    const source = `export default defineConfig({ test: {
      sequence: { shuffle: { files: true, tests: true } },
      projects: [{ extends: true, test: { sequence: { shuffle: false } } }],
    } });`;
    expect(missingShuffle(source, both)).toEqual([
      "`shuffle: false` fora (ou dentro) do `sequence` do config",
    ]);
  });

  it("asks every `sequence` of the config to say it, not the best of them", () => {
    const source = `export default defineConfig({ test: {
      sequence: { shuffle: { files: true, tests: true } },
      sequence: { seed: 1 },
    } });`;
    expect(missingShuffle(source, both)).toEqual([
      "`shuffle` dentro de `sequence`",
    ]);
  });

  it("does not read a string literal as code", () => {
    const source = `export default defineConfig({ test: {
      name: "sequence: { shuffle: { files: true, tests: true } }",
      include: ["}"],
    } });`;
    expect(missingShuffle(source, both)).toEqual(["`sequence`"]);
  });

  it("refuses a shuffle that is not a literal, rather than guess", () => {
    expect(
      missingShuffle(
        config("sequence: { shuffle: process.env.SHUFFLE },"),
        both
      )
    ).toEqual(["`shuffle` dentro de `sequence`"]);
  });

  it("lets the outermost `sequence` decide, not the one of a nested project", () => {
    const source = `export default defineConfig({ test: {
      sequence: { seed: 1 },
      projects: [{ test: { sequence: { shuffle: { files: true, tests: true } } } }],
    } });`;
    expect(missingShuffle(source, both)).toEqual([
      "`shuffle` dentro de `sequence`",
    ]);
  });
});

describe("the problems the guard reports", () => {
  const list = { "vitest.x.config.ts": { needs: both } };

  it("names the file, what is missing and how to fix it", () => {
    const [problem, ...rest] = shuffleProblems(
      {
        "vitest.x.config.ts": config("sequence: { shuffle: { tests: true } },"),
      },
      list
    );
    expect(rest).toEqual([]);
    expect(problem).toContain("vitest.x.config.ts:");
    expect(problem).toContain("falta `files: true`");
    expect(problem).toContain(
      "sequence: { shuffle: { files: true, tests: true } }"
    );
    expect(problem).toContain("não herda o `sequence` da raiz");
  });

  it("refuses a listed config that does not exist and points at the list", () => {
    const [problem] = shuffleProblems(
      { "vitest.x.config.ts": undefined },
      list
    );
    expect(problem).toContain("vitest.x.config.ts: config da lista não existe");
    expect(problem).toContain(LIST_FILE);
  });

  it("passes a listed config that keeps the order on", () => {
    expect(
      shuffleProblems(
        { "vitest.x.config.ts": config("sequence: { shuffle: true },") },
        list
      )
    ).toEqual([]);
  });

  it("does not look at a config outside the list", () => {
    expect(
      shuffleProblems(
        {
          "vitest.other.config.ts": config(""),
          "vitest.x.config.ts": config("sequence: { shuffle: true },"),
        },
        list
      )
    ).toEqual([]);
  });
});

describe("the list", () => {
  it("is exactly the eight configs that have the shuffle on, with what each sets", () => {
    expect(
      Object.entries(VITEST_SHUFFLE_LIST).map(([file, { needs }]) => [
        file,
        needs,
      ])
    ).toEqual([
      ["apps/admin/vitest.workers-db.config.ts", ["tests"]],
      ["apps/catalog/vitest.workers-db.config.ts", ["tests"]],
      ["apps/web/vitest.workers-db.config.ts", both],
      ["vitest.admin-worker.config.ts", both],
      ["vitest.catalog-worker.config.ts", both],
      ["vitest.config.ts", both],
      ["vitest.datas.config.ts", both],
      ["vitest.web-worker.config.ts", both],
    ]);
  });

  it("reads a planted tree: a config that lost the line and one that is gone", () => {
    const base = mkdtempSync(path.join(tmpdir(), "vitest-shuffle-"));
    try {
      writeFileSync(
        path.join(base, "a.config.ts"),
        config("sequence: { shuffle: true },")
      );
      writeFileSync(path.join(base, "b.config.ts"), config(""));
      trackTree(base);
      const problems = checkRepository(base, {
        "a.config.ts": { needs: both },
        "b.config.ts": { needs: both },
        "c.config.ts": { needs: both },
      });
      expect(problems.map((problem) => problem.split(":")[0])).toEqual([
        "b.config.ts",
        "c.config.ts",
      ]);
    } finally {
      rmSync(base, { force: true, recursive: true });
    }
  });

  it("holds for the repository: the eight configs keep the random order", () => {
    expect(checkRepository()).toEqual([]);
  });
});
