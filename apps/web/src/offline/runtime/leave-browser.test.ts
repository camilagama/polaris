import { afterEach, describe, expect, it, vi } from "vitest";
import { SESSION_MARKER_KEY } from "../../lib/session-marker";
import { CLOSED_STORES_KEY } from "../../organization/closed-stores-memory";
import { leaveAfterSignOut, leaveTo } from "./leave-browser";

function fakeWindow() {
  const stored = new Map<string, string>();
  const assign = vi.fn();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => stored.get(key) ?? null,
      removeItem: (key: string) => stored.delete(key),
      setItem: (key: string, value: string) => stored.set(key, value),
    },
    location: { assign },
  });
  return { assign, stored };
}

describe("leaving the page", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("marks that the person left on purpose, then goes (U-01)", () => {
    const { assign, stored } = fakeWindow();
    leaveAfterSignOut("/");
    expect(stored.get(SESSION_MARKER_KEY)).toBe("saiu");
    expect(assign).toHaveBeenCalledWith("/");
  });

  it("does not claim the person left when the session was refused", () => {
    const { assign, stored } = fakeWindow();
    leaveTo("/entrar?motivo=sessao");
    expect(stored.has(SESSION_MARKER_KEY)).toBe(false);
    expect(assign).toHaveBeenCalledWith("/entrar?motivo=sessao");
  });

  it("forgets the closed stores of the session too: the next person must not see their names", () => {
    const { stored } = fakeWindow();
    stored.set(
      CLOSED_STORES_KEY,
      JSON.stringify([{ id: "a", name: "Doce Mel" }])
    );
    leaveTo("/");
    expect(stored.has(CLOSED_STORES_KEY)).toBe(false);
  });
});
