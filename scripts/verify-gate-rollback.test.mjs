import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { trackTree } from "./track-tree.mjs";
import { GATE_ROLLBACK_LIST } from "./verify-gate-rollback.list.mjs";
import {
  ADVICE,
  bareRollbackLines,
  checkRepository,
  gateRollbackProblems,
  HELPERS_FILE,
  isGateScript,
} from "./verify-gate-rollback.mjs";

const REPOSITORY_WALK_TIMEOUT_MS = 20_000;

const BARE = `export async function gate(pool) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}
`;

const WITH_HELPER = `import { rollbackAndRelease } from "./gate-roles.ts";
export async function gate(pool) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
  } finally {
    await rollbackAndRelease(client);
  }
}
`;

describe("what counts as a bare ROLLBACK", () => {
  it("counts a string or template that is only ROLLBACK, in any quote, case or spacing, with the line", () => {
    expect(
      bareRollbackLines(
        [
          'await a.query("ROLLBACK");',
          "await b.query('rollback;');",
          "await c.query(`ROLLBACK`);",
          "await d.query(",
          '  "ROLLBACK"',
          ");",
        ].join("\n")
      )
    ).toEqual([1, 2, 3, 5]);
  });

  it("counts the branch of a conditional passed to query", () => {
    expect(
      bareRollbackLines('await holder.query(commit ? "COMMIT" : "ROLLBACK");\n')
    ).toEqual([1]);
  });

  it("does not count ROLLBACK TO SAVEPOINT, COMMIT, a helper call or a ROLLBACK that is not an argument of query", () => {
    expect(
      bareRollbackLines(
        [
          'await a.query("ROLLBACK TO SAVEPOINT probe");',
          'await a.query("COMMIT");',
          "await rollbackAndRelease(a);",
          'expect(statements).toEqual(["ROLLBACK"]);',
          'if (text === "ROLLBACK") { fail(); }',
          'await a.query(wrap("ROLLBACK"));',
          'await a.query(["ROLLBACK"]);',
        ].join("\n")
      )
    ).toEqual([]);
  });

  it("does not count a comment or text inside another string", () => {
    expect(
      bareRollbackLines(
        [
          '// await a.query("ROLLBACK");',
          '/* a.query("ROLLBACK") */',
          "const doc = 'a.query(\"ROLLBACK\")';",
          "await a.query(\"SELECT 'ROLLBACK'\");",
        ].join("\n")
      )
    ).toEqual([]);
  });

  it("is not fooled by parentheses inside strings that come before it", () => {
    expect(
      bareRollbackLines('await a.query("SELECT (1", "ROLLBACK");\n')
    ).toEqual([1]);
  });
});

describe("the rule", () => {
  it("refuses a new file with a bare ROLLBACK, and names the file, the line and the helpers", () => {
    const problems = gateRollbackProblems(
      { "packages/db/scripts/verify-new-gate.ts": BARE },
      {}
    );
    expect(problems).toEqual([
      `packages/db/scripts/verify-new-gate.ts (linha 6): 1 ROLLBACK solto em query(. ${ADVICE}`,
    ]);
    expect(ADVICE).toContain("rollbackAndRelease");
    expect(ADVICE).toContain("rollbackQuietly");
    expect(ADVICE).toContain("gate-roles.ts");
  });

  it("accepts the file that goes through the helper", () => {
    expect(
      gateRollbackProblems(
        { "packages/db/scripts/verify-new-gate.ts": WITH_HELPER },
        {}
      )
    ).toEqual([]);
  });

  it("refuses a listed file that adds one more ROLLBACK, with the lines of all of them", () => {
    const problems = gateRollbackProblems(
      { "packages/db/scripts/old-gate.ts": `${BARE}${BARE}` },
      { "packages/db/scripts/old-gate.ts": { count: 1, reason: "r" } }
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("old-gate.ts (linhas 6, 15)");
    expect(problems[0]).toContain("aceita 1");
  });

  it("accepts a listed file with exactly its count", () => {
    expect(
      gateRollbackProblems(
        { "packages/db/scripts/old-gate.ts": BARE },
        { "packages/db/scripts/old-gate.ts": { count: 1, reason: "r" } }
      )
    ).toEqual([]);
  });

  it("asks to lower the entry of a listed file that lost a ROLLBACK, and to drop one that lost all", () => {
    expect(
      gateRollbackProblems(
        { "packages/db/scripts/old-gate.ts": BARE },
        { "packages/db/scripts/old-gate.ts": { count: 2, reason: "r" } }
      )[0]
    ).toContain("Baixe a entrada para 1");
    expect(
      gateRollbackProblems(
        { "packages/db/scripts/old-gate.ts": WITH_HELPER },
        { "packages/db/scripts/old-gate.ts": { count: 1, reason: "r" } }
      )[0]
    ).toContain("sem nenhum uso");
  });

  it("asks for a reason on a listed entry", () => {
    expect(
      gateRollbackProblems(
        { "packages/db/scripts/old-gate.ts": BARE },
        { "packages/db/scripts/old-gate.ts": { count: 1, reason: " " } }
      )[0]
    ).toContain("precisa de um motivo");
  });
});

describe("which files are gate scripts", () => {
  it.each([
    ["packages/db/scripts/verify-x-gate.ts", true],
    ["packages/db/scripts/sub/support.ts", true],
    ["packages/db/scripts/verify-x-gate.test.ts", true],
    [HELPERS_FILE, false],
    ["packages/db/scripts/types.d.ts", false],
    ["packages/db/scripts/run.mjs", false],
    ["packages/db/src/billing-store.ts", false],
    ["apps/web/scripts/x.ts", false],
  ])("%s", (file, expected) => {
    expect(isGateScript(file)).toBe(expected);
  });
});

describe("the tree", () => {
  it("walks a planted tree: gate scripts count, the helper file, other folders and build output do not", () => {
    const base = mkdtempSync(path.join(tmpdir(), "gate-rollback-"));
    try {
      for (const file of [
        "packages/db/scripts/a-gate.ts",
        "packages/db/scripts/sub/b-gate.ts",
        "packages/db/scripts/c-gate.test.ts",
        HELPERS_FILE,
        "packages/db/src/store.ts",
        "packages/db/scripts/node_modules/d.ts",
      ]) {
        mkdirSync(path.dirname(path.join(base, file)), { recursive: true });
        writeFileSync(path.join(base, file), BARE);
      }
      writeFileSync(
        path.join(base, "packages/db/scripts/ok-gate.ts"),
        WITH_HELPER
      );
      trackTree(base);
      expect(
        checkRepository(base, {}).map((problem) => problem.split(" ")[0])
      ).toEqual([
        "packages/db/scripts/a-gate.ts",
        "packages/db/scripts/c-gate.test.ts",
        "packages/db/scripts/sub/b-gate.ts",
      ]);
    } finally {
      rmSync(base, { force: true, recursive: true });
    }
  });

  it(
    "is exact for the repository: every entry matches the tree",
    () => {
      expect(checkRepository()).toEqual([]);
      expect(Object.keys(GATE_ROLLBACK_LIST).length).toBeGreaterThan(0);
      expect(GATE_ROLLBACK_LIST[HELPERS_FILE]).toBeUndefined();
    },
    REPOSITORY_WALK_TIMEOUT_MS
  );
});
