import { describe, expect, it } from "vitest";
import { type AutoSwapPage, startAutoSwap } from "./auto-swap";
import {
  IDLE_MS,
  NO_PENDING_WORK,
  RETURN_AFTER_MS,
  type SwapMoment,
} from "./update-model";
import type { PendingBuild, UpdateSnapshot } from "./update-store";

const MINUTE = 60 * 1000;

/** A page with a clock, its visibility and its timers, all driven by the test. */
function setup(options: { pending?: boolean } = {}) {
  let now = 0;
  let visibility: DocumentVisibilityState = "visible";
  const documentListeners = new Map<string, (() => void)[]>();
  const windowListeners = new Map<string, (() => void)[]>();
  const timers = new Map<number, { at: number; run: () => void }>();
  let nextTimer = 1;
  const guardListeners = new Set<() => void>();
  const storeListeners = new Set<() => void>();
  const asked: SwapMoment[] = [];
  const pendingBuild: PendingBuild = {
    build: null,
    firstSeenAt: 0,
    kind: "waiting",
  };
  let snapshot: UpdateSnapshot = {
    current: null,
    pending: options.pending === false ? null : pendingBuild,
    swapping: false,
    work: NO_PENDING_WORK,
  };
  const add =
    (map: Map<string, (() => void)[]>) => (type: string, run: () => void) => {
      map.set(type, [...(map.get(type) ?? []), run]);
    };
  const page: AutoSwapPage = {
    addDocumentListener: add(documentListeners),
    addWindowListener: add(windowListeners),
    clearTimeout: (timer) => {
      timers.delete(timer as unknown as number);
    },
    now: () => now,
    setTimeout: (run, ms) => {
      const id = nextTimer;
      nextTimer += 1;
      timers.set(id, { at: now + ms, run });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    subscribeGuard: (listener) => {
      guardListeners.add(listener);
      return () => guardListeners.delete(listener);
    },
    visibility: () => visibility,
  };
  startAutoSwap(
    {
      getSnapshot: () => snapshot,
      subscribe: (listener) => {
        storeListeners.add(listener);
        return () => storeListeners.delete(listener);
      },
      trySwap: (moment) => {
        asked.push(moment);
        return Promise.resolve(false);
      },
    },
    page
  );
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return {
    /** Time passes: the timers due run, in order. */
    async advance(ms: number) {
      const until = now + ms;
      for (;;) {
        const [due] = [...timers.entries()]
          .filter(([, timer]) => timer.at <= until)
          .sort(([, a], [, b]) => a.at - b.at);
        if (!due) {
          break;
        }
        timers.delete(due[0]);
        now = due[1].at;
        due[1].run();
        // biome-ignore lint/performance/noAwaitInLoops: each timer settles before the next one runs
        await settle();
      }
      now = until;
    },
    asked,
    async becomes(next: DocumentVisibilityState) {
      visibility = next;
      for (const run of documentListeners.get("visibilitychange") ?? []) {
        run();
      }
      await settle();
    },
    async guardChanged() {
      for (const run of guardListeners) {
        run();
      }
      await settle();
    },
    async newBuild() {
      snapshot = { ...snapshot, pending: { ...pendingBuild } };
      for (const run of storeListeners) {
        run();
      }
      await settle();
    },
    async touch(type = "pointerdown") {
      for (const run of windowListeners.get(type) ?? []) {
        run();
      }
      await settle();
    },
  };
}

describe("the moments of a swap", () => {
  it("asks when the tab goes to the background", async () => {
    const page = setup();
    await page.becomes("hidden");
    expect(page.asked).toEqual(["hidden"]);
  });

  it("asks nothing with no build waiting", async () => {
    const page = setup({ pending: false });
    await page.becomes("hidden");
    await page.advance(IDLE_MS * 2);
    expect(page.asked).toEqual([]);
  });

  it("asks again while hidden when what held the swap goes away (the dialog closed)", async () => {
    const page = setup();
    await page.becomes("hidden");
    await page.guardChanged();
    expect(page.asked).toEqual(["hidden", "hidden"]);
  });

  it("asks when the tab comes back after 5 min away, before the first touch", async () => {
    const page = setup();
    await page.becomes("hidden");
    await page.advance(RETURN_AFTER_MS);
    page.asked.length = 0;
    await page.becomes("visible");
    expect(page.asked).toEqual(["return"]);
  });

  it("does not ask when the tab comes back after less than 5 min", async () => {
    const page = setup();
    await page.becomes("hidden");
    await page.advance(RETURN_AFTER_MS - 1);
    page.asked.length = 0;
    await page.becomes("visible");
    await page.guardChanged();
    expect(page.asked).toEqual([]);
  });

  it("a build found on the way back still goes in before the first touch, and not after it", async () => {
    const page = setup({ pending: false });
    await page.becomes("hidden");
    await page.advance(10 * MINUTE);
    await page.becomes("visible");
    await page.newBuild();
    expect(page.asked).toEqual(["return"]);
    // the first touch ends the way back: what changes afterwards waits for another moment
    await page.touch();
    await page.guardChanged();
    expect(page.asked).toEqual(["return"]);
  });

  it.each(["keydown", "pointerdown", "scroll", "touchstart", "wheel"])(
    "a %s ends the way back",
    async (type) => {
      const page = setup();
      await page.becomes("hidden");
      await page.advance(RETURN_AFTER_MS);
      await page.becomes("visible");
      await page.touch(type);
      page.asked.length = 0;
      await page.guardChanged();
      expect(page.asked).toEqual([]);
    }
  );

  it("asks for the idle swap after 15 min in front with no touch, key or scroll", async () => {
    const page = setup();
    await page.advance(IDLE_MS - 1);
    expect(page.asked).toEqual([]);
    await page.advance(1);
    expect(page.asked).toEqual(["idle"]);
  });

  it("a touch starts the 15 min again", async () => {
    const page = setup();
    await page.advance(10 * MINUTE);
    await page.touch("keydown");
    await page.advance(10 * MINUTE);
    expect(page.asked).toEqual([]);
    await page.advance(5 * MINUTE);
    expect(page.asked).toEqual(["idle"]);
  });

  it("keeps asking while idle (the build may not have waited 24 h yet)", async () => {
    const page = setup();
    await page.advance(IDLE_MS * 3);
    expect(page.asked).toEqual(["idle", "idle", "idle"]);
  });
});
