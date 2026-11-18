import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ADR_DIRECTORY = path.resolve(
  fileURLToPath(new URL("../docs/adr", import.meta.url))
);
const ADR_NAME = /^(\d{4})-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;

/**
 * Two ADR files with the same number but different slugs do not conflict in a
 * merge, so only this check sees the repeated number.
 */
function adrNumberProblems(names) {
  const problems = [];
  const byNumber = new Map();
  for (const name of names) {
    const match = ADR_NAME.exec(name);
    if (match === null) {
      problems.push(`"${name}" does not follow NNNN-slug.md`);
      continue;
    }
    byNumber.set(match[1], [...(byNumber.get(match[1]) ?? []), name]);
  }
  for (const [number, sameNumber] of byNumber) {
    if (sameNumber.length > 1) {
      problems.push(
        `number ${number} is used by ${sameNumber.map((name) => `"${name}"`).join(" and ")}`
      );
    }
  }
  return problems;
}

describe("adrNumberProblems", () => {
  it("accepts distinct numbers", () => {
    expect(
      adrNumberProblems([
        "0001-cloudflare-modular-monolith.md",
        "0002-neon-postgresql18-hyperdrive-rls.md",
      ])
    ).toEqual([]);
  });

  it("names both files when a number repeats with different slugs", () => {
    const problems = adrNumberProblems([
      "0106-primeiro-assunto.md",
      "0107-a.md",
      "0107-b.md",
    ]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("0107");
    expect(problems[0]).toContain("0107-a.md");
    expect(problems[0]).toContain("0107-b.md");
  });

  it.each([
    "107-curto.md",
    "0107_underscore.md",
    "0107-Maiusculo.md",
    "0107-sem-extensao",
    "0107.md",
    "README.md",
    "0107-a--b.md",
    "0107-a-.md",
    "0107-a.MD",
    "0107-a.md.bak",
  ])("names the file outside the pattern: %s", (name) => {
    const problems = adrNumberProblems(["0001-valido.md", name]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(name);
  });
});

describe("docs/adr", () => {
  it("has at least one ADR, so an empty read cannot pass", () => {
    expect(readdirSync(ADR_DIRECTORY).length).toBeGreaterThan(0);
  });

  it("has unique numbers and only NNNN-slug.md files", () => {
    expect(adrNumberProblems(readdirSync(ADR_DIRECTORY))).toEqual([]);
  });
});
