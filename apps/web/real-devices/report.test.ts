import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  normalizeSha,
  type RunReport,
  UNKNOWN_SHA,
  writeReport,
} from "./report";

const SHA = "9b3d37ed5c223fba78109e32e9196bb294b35358";
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function written(appSha: string, appDirty = false) {
  const directory = mkdtempSync(join(tmpdir(), "polaris-gate5-report-"));
  directories.push(directory);
  const report: RunReport = {
    appDirty,
    appSha,
    devices: [],
    finishedAt: "2026-01-01T00:05:00.000Z",
    partial: false,
    selection: { flows: [1], platforms: ["android"] },
    startedAt: "2026-01-01T00:00:00.000Z",
    status: "passed",
  };
  writeReport(directory, report);
  return {
    json: JSON.parse(readFileSync(join(directory, "report.json"), "utf8")) as {
      appDirty: boolean;
      appSha: string;
    },
    markdown: readFileSync(join(directory, "report.md"), "utf8"),
  };
}

describe("SHA do app testado no relatório do Gate 5", () => {
  it("aparece no report.json e no report.md", () => {
    const { json, markdown } = written(SHA);
    expect(json.appSha).toBe(SHA);
    expect(markdown).toContain(`App testado: commit \`${SHA}\``);
  });

  it.each([
    ["vazio", ""],
    ["curto", SHA.slice(0, 12)],
    ["com lixo", `${SHA}\n; rm -rf`],
    ["fora do hexadecimal", "z".repeat(40)],
  ])("SHA %s vira desconhecido nos dois formatos", (_name, value) => {
    const { json, markdown } = written(value);
    expect(json.appSha).toBe(UNKNOWN_SHA);
    expect(markdown).toContain(`App testado: SHA ${UNKNOWN_SHA}`);
    expect(markdown).not.toContain("App testado: commit");
  });

  it("árvore suja é dita nos dois formatos; limpa, não aparece", () => {
    const dirty = written(SHA, true);
    expect(dirty.json.appDirty).toBe(true);
    expect(dirty.markdown).toContain("alterações não commitadas");
    const clean = written(SHA);
    expect(clean.json.appDirty).toBe(false);
    expect(clean.markdown).not.toContain("alterações não commitadas");
  });

  it("normalizeSha aceita maiúsculas e espaços ao redor, e recusa ausente", () => {
    expect(normalizeSha(`  ${SHA.toUpperCase()}\n`)).toBe(SHA);
    expect(normalizeSha(null)).toBe(UNKNOWN_SHA);
    expect(normalizeSha(undefined)).toBe(UNKNOWN_SHA);
  });
});
