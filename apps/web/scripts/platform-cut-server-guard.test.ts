import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `platform_cut` is a reason the client alone gives to the platform's page of a Worker it killed (`lib/connection.ts`):
 * that page carries no mark of the Worker, so nothing a server writes can be it. A server that emitted the reason
 * would make its own refusal look like a cut and send the importer and the sync into the pause of the Free plan.
 */
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const SERVER_TREES = [
  "apps/web/src/server",
  "apps/web/worker",
  "apps/admin/src",
  "apps/catalog/src",
  "packages",
];
const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", "dist-e2e"]);
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?|sql|json)$/;
const PLATFORM_CUT = /["'`]platform_cut["'`]|\bPLATFORM_CUT_REASON\b/;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      return SKIPPED_DIRECTORIES.has(name) ? [] : sources(path);
    }
    return SOURCE_FILE.test(name) ? [path] : [];
  });
}

function filesWithTheReason(dirs: string[]): string[] {
  return dirs
    .flatMap((dir) => sources(dir))
    .filter((file) => PLATFORM_CUT.test(readFileSync(file, "utf8")));
}

describe("o motivo platform_cut só nasce no cliente", () => {
  it("o exame acha o motivo em subpasta, em qualquer aspa e pela constante, e ignora node_modules e dist", () => {
    const root = mkdtempSync(join(tmpdir(), "platform-cut-guard-"));
    try {
      const planted: Record<string, string> = {
        "a/b/double.ts": 'export const r = { reason: "platform_cut" };',
        "clean.ts": 'export const r = { reason: "server_busy" };',
        "constant.ts":
          "import { PLATFORM_CUT_REASON } from './connection'; export const r = PLATFORM_CUT_REASON;",
        "dist/hidden.js": 'export const r = "platform_cut";',
        "node_modules/p/hidden.ts": 'export const r = "platform_cut";',
        "notes.md": 'o motivo "platform_cut"',
        "single.ts": "export const r = { reason: 'platform_cut' };",
        "tick.mjs": "export const r = `platform_cut`;",
      };
      for (const [name, text] of Object.entries(planted)) {
        const path = join(root, name);
        mkdirSync(join(path, ".."), { recursive: true });
        writeFileSync(path, text);
      }
      expect(
        filesWithTheReason([root])
          .map((file) => file.slice(root.length + 1))
          .sort()
      ).toEqual(["a/b/double.ts", "constant.ts", "single.ts", "tick.mjs"]);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("nenhum servidor nem pacote escreve o motivo", () => {
    const dirs = SERVER_TREES.map((dir) => join(repoRoot, dir));
    expect(dirs.flatMap((dir) => sources(dir)).length).toBeGreaterThan(500);
    expect(
      filesWithTheReason(dirs).map((file) => file.slice(repoRoot.length))
    ).toEqual([]);
  });
});
