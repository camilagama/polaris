import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const FORBIDDEN_KEYS = ["staticDistDir", "startServerCommand"] as const;

const configUrl = new URL("../lighthouserc.json", import.meta.url);

const forbiddenKeysIn = (node: unknown, path = "$"): readonly string[] => {
  if (node === null || typeof node !== "object") {
    return [];
  }
  return Object.entries(node).flatMap(([key, value]) => [
    ...(FORBIDDEN_KEYS.some((forbidden) => forbidden === key)
      ? [`${path}.${key}`]
      : []),
    ...forbiddenKeysIn(value, `${path}.${key}`),
  ]);
};

describe("lighthouserc.json", () => {
  it("não usa staticDistDir nem startServerCommand", () => {
    const found = forbiddenKeysIn(JSON.parse(readFileSync(configUrl, "utf8")));
    expect(
      found,
      `lighthouserc.json ganhou ${found.join(", ")}. No @lhci/cli 0.15.1 o express (e o body-parser da exceção em docs/runbooks/dependency-audit.md) só atende com collect --staticDistDir, que o config não usa; reveja a frase do runbook antes de usar essas chaves.`
    ).toEqual([]);
  });

  it("o detector acha as chaves proibidas em qualquer nível", () => {
    expect(
      forbiddenKeysIn({ ci: { collect: { staticDistDir: "dist" } } })
    ).toEqual(["$.ci.collect.staticDistDir"]);
    expect(
      forbiddenKeysIn({ ci: { collect: { startServerCommand: "x" } } })
    ).toEqual(["$.ci.collect.startServerCommand"]);
    expect(forbiddenKeysIn({ ci: { collect: { url: ["a"] } } })).toEqual([]);
  });
});
