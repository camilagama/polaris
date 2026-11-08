import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const script = readFileSync(
  new URL("../../public/boot-retry.js", import.meta.url),
  "utf8"
);
const ORIGIN = "https://app.example";
const MARK = "polaris:entry-reload";

class FakeScript {
  readonly src: string;
  readonly type: string;
  constructor(src: string, type: string) {
    this.src = src;
    this.type = type;
  }
}

interface Options {
  online?: boolean;
  storage?: "get-throws" | "set-throws" | Map<string, string>;
}

type Listener = (event: { target: unknown }) => void;

function fakeStorage(storage: Options["storage"]) {
  if (storage === "get-throws") {
    throw new Error("SecurityError");
  }
  const values = storage instanceof Map ? storage : new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    removeItem: (key: string) => values.delete(key),
    setItem: (key: string, value: string) => {
      if (storage === "set-throws") {
        throw new Error("QuotaExceededError");
      }
      values.set(key, value);
    },
  };
}

/** Runs public/boot-retry.js as the browser would and returns how to fire its events and what it did. */
function load({ online = true, storage = new Map() }: Options = {}) {
  const listeners = new Map<string, Listener[]>();
  const result = { captured: false, reloads: 0 };
  const window = {
    addEventListener: (type: string, listener: Listener, capture = false) => {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
      if (type === "error") {
        result.captured = capture;
      }
    },
    location: {
      origin: ORIGIN,
      reload: () => {
        result.reloads += 1;
      },
    },
    navigator: { onLine: online },
    get sessionStorage() {
      return fakeStorage(storage);
    },
  };
  runInNewContext(script, { HTMLScriptElement: FakeScript, window });
  const fire = (type: string, target?: unknown) => {
    for (const listener of listeners.get(type) ?? []) {
      listener({ target });
    }
  };
  return { fire, result };
}

const entry = new FakeScript(`${ORIGIN}/assets/index-abc.js`, "module");

describe("public/boot-retry.js", () => {
  it("listens in the capture phase: the error of a <script> does not bubble", () => {
    expect(load().result.captured).toBe(true);
  });

  it("the entry module that failed to download reloads the page once and leaves the mark", () => {
    const storage = new Map<string, string>();
    const { fire, result } = load({ storage });
    fire("error", entry);
    fire("load");
    expect(result.reloads).toBe(1);
    expect(storage.has(MARK)).toBe(true);
  });

  it("with the mark of a reload, a new failure does not reload again, however late it comes", () => {
    const storage = new Map([[MARK, "1"]]);
    const { fire, result } = load({ storage });
    fire("error", entry);
    fire("load");
    expect(result.reloads).toBe(0);
    expect(storage.has(MARK)).toBe(true);
  });

  it("a load that gets through takes the mark away: the next failure reloads once more", () => {
    const storage = new Map([[MARK, "1"]]);
    load({ storage }).fire("load");
    expect(storage.has(MARK)).toBe(false);

    const next = load({ storage });
    next.fire("error", entry);
    expect(next.result.reloads).toBe(1);
  });

  it("offline it does not reload: the browser would show its error page instead", () => {
    const { fire, result } = load({ online: false });
    fire("error", entry);
    expect(result.reloads).toBe(0);
  });

  it.each(["get-throws", "set-throws"] as const)(
    "a session storage that refuses (%s) never reloads: it could not stop a loop",
    (storage) => {
      const { fire, result } = load({ storage });
      fire("error", entry);
      expect(result.reloads).toBe(0);
    }
  );

  it.each([
    ["an image", { src: `${ORIGIN}/icons/icon-192.png` }],
    ["a classic script", new FakeScript(`${ORIGIN}/assets/index-abc.js`, "")],
    [
      "a module of another origin",
      new FakeScript("https://other.example/assets/x.js", "module"),
    ],
    ["a module outside /assets/", new FakeScript(`${ORIGIN}/sw.js`, "module")],
  ])("the error of %s is not the entry's: no reload", (_, target) => {
    const { fire, result } = load();
    fire("error", target);
    expect(result.reloads).toBe(0);
  });
});
