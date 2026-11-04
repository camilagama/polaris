import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  exactCountProblems,
  gitEnvironment,
  walkFiles,
} from "./exact-count-list.mjs";

const INSIDE_CLONE = /dentro do clone do repositório/;

const check = (found, allowed) =>
  exactCountProblems({
    advice: "Faça X.",
    allowed,
    found,
    listFile: "lista.mjs",
    what: "usos",
  });

describe("exactCountProblems", () => {
  it("accepts a tree that matches the list exactly", () => {
    expect(
      check({ "a.ts": 2, "b.ts": 0 }, { "a.ts": { count: 2, reason: "r" } })
    ).toEqual([]);
  });

  it("refuses a file not in the list and says what to do", () => {
    expect(check({ "a.ts": 1 }, {})).toEqual(["a.ts: 1 usos. Faça X."]);
  });

  it("refuses one use more than the list, with the advice", () => {
    expect(check({ "a.ts": 3 }, { "a.ts": { count: 2, reason: "r" } })).toEqual(
      ["a.ts: 3 usos, a lista de lista.mjs aceita 2. Faça X."]
    );
  });

  it("refuses one use less, so the list never keeps room for a new one", () => {
    expect(
      check({ "a.ts": 1 }, { "a.ts": { count: 2, reason: "r" } }).join("\n")
    ).toContain("Baixe a entrada para 1");
  });

  it("refuses an entry whose file has no use left", () => {
    expect(
      check({ "a.ts": 0 }, { "a.ts": { count: 1, reason: "r" } }).join("\n")
    ).toContain("Tire a entrada");
  });

  it("refuses an entry without a reason", () => {
    expect(check({ "a.ts": 1 }, { "a.ts": { count: 1, reason: " " } })).toEqual(
      ["a.ts: a entrada de lista.mjs precisa de um motivo."]
    );
  });
});

const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, env: gitEnvironment(), stdio: "pipe" });

const touch = (base, files) => {
  for (const file of files) {
    mkdirSync(path.dirname(path.join(base, file)), { recursive: true });
    writeFileSync(path.join(base, file), "");
  }
};

describe("walkFiles", () => {
  const dirs = [];
  const temp = () => {
    const base = mkdtempSync(path.join(tmpdir(), "exact-count-"));
    dirs.push(base);
    return base;
  };
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it("returns sorted relative paths and skips dependencies and build output", () => {
    const base = temp();
    git(base, "init", "-q");
    touch(base, [
      "b/x.ts",
      "a/y.ts",
      "node_modules/z.ts",
      "apps/web/dist/w.ts",
    ]);
    git(base, "add", "-f", ".");
    expect(walkFiles(base, (file) => file.endsWith(".ts"))).toEqual([
      "a/y.ts",
      "b/x.ts",
    ]);
  });

  it("lists a file added to the index and leaves out one git does not know", () => {
    const base = temp();
    git(base, "init", "-q");
    touch(base, ["tracked.e2e.ts", "staged.e2e.ts", "only-here.e2e.ts"]);
    git(base, "add", "tracked.e2e.ts");
    git(
      base,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "-qm",
      "x"
    );
    git(base, "add", "staged.e2e.ts");
    expect(walkFiles(base, (file) => file.endsWith(".e2e.ts"))).toEqual([
      "staged.e2e.ts",
      "tracked.e2e.ts",
    ]);
  });

  it("leaves out a tracked file that is gone from the disk", () => {
    const base = temp();
    git(base, "init", "-q");
    touch(base, ["kept.ts", "gone.ts"]);
    git(base, "add", ".");
    rmSync(path.join(base, "gone.ts"));
    expect(walkFiles(base, () => true)).toEqual(["kept.ts"]);
  });

  it("fails with what to do outside a git repository", () => {
    const base = temp();
    touch(base, ["a.ts"]);
    vi.stubEnv("GIT_CEILING_DIRECTORIES", path.dirname(base));
    expect(() => walkFiles(base, () => true)).toThrow(INSIDE_CLONE);
  });

  it("ignores a GIT_DIR that points at another repository", () => {
    const base = temp();
    const other = temp();
    git(base, "init", "-q");
    git(other, "init", "-q");
    touch(base, ["mine.ts"]);
    touch(other, ["theirs.ts"]);
    git(base, "add", ".");
    git(other, "add", ".");
    vi.stubEnv("GIT_DIR", path.join(other, ".git"));
    expect(walkFiles(base, () => true)).toEqual(["mine.ts"]);
  });

  it("keeps the fixture's git commands out of a repository named by GIT_DIR, GIT_INDEX_FILE or GIT_WORK_TREE", () => {
    const base = temp();
    const other = temp();
    git(other, "init", "-q");
    const before = git(other, "status", "--porcelain=v1", "-z").toString();
    vi.stubEnv("GIT_DIR", path.join(other, ".git"));
    vi.stubEnv("GIT_INDEX_FILE", path.join(other, ".git", "index"));
    vi.stubEnv("GIT_WORK_TREE", other);
    git(base, "init", "-q");
    touch(base, ["mine.ts"]);
    git(base, "add", ".");
    expect(walkFiles(base, () => true)).toEqual(["mine.ts"]);
    vi.unstubAllEnvs();
    expect(git(other, "status", "--porcelain=v1", "-z").toString()).toBe(
      before
    );
    expect(git(other, "ls-files").toString()).toBe("");
  });
});
