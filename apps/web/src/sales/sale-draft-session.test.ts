import { afterEach, describe, expect, it, vi } from "vitest";

const ORG = "0199c2d0-0000-7000-8000-00000000a001";
const OTHER = "0199c2d0-0000-7000-8000-00000000a002";
const DRAFT = "polaris.sale.draft.v1:";

function memory() {
  const stored = new Map<string, string>();
  return {
    storage: {
      getItem: (key: string) => stored.get(key) ?? null,
      key: (index: number) => [...stored.keys()][index] ?? null,
      get length() {
        return stored.size;
      },
      removeItem: (key: string) => stored.delete(key),
      setItem: (key: string, value: string) => stored.set(key, value),
    },
    stored,
  };
}

/** The tab with a draft of two stores and the sale's attempt, and the device's storage beside it. */
function tabWithDrafts() {
  const tab = memory();
  const device = memory();
  vi.stubGlobal("window", {
    localStorage: device.storage,
    location: { assign: vi.fn() },
    sessionStorage: tab.storage,
  });
  for (const organization of [ORG, OTHER]) {
    tab.stored.set(`${DRAFT}${organization}`, "{}");
  }
  tab.stored.set(`polaris.sale.attempt.v1:${ORG}`, "{}");
  return tab;
}

/** Fresh modules for each case: the session's end is module state that never goes back. */
async function modules() {
  vi.resetModules();
  const [leave, ended] = await Promise.all([
    import("../offline/runtime/leave-browser"),
    import("../offline/runtime/session-ended"),
  ]);
  return { ended, leave };
}

const drafts = (stored: Map<string, string>) =>
  [...stored.keys()].filter((key) => key.startsWith(DRAFT));

describe("the sale draft goes with the session", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("'Sair' forgets the draft of every store of the tab", async () => {
    const tab = tabWithDrafts();
    const m = await modules();

    m.leave.leaveAfterSignOut("/");

    expect(drafts(tab.stored)).toEqual([]);
    // the attempt is identifiers only and keeps its own 30 min rule
    expect([...tab.stored.keys()]).toEqual([`polaris.sale.attempt.v1:${ORG}`]);
  });

  it("a session refused (endSessionHere) forgets them too", async () => {
    const tab = tabWithDrafts();
    const m = await modules();

    m.ended.endSessionHere();

    expect(drafts(tab.stored)).toEqual([]);
  });
});
