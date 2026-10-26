import { describe, expect, it } from "vitest";
import { holdSyncLeadership } from "./sync-leader";

async function flush() {
  for (let i = 0; i < 10; i += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: each turn lets the next microtask run
    await Promise.resolve();
  }
}

/** One lock manager for the tabs of a browser: exclusive locks, granted in the order asked. */
function lockManager() {
  const queue: { callback: () => Promise<void>; signal: AbortSignal }[] = [];
  let held = false;
  const grantNext = () => {
    if (held) {
      return;
    }
    const next = queue.shift();
    if (!next) {
      return;
    }
    held = true;
    next.callback().finally(() => {
      held = false;
      grantNext();
    });
  };
  return {
    request(
      _name: string,
      options: { signal: AbortSignal },
      callback: () => Promise<void>
    ) {
      return new Promise<unknown>((resolve, reject) => {
        const entry = {
          callback: () => callback().then(resolve),
          signal: options.signal,
        };
        options.signal.addEventListener("abort", () => {
          const index = queue.indexOf(entry);
          if (index >= 0) {
            queue.splice(index, 1);
            reject(new DOMException("aborted", "AbortError"));
          }
        });
        queue.push(entry);
        grantNext();
      });
    },
  };
}

function tab(locks: ReturnType<typeof lockManager> | undefined) {
  const page = { listeners: new Set<() => void>(), visible: true };
  const leadership = holdSyncLeadership({
    isVisible: () => page.visible,
    locks,
    name: "polaris-sync-leader:org",
    onVisibilityChange: (listener) => {
      page.listeners.add(listener);
      return () => page.listeners.delete(listener);
    },
  });
  const show = async (visible: boolean) => {
    page.visible = visible;
    for (const listener of page.listeners) {
      listener();
    }
    await flush();
  };
  return { leadership, page, show };
}

describe("holdSyncLeadership", () => {
  it("makes one visible tab the leader and the others wait", async () => {
    const locks = lockManager();
    const first = tab(locks);
    const second = tab(locks);
    await flush();

    expect(first.leadership.isLeader()).toBe(true);
    expect(second.leadership.isLeader()).toBe(false);
  });

  it("passes the lead to the next visible tab when the leader is hidden, and back", async () => {
    const locks = lockManager();
    const first = tab(locks);
    const second = tab(locks);
    await flush();

    await first.show(false);
    expect(first.leadership.isLeader()).toBe(false);
    expect(second.leadership.isLeader()).toBe(true);

    await first.show(true);
    await second.show(false);
    expect(first.leadership.isLeader()).toBe(true);
    expect(second.leadership.isLeader()).toBe(false);
  });

  it("a hidden tab neither leads nor waits in line", async () => {
    const locks = lockManager();
    const first = tab(locks);
    const second = tab(locks);
    await flush();
    await second.show(false);

    await first.show(false);
    expect(first.leadership.isLeader()).toBe(false);
    expect(second.leadership.isLeader()).toBe(false);
  });

  it("stop lets the lock go to the next tab", async () => {
    const locks = lockManager();
    const first = tab(locks);
    const second = tab(locks);
    await flush();

    first.leadership.stop();
    await flush();

    expect(first.leadership.isLeader()).toBe(false);
    expect(second.leadership.isLeader()).toBe(true);
  });

  it("without Web Locks every tab leads, as before", () => {
    const first = tab(undefined);
    const second = tab(undefined);

    expect(first.leadership.isLeader()).toBe(true);
    expect(second.leadership.isLeader()).toBe(true);
  });
});
