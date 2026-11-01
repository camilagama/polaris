import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { exactCountProblems, walkFiles } from "./exact-count-list.mjs";

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

describe("walkFiles", () => {
  it("returns sorted relative paths and skips dependencies and build output", () => {
    const base = mkdtempSync(path.join(tmpdir(), "exact-count-"));
    try {
      for (const file of [
        "b/x.ts",
        "a/y.ts",
        "node_modules/z.ts",
        "apps/web/dist/w.ts",
      ]) {
        mkdirSync(path.dirname(path.join(base, file)), { recursive: true });
        writeFileSync(path.join(base, file), "");
      }
      expect(walkFiles(base, (file) => file.endsWith(".ts"))).toEqual([
        "a/y.ts",
        "b/x.ts",
      ]);
    } finally {
      rmSync(base, { force: true, recursive: true });
    }
  });
});
