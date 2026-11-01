import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface Slot {
  cleanup?: (() => void) | undefined;
  value?: unknown;
}

const runtime = {
  cursor: 0,
  dirty: false,
  slots: [] as Slot[],
};

function nextSlot(): Slot {
  const index = runtime.cursor;
  runtime.cursor = index + 1;
  const slot = runtime.slots[index] ?? {};
  runtime.slots[index] = slot;
  return slot;
}

vi.mock("react", () => ({
  useEffect: (effect: () => (() => void) | undefined) => {
    const slot = nextSlot();
    if (!("value" in slot)) {
      slot.value = true;
      slot.cleanup = effect();
    }
  },
  useState: <T,>(initial: T | (() => T)) => {
    const slot = nextSlot();
    if (!("value" in slot)) {
      slot.value =
        typeof initial === "function" ? (initial as () => T)() : initial;
    }
    const set = (next: T) => {
      if (!Object.is(slot.value, next)) {
        slot.value = next;
        runtime.dirty = true;
      }
    };
    return [slot.value as T, set];
  },
}));

const { STORE_TODAY_TICK_MS, useStoreToday } = await import(
  "./use-store-today"
);

let tick: (() => void) | undefined;
let intervalMs: number | undefined;
let visible: (() => void) | undefined;
let renders = 0;
let shown = "";

function renderOnce(timezone: string | null) {
  runtime.dirty = false;
  runtime.cursor = 0;
  shown = useStoreToday(timezone);
  renders += 1;
}

function render(timezone: string | null) {
  renderOnce(timezone);
  while (isDirty()) {
    renderOnce(timezone);
  }
}

function isDirty(): boolean {
  return runtime.dirty;
}

function setClock(instant: string) {
  vi.setSystemTime(new Date(instant));
}

beforeEach(() => {
  vi.useFakeTimers({ now: new Date("2026-10-31T12:00:00Z"), toFake: ["Date"] });
  runtime.slots = [];
  runtime.cursor = 0;
  tick = undefined;
  intervalMs = undefined;
  visible = undefined;
  renders = 0;
  vi.stubGlobal("window", {
    clearInterval: () => undefined,
    setInterval: (callback: () => void, ms: number) => {
      tick = callback;
      intervalMs = ms;
      return 1;
    },
  });
  vi.stubGlobal("document", {
    addEventListener: (_type: string, callback: () => void) => {
      visible = callback;
    },
    removeEventListener: () => undefined,
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useStoreToday", () => {
  it("turns to the new month at midnight of São Paulo, not of the device (UTC is already November)", () => {
    setClock("2026-11-01T02:50:00Z");
    render("America/Sao_Paulo");
    expect(shown).toBe("2026-10-31");
    setClock("2026-11-01T03:00:00Z");
    tick?.();
    render("America/Sao_Paulo");
    expect(shown).toBe("2026-11-01");
  });

  it("reads the day of the store's zone, not the device's", () => {
    setClock("2026-11-01T02:50:00Z");
    render("UTC");
    expect(shown).toBe("2026-11-01");
  });

  it("turns the year at midnight of the store", () => {
    setClock("2027-01-01T02:50:00Z");
    render("America/Sao_Paulo");
    expect(shown).toBe("2026-12-31");
    setClock("2027-01-01T03:00:00Z");
    tick?.();
    render("America/Sao_Paulo");
    expect(shown).toBe("2027-01-01");
  });

  it("a tab that wakes up late reads the day again at once", () => {
    setClock("2026-10-31T20:00:00Z");
    render("America/Sao_Paulo");
    setClock("2026-11-02T20:00:00Z");
    visible?.();
    render("America/Sao_Paulo");
    expect(shown).toBe("2026-11-02");
  });

  it("the minute tick inside the same day does not render again, and the turn renders once", () => {
    setClock("2026-10-31T12:00:00Z");
    render("America/Sao_Paulo");
    expect(intervalMs).toBe(STORE_TODAY_TICK_MS);
    expect(STORE_TODAY_TICK_MS).toBe(60_000);
    const first = renders;
    expect(first).toBe(1);

    for (let minute = 1; minute <= 600; minute += 1) {
      setClock(
        new Date(
          Date.parse("2026-10-31T12:00:00Z") + minute * 60_000
        ).toISOString()
      );
      tick?.();
      expect(isDirty()).toBe(false);
    }
    expect(renders).toBe(first);

    setClock("2026-11-01T03:00:00Z");
    tick?.();
    expect(isDirty()).toBe(true);
    render("America/Sao_Paulo");
    expect(renders).toBe(first + 1);
    expect(shown).toBe("2026-11-01");
  });
});
