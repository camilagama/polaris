import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  browserStorage,
  followSystemTheme,
  parseTheme,
  readTheme,
  saveTheme,
  THEME_STORAGE_KEY,
  themeColorMedia,
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

  it("a localStorage that throws on access means no storage, not a crash", () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "window");
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        get localStorage(): Storage {
          throw new Error("SecurityError");
        },
      },
    });
    try {
      expect(browserStorage()).toBeUndefined();
      expect(readTheme(browserStorage())).toBe("sistema");
    } finally {
      if (original) {
        Object.defineProperty(globalThis, "window", original);
      } else {
        Reflect.deleteProperty(globalThis, "window");
      }
    }
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

describe("themeColorMedia", () => {
  it("each meta follows its scheme with the system, and only the chosen one applies otherwise", () => {
    expect(themeColorMedia("sistema", "claro")).toBe(
      "(prefers-color-scheme: light)"
    );
    expect(themeColorMedia("sistema", "escuro")).toBe(
      "(prefers-color-scheme: dark)"
    );
    expect(themeColorMedia("escuro", "escuro")).toBe("all");
    expect(themeColorMedia("escuro", "claro")).toBe("not all");
    expect(themeColorMedia("claro", "claro")).toBe("all");
    expect(themeColorMedia("claro", "escuro")).toBe("not all");
  });
});

describe("followSystemTheme (U-40)", () => {
  function fakeSystem(startsDark: boolean) {
    const listeners = new Set<() => void>();
    const classes = new Set<string>(startsDark ? ["dark"] : []);
    const query = {
      addEventListener: (_type: string, listener: () => void) =>
        listeners.add(listener),
      matches: startsDark,
      removeEventListener: (_type: string, listener: () => void) =>
        listeners.delete(listener),
    };
    const root = {
      classList: {
        toggle: (name: string, on: boolean) =>
          on ? classes.add(name) : classes.delete(name),
      },
    } as unknown as Pick<Element, "classList">;
    return {
      classes,
      listeners,
      query,
      root,
      setSystemDark(dark: boolean) {
        query.matches = dark;
        for (const listener of listeners) {
          listener();
        }
      },
    };
  }

  it("takes the dark class off when the system goes back to light, and puts it back", () => {
    const system = fakeSystem(true);
    followSystemTheme(system.query, memoryStorage(), system.root);
    system.setSystemDark(false);
    expect(system.classes.has("dark")).toBe(false);
    system.setSystemDark(true);
    expect(system.classes.has("dark")).toBe(true);
  });

  it("keeps a chosen theme whatever the system does", () => {
    const system = fakeSystem(false);
    followSystemTheme(system.query, memoryStorage("escuro"), system.root);
    system.setSystemDark(true);
    system.setSystemDark(false);
    expect(system.classes.has("dark")).toBe(true);
    const light = fakeSystem(true);
    followSystemTheme(light.query, memoryStorage("claro"), light.root);
    light.setSystemDark(true);
    expect(light.classes.has("dark")).toBe(false);
  });

  it("stops listening when asked", () => {
    const system = fakeSystem(false);
    const stop = followSystemTheme(system.query, memoryStorage(), system.root);
    expect(system.listeners.size).toBe(1);
    stop();
    expect(system.listeners.size).toBe(0);
  });
});
