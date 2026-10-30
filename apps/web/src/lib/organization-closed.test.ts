import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearOrganizationsClosedHere,
  closedStoreToShow,
  markOrganizationClosed,
  organizationsClosedHere,
  requestedOrganizationId,
  subscribeOrganizationsClosed,
} from "./organization-closed";

describe("the stores refused as closed", () => {
  afterEach(() => clearOrganizationsClosedHere());

  it("starts with none", () => {
    expect(organizationsClosedHere()).toEqual([]);
  });

  it("keeps every refused store, in the order of the refusals", () => {
    markOrganizationClosed("a");
    markOrganizationClosed("b");
    expect(organizationsClosedHere()).toEqual(["a", "b"]);
  });

  it("keeps the same two stores whichever came first", () => {
    markOrganizationClosed("b");
    markOrganizationClosed("a");
    expect(organizationsClosedHere()).toEqual(["b", "a"]);
  });

  it("does not repeat a store nor tell anyone again about it", () => {
    const listener = vi.fn();
    markOrganizationClosed("a");
    const before = organizationsClosedHere();
    const unsubscribe = subscribeOrganizationsClosed(listener);
    markOrganizationClosed("a");
    expect(organizationsClosedHere()).toBe(before);
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("ignores an empty id", () => {
    markOrganizationClosed("");
    expect(organizationsClosedHere()).toEqual([]);
  });

  it("gives a new list on every refusal, so a reader sees the change", () => {
    markOrganizationClosed("a");
    const first = organizationsClosedHere();
    markOrganizationClosed("b");
    expect(organizationsClosedHere()).not.toBe(first);
    expect(first).toEqual(["a"]);
  });

  it("is cleared as a whole, and only tells when there was something", () => {
    clearOrganizationsClosedHere();
    const listener = vi.fn();
    const unsubscribe = subscribeOrganizationsClosed(listener);
    expect(listener).not.toHaveBeenCalled();

    markOrganizationClosed("a");
    markOrganizationClosed("b");
    clearOrganizationsClosedHere();
    expect(organizationsClosedHere()).toEqual([]);
    expect(listener).toHaveBeenCalledTimes(3);
    unsubscribe();
  });
});

describe("the store whose notice is shown", () => {
  it("is the only refused one, as before", () => {
    expect(closedStoreToShow(["a"], null, false)).toBe("a");
    expect(closedStoreToShow(["a"], "a", false)).toBe("a");
  });

  it("is none while nothing was refused and the runtime knows nothing", () => {
    expect(closedStoreToShow([], null, false)).toBeNull();
    expect(closedStoreToShow([], "a", false)).toBeNull();
  });

  it("prefers the open store when it was refused after another one", () => {
    expect(closedStoreToShow(["a", "b"], "b", false)).toBe("b");
  });

  it("prefers the open store when it was refused before another one", () => {
    expect(closedStoreToShow(["b", "a"], "b", false)).toBe("b");
  });

  it("keeps the other refused store for when it is opened", () => {
    expect(closedStoreToShow(["a", "b"], "c", false)).toBeNull();
    expect(closedStoreToShow(["a", "b"], "a", false)).toBe("a");
  });

  it("takes the first refused while no store is open yet", () => {
    expect(closedStoreToShow(["b", "a"], null, false)).toBe("b");
  });

  it("is the open store when the runtime knows it is closed, even with another refused before", () => {
    expect(closedStoreToShow(["a"], "b", true)).toBe("b");
  });

  it("does not take the runtime's word for a store that is not open", () => {
    expect(closedStoreToShow([], null, true)).toBeNull();
  });
});

describe("the organization a call was made for", () => {
  it("reads the requested context of the input", () => {
    expect(requestedOrganizationId({ organizationId: "a" })).toBe("a");
    expect(requestedOrganizationId({ organizationId: 1 })).toBeNull();
    expect(requestedOrganizationId(null)).toBeNull();
    expect(requestedOrganizationId("a")).toBeNull();
  });
});
