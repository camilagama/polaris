import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  VITEST_SHUFFLE_EXEMPT,
  VITEST_SHUFFLE_LIST,
} from "./verify-vitest-shuffle.list.mjs";
import {
  ADVICE,
  checkRepository,
  shuffledKeys,
  shuffleProblems,
} from "./verify-vitest-shuffle.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const DOLLAR = "$";
const VITEST_CONFIG_NAME = /^vitest\..*config\.[cm]?[jt]s$/;
const SKIPPED_FOLDERS = new Set([
  ".codex-worktrees",
  ".git",
  ".stryker-tmp",
  ".wrangler",
  "coverage",
  "dist",
  "node_modules",
]);

function vitestConfigsOf(base, folder = "") {
  const found = [];
  for (const entry of readdirSync(path.join(base, folder), {
    withFileTypes: true,
  })) {
    const relative = folder === "" ? entry.name : `${folder}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!SKIPPED_FOLDERS.has(entry.name)) {
        found.push(...vitestConfigsOf(base, relative));
      }
    } else if (VITEST_CONFIG_NAME.test(entry.name)) {
      found.push(relative);
    }
  }
  return found.sort();
}

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

describe("a string is not code", () => {
  it.each([
    ["a string", `const note = "sequence: { shuffle: true }";`],
    ["a single-quoted string", `const note = 'sequence: { shuffle: true }';`],
    ["a template literal", "const note = `sequence: { shuffle: true }`;"],
    [
      "a template literal with an expression",
      `const note = \`${DOLLAR}{a} sequence: { shuffle: { files: true, tests: true } }\`;`,
    ],
  ])("refuses the sequence text inside %s", (_name, text) => {
    const source = `${text}\nexport default defineConfig({ test: { name: "x" } });\n`;
    expect(shuffledKeys(source).size).toBe(0);
    expect(problemsFor(source)).toHaveLength(1);
  });

  it("still reads the code that follows a string with braces and quotes", () => {
    const source =
      `const a = \`{ ${DOLLAR}{"}"} }\`; const b = 'it\\'s';\n` +
      config("sequence: { shuffle: { files: true, tests: true } }");
    expect(problemsFor(source)).toEqual([]);
  });
});

describe("each project has its own order", () => {
  const ROOT = "sequence: { shuffle: { files: true, tests: true } }";
  const projectsConfig = (...projects) =>
    config(`${ROOT}, projects: [${projects.join(", ")}]`);

  it("passes inline projects that inherit or set their own", () => {
    expect(
      problemsFor(
        projectsConfig(
          "{ extends: true, test: { name: 'a' } }",
          "{ test: { name: 'b', sequence: { shuffle: { tests: true } } } }",
          "'apps/other/vitest.config.ts'"
        )
      )
    ).toEqual([]);
  });

  it("refuses an inline project that does not extend and lost its sequence", () => {
    const problems = problemsFor(
      projectsConfig(
        "{ test: { name: 'a', sequence: { shuffle: { tests: true } } } }",
        "{ test: { name: 'b' } }"
      )
    );
    expect(problems).toEqual([
      `${FILE}: projeto inline 2: falta \`tests: true\` em \`sequence: { shuffle: ... }\`. ${ADVICE}`,
    ]);
  });

  it("does not let the sequence of one project cover another", () => {
    const source = config(
      "projects: [{ test: { name: 'a', sequence: { shuffle: { files: true, tests: true } } } }, { test: { name: 'b' } }]"
    );
    const problems = problemsFor(source);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain(
      `${FILE}: falta \`files: true\` e \`tests: true\``
    );
    expect(problems[1]).toContain(`${FILE}: projeto inline 2: falta`);
  });

  it("refuses an inline project that turns its own tests off", () => {
    expect(
      problemsFor(
        projectsConfig(
          "{ test: { name: 'a', sequence: { shuffle: { tests: false } } } }"
        )
      )
    ).toHaveLength(1);
    expect(
      problemsFor(
        projectsConfig(
          "{ extends: true, test: { sequence: { shuffle: false } } }"
        )
      )
    ).toHaveLength(1);
  });

  it("does not count the sequence of a project for the root", () => {
    const source = config(
      "projects: [{ test: { name: 'a', sequence: { shuffle: { files: true, tests: true } } } }]"
    );
    expect(shuffledKeys(source).size).toBe(0);
  });
});

describe("the list", () => {
  it("names every Vitest config of the repository, as listed or as exempt with a reason", () => {
    const found = vitestConfigsOf(repositoryRoot);
    expect(found.length).toBeGreaterThan(0);
    expect(
      [
        ...Object.keys(VITEST_SHUFFLE_LIST),
        ...Object.keys(VITEST_SHUFFLE_EXEMPT),
      ].sort()
    ).toEqual(found);
    for (const [file, reason] of Object.entries(VITEST_SHUFFLE_EXEMPT)) {
      expect(Object.keys(VITEST_SHUFFLE_LIST), file).not.toContain(file);
      expect(reason.length, file).toBeGreaterThan(20);
    }
  });

  it("finds a config that is not in the list", () => {
    const base = mkdtempSync(path.join(tmpdir(), "vitest-shuffle-find-"));
    try {
      for (const file of [
        "vitest.config.ts",
        "apps/x/vitest.new.config.mts",
        "apps/x/node_modules/y/vitest.config.ts",
        "packages/d/.stryker-tmp/sandbox/vitest.mutation.config.ts",
        "apps/x/vitest.setup.ts",
      ]) {
        mkdirSync(path.dirname(path.join(base, file)), { recursive: true });
        writeFileSync(path.join(base, file), "");
      }
      expect(vitestConfigsOf(base)).toEqual([
        "apps/x/vitest.new.config.mts",
        "vitest.config.ts",
      ]);
    } finally {
      rmSync(base, { force: true, recursive: true });
    }
  });

  it("is run by the check of the root package.json", () => {
    const { scripts } = JSON.parse(
      readFileSync(path.join(repositoryRoot, "package.json"), "utf8")
    );
    expect(scripts.check.split("&&").map((step) => step.trim())).toContain(
      "node scripts/verify-vitest-shuffle.mjs"
    );
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
