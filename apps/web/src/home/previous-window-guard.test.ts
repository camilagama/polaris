import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Only the Início takes the "janela anterior" from the copy of the day: the Resultado, the Histórico and the Meta keep
 * reading the server. The copy is reached by two names, `reusablePreviousWindow` (to take it) and `previousWindowMemory`
 * (the page's memory): outside the files below nothing may name them. A sale's screen may only take the copy back
 * (`invalidatePreviousWindow`), and so may the Despesas.
 */
const SRC = join(import.meta.dirname, "..");
const SOURCE_FILE = /\.(?:ts|tsx)$/;
const TEST_FILE = /\.test\.tsx?$/;
const KNOWS_THE_COPY = /previous-window-copy|previousWindowMemory/;
const TAKES_THE_COPY = new Set([
  "home/previous-window-copy.ts",
  "home/use-home.ts",
]);
const MEMORY = new Set([
  "home/previous-window-copy.ts",
  "lib/period-summary-cache.ts",
]);
const INVALIDATES = new Set([
  "expenses/expenses-page.tsx",
  "home/previous-window-copy.ts",
  "sales/sale-detail-page.tsx",
]);

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "generated" ? [] : sources(path);
    }
    return SOURCE_FILE.test(entry.name) && !TEST_FILE.test(entry.name)
      ? [path]
      : [];
  });
}

function filesNaming(name: string): string[] {
  return sources(SRC)
    .filter((path) => readFileSync(path, "utf8").includes(name))
    .map((path) => relative(SRC, path).split(sep).join("/"))
    .sort();
}

describe("quem usa a cópia da janela anterior", () => {
  it("só o Início a toma no lugar de uma leitura", () => {
    expect(filesNaming("reusablePreviousWindow")).toEqual(
      [...TAKES_THE_COPY].sort()
    );
  });

  it("a memória da página é tocada só pelo módulo da cópia e pelas purgas", () => {
    expect(filesNaming("previousWindowMemory")).toEqual([...MEMORY].sort());
  });

  it("a devolução, o cancelamento e a despesa só a tiram, nas telas da venda e das despesas", () => {
    expect(filesNaming("invalidatePreviousWindow")).toEqual(
      [...INVALIDATES].sort()
    );
  });

  it("o Resultado, o Histórico e a Meta não a conhecem", () => {
    const files = sources(SRC).map((path) =>
      relative(SRC, path).split(sep).join("/")
    );
    for (const screen of [
      "dashboard",
      "sales/sale-history",
      "home/home-goal",
    ]) {
      const ofScreen = files.filter((path) => path.startsWith(screen));
      // a prefix that matches no file checks nothing
      expect(ofScreen.length).toBeGreaterThan(0);
      expect(
        ofScreen.filter((path) =>
          KNOWS_THE_COPY.test(readFileSync(join(SRC, path), "utf8"))
        )
      ).toEqual([]);
    }
  });
});
