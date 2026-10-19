import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SESSION_ENDED_MESSAGE } from "./session-ended-text";

const SOURCE_FILE = /\.(ts|tsx)$/;
const OLD_TEXT = "sessão não está ativa";
const SOURCE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const THIS_FILE = fileURLToPath(import.meta.url);

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(path);
    }
    return SOURCE_FILE.test(entry.name) ? [path] : [];
  });
}

describe("the session-ended sentence", () => {
  it("is the one the corte asks for", () => {
    expect(SESSION_ENDED_MESSAGE).toBe(
      "Sua sessão acabou. Entre de novo para continuar."
    );
  });

  it("is the only wording left in the app: the old loose text is gone (AC-17)", () => {
    const stillThere = sourceFiles(SOURCE_ROOT).filter(
      (file) =>
        file !== THIS_FILE &&
        readFileSync(file, "utf8").toLowerCase().includes(OLD_TEXT)
    );
    expect(stillThere).toEqual([]);
  });
});
