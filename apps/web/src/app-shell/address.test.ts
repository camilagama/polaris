import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isMarkedEntry, pushAddress, replaceAddress } from "./address";

interface FakeHistory {
  entries: { state: unknown; url: string }[];
  index: number;
  pushState: (state: unknown, title: string, url: string) => void;
  replaceState: (state: unknown, title: string, url: string) => void;
  readonly state: unknown;
}

function fakeWindow(start: string) {
  const history: FakeHistory = {
    entries: [{ state: null, url: start }],
    index: 0,
    pushState(state, _title, url) {
      history.entries.splice(history.index + 1, Number.POSITIVE_INFINITY, {
        state,
        url,
      });
      history.index += 1;
    },
    replaceState(state, _title, url) {
      history.entries[history.index] = { state, url };
    },
    get state() {
      return history.entries[history.index]?.state;
    },
  };
  const events: string[] = [];
  const location = {
    get hash() {
      return "";
    },
    get pathname() {
      return new URL(history.entries[history.index]?.url ?? "", "http://x")
        .pathname;
    },
    get search() {
      return new URL(history.entries[history.index]?.url ?? "", "http://x")
        .search;
    },
  };
  vi.stubGlobal("window", {
    dispatchEvent: (event: Event) => {
      events.push(event.type);
      return true;
    },
    history,
    location,
  });
  return { events, history };
}

describe("pushAddress", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "Event",
      class FakeEvent {
        type: string;
        constructor(type: string) {
          this.type = type;
        }
      }
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("adds a step to the history, marked, and tells the shell", () => {
    const { events, history } = fakeWindow("/configuracoes");
    expect(isMarkedEntry("from-list")).toBe(false);
    pushAddress("/configuracoes?aba=senha", "from-list");
    expect(history.entries.map((entry) => entry.url)).toEqual([
      "/configuracoes",
      "/configuracoes?aba=senha",
    ]);
    expect(isMarkedEntry("from-list")).toBe(true);
    expect(isMarkedEntry("other")).toBe(false);
    expect(events).toEqual(["polaris:address"]);
  });

  it("keeps the mark through a rewrite of the same entry and leaves the entry before unmarked", () => {
    const { history } = fakeWindow("/configuracoes");
    pushAddress("/configuracoes?aba=senha", "from-list");
    replaceAddress("/configuracoes?aba=senha&x=1");
    expect(isMarkedEntry("from-list")).toBe(true);
    history.index = 0;
    expect(isMarkedEntry("from-list")).toBe(false);
  });
});
