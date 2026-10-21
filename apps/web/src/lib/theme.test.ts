import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  parseTheme,
  readTheme,
  saveTheme,
  THEME_STORAGE_KEY,
  themeIsDark,
} from "./theme";

const BEYOND_THE_CLASS =
  /<style|innerHTML|insertAdjacentHTML|document\.write|setAttribute|\.style\b/;
const initScript = readFileSync(
  new URL("../../public/theme-init.js", import.meta.url),
  "utf8"
);

function memoryStorage(initial?: string) {
  const values = new Map<string, string>();
  if (initial !== undefined) {
    values.set(THEME_STORAGE_KEY, initial);
  }
  return {
    getItem: (key: string) => values.get(key) ?? null,
    removeItem: (key: string) => values.delete(key),
    setItem: (key: string, value: string) => values.set(key, value),
    values,
  };
}

/** Runs public/theme-init.js as the browser would and says whether it set the `dark` class. */
function runInit(stored: string | null | "throws", systemDark: boolean) {
  const classes = new Set<string>();
  const window = {
    localStorage: {
      getItem: () => {
        if (stored === "throws") {
          throw new Error("SecurityError");
        }
        return stored;
      },
    },
    matchMedia: (query: string) => ({
      matches: query === "(prefers-color-scheme: dark)" && systemDark,
    }),
  };
  const document = {
    documentElement: {
      classList: {
        toggle: (name: string, on: boolean) =>
          on ? classes.add(name) : classes.delete(name),
      },
    },
  };
  runInNewContext(initScript, { document, window });
  return classes.has("dark");
}

describe("theme (ADR 0103, Tema e CSP)", () => {
  it("reads only the closed list; anything else follows the system", () => {
    expect(parseTheme("claro")).toBe("claro");
    expect(parseTheme("escuro")).toBe("escuro");
    expect(parseTheme("sistema")).toBe("sistema");
    for (const value of [null, undefined, "", "dark", "ESCURO", "<style>"]) {
      expect(parseTheme(value)).toBe("sistema");
    }
  });

  it("dark is 'escuro', or 'sistema' with a dark system", () => {
    expect(themeIsDark("escuro", false)).toBe(true);
    expect(themeIsDark("claro", true)).toBe(false);
    expect(themeIsDark("sistema", true)).toBe(true);
    expect(themeIsDark("sistema", false)).toBe(false);
  });

  it("keeps 'claro' and 'escuro' and forgets the key for 'sistema'", () => {
    const storage = memoryStorage();
    saveTheme(storage, "escuro");
    expect(storage.values.get(THEME_STORAGE_KEY)).toBe("escuro");
    expect(readTheme(storage)).toBe("escuro");
    saveTheme(storage, "sistema");
    expect(storage.values.has(THEME_STORAGE_KEY)).toBe(false);
  });

  it("a storage that refuses means the system, and saving does not throw", () => {
    const refusing = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      removeItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    expect(readTheme(refusing)).toBe("sistema");
    expect(() => saveTheme(refusing, "claro")).not.toThrow();
    expect(readTheme(undefined)).toBe("sistema");
  });

  it.each([
    [null, false],
    [null, true],
    ["claro", false],
    ["claro", true],
    ["escuro", false],
    ["escuro", true],
    ["sistema", true],
    ["qualquer", true],
    ["qualquer", false],
    ["throws", true],
    ["throws", false],
  ] as const)(
    "theme-init.js agrees with the module: stored %s, dark system %s",
    (stored, systemDark) => {
      const expected = themeIsDark(
        stored === "throws" ? "sistema" : parseTheme(stored),
        systemDark
      );
      expect(runInit(stored, systemDark)).toBe(expected);
    }
  );

  it("theme-init.js touches nothing but the class: no style, no HTML, no other storage key", () => {
    expect(initScript).not.toMatch(BEYOND_THE_CLASS);
    expect(initScript.match(/getItem\("([^"]+)"\)/g)).toEqual([
      `getItem("${THEME_STORAGE_KEY}")`,
    ]);
  });
});
