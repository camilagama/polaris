import { afterEach, describe, expect, it, vi } from "vitest";
import {
  followMotionLevel,
  type MotionInputs,
  type MotionLevel,
  motionLevel,
  readMotionLevel,
} from "./motion-level";

/** The table of the design: the device, its size, the pointer and the preference. */
const TABLE: [string, Omit<MotionInputs, "reduced">, MotionLevel][] = [
  [
    "celular em pé (360×740)",
    { coarse: true, height: 740, width: 360 },
    "essential",
  ],
  [
    "celular em pé (393×851)",
    { coarse: true, height: 851, width: 393 },
    "essential",
  ],
  [
    "celular deitado (932×430)",
    { coarse: true, height: 430, width: 932 },
    "essential",
  ],
  [
    "celular deitado no limite da altura (800×500)",
    { coarse: true, height: 500, width: 800 },
    "essential",
  ],
  ["celular a 759 px", { coarse: true, height: 900, width: 759 }, "essential"],
  [
    "tablet em pé (820×1180)",
    { coarse: true, height: 1180, width: 820 },
    "full",
  ],
  [
    "tablet deitado (1180×820)",
    { coarse: true, height: 820, width: 1180 },
    "full",
  ],
  [
    "toque a 760 px e 501 de altura",
    { coarse: true, height: 501, width: 760 },
    "full",
  ],
  [
    "desktop de 360 px (janela estreita, mouse)",
    { coarse: false, height: 740, width: 360 },
    "full",
  ],
  [
    "desktop baixo (mouse, 1280×400)",
    { coarse: false, height: 400, width: 1280 },
    "full",
  ],
  ["desktop (1280×800)", { coarse: false, height: 800, width: 1280 }, "full"],
];

describe("motion level (ADR 0103, Níveis de movimento)", () => {
  it.each(TABLE)("%s → %s", (_name, inputs, level) => {
    expect(motionLevel({ ...inputs, reduced: false })).toBe(level);
  });

  it.each(TABLE)("%s com prefers-reduced-motion → none", (_name, inputs) => {
    expect(motionLevel({ ...inputs, reduced: true })).toBe("none");
  });
});

describe("the level in the browser", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** A window with the given media and size; `fire()` calls the listeners of every query, as a `change` would. */
  function stubWindow(state: {
    coarse: boolean;
    height: number;
    reduced: boolean;
    width: number;
  }) {
    const listeners = new Set<() => void>();
    vi.stubGlobal("window", {
      get innerHeight() {
        return state.height;
      },
      get innerWidth() {
        return state.width;
      },
      matchMedia: (query: string) => ({
        addEventListener: (_type: string, listener: () => void) =>
          listeners.add(listener),
        matches:
          (query === "(pointer: coarse)" && state.coarse) ||
          (query === "(prefers-reduced-motion: reduce)" && state.reduced),
        removeEventListener: (_type: string, listener: () => void) =>
          listeners.delete(listener),
      }),
    });
    return {
      fire: () => {
        for (const listener of listeners) {
          listener();
        }
      },
      listeners,
    };
  }

  it("with no window it is the safe level, with no dispensable motion", () => {
    vi.stubGlobal("window", undefined);
    expect(readMotionLevel()).toBe("essential");
  });

  it("writes data-motion on the root and follows the changes until it stops", () => {
    const state = { coarse: true, height: 740, reduced: false, width: 360 };
    const media = stubWindow(state);
    const root = { dataset: {} as Record<string, string> };
    const stop = followMotionLevel(root as unknown as HTMLElement);
    expect(root.dataset.motion).toBe("essential");

    // the phone turned into a tablet-sized window: the change of one of the lines of size says so
    state.width = 820;
    state.height = 1180;
    media.fire();
    expect(root.dataset.motion).toBe("full");

    // the system asked for no motion
    state.reduced = true;
    media.fire();
    expect(root.dataset.motion).toBe("none");

    stop();
    expect(media.listeners.size).toBe(0);
  });
});
