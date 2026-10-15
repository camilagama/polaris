import { describe, expect, it } from "vitest";
import {
  ADAPTATION_DAYS,
  type DefaultCandidate,
  defaultSelection,
  episodeStart,
  episodeStartAfter,
  OperationalSelectionError,
  type OperationalContext,
  operationalState,
  planSelectionChange,
} from "./operational-selection";

const DAY = 86_400_000;
const since = new Date("2026-10-01T12:00:00.000Z");
const at = (days: number) => new Date(since.getTime() + days * DAY);

const over = (
  overrides: Partial<OperationalContext> = {}
): OperationalContext => ({
  limit: 50,
  liveVariants: 80,
  now: at(1),
  plan: "free",
  since,
  ...overrides,
});

describe("when the organization left Pro", () => {
  it("counts the episode from the end of Pro access, or from what the free record says", () => {
    const ended = new Date("2026-09-30T00:00:00.000Z");
    // a lapse the sweep has not stored yet is dated by the end of access
    expect(
      episodeStart({
        accessEndsAt: ended,
        overLimitSince: null,
        state: "active",
      })
    ).toEqual(ended);
    expect(
      episodeStart({
        accessEndsAt: ended,
        overLimitSince: null,
        state: "grace",
      })
    ).toEqual(ended);
    expect(
      episodeStart({
        accessEndsAt: null,
        overLimitSince: since,
        state: "free_over_limit",
      })
    ).toEqual(since);
    expect(
      episodeStart({ accessEndsAt: null, overLimitSince: null, state: "free" })
    ).toBeNull();
  });
});

describe("the episode start stored on the record", () => {
  const now = new Date("2026-10-10T00:00:00.000Z");
  const lapsed = new Date("2026-10-08T00:00:00.000Z");
  const later = new Date("2026-10-20T00:00:00.000Z");

  it("is the end of the access that lapsed, so the window runs from when Pro actually ended", () => {
    expect(
      episodeStartAfter({
        before: { accessEndsAt: lapsed, state: "active" },
        nextState: "free_over_limit",
        now,
      })
    ).toEqual(lapsed);
    expect(
      episodeStartAfter({
        before: { accessEndsAt: lapsed, state: "grace" },
        nextState: "free_over_limit",
        now,
      })
    ).toEqual(lapsed);
  });

  it("is now when Pro access is removed before its end, or the organization was already free", () => {
    expect(
      episodeStartAfter({
        before: { accessEndsAt: later, state: "active" },
        nextState: "free_over_limit",
        now,
      })
    ).toEqual(now);
    expect(
      episodeStartAfter({
        before: { accessEndsAt: null, state: "free" },
        nextState: "free_over_limit",
        now,
      })
    ).toEqual(now);
  });

  it("goes on while the organization stays over the limits, and clears when it is not over them", () => {
    expect(
      episodeStartAfter({
        before: { accessEndsAt: null, state: "free_over_limit" },
        nextState: "free_over_limit",
        now,
      })
    ).toBe("keep");
    for (const nextState of ["free", "trialing", "active"] as const) {
      expect(
        episodeStartAfter({
          before: { accessEndsAt: null, state: "free_over_limit" },
          nextState,
          now,
        })
      ).toBeNull();
    }
  });

  it("survives opening a trial checkout and abandoning it, so the window cannot be restarted that way", () => {
    // free_over_limit -> trial_setup -> free_over_limit
    expect(
      episodeStartAfter({
        before: { accessEndsAt: null, state: "free_over_limit" },
        nextState: "trial_setup",
        now,
      })
    ).toBe("keep");
    expect(
      episodeStartAfter({
        before: { accessEndsAt: null, state: "trial_setup" },
        nextState: "free_over_limit",
        now,
      })
    ).toBe("keep");
    // a free organization that was never over the limits starts no episode by opening one
    expect(
      episodeStartAfter({
        before: { accessEndsAt: null, state: "free" },
        nextState: "trial_setup",
        now,
      })
    ).toBeNull();
  });
});

describe("the operational phase", () => {
  it("is unrestricted on Pro and within the limit, however many variants there are", () => {
    expect(operationalState(over({ plan: "pro" })).phase).toBe("unrestricted");
    expect(operationalState(over({ liveVariants: 50 })).phase).toBe(
      "unrestricted"
    );
    expect(operationalState(over({ liveVariants: 0 })).phase).toBe(
      "unrestricted"
    );
    expect(
      operationalState(over({ liveVariants: 50 })).windowEndsAt
    ).toBeNull();
  });

  it("is adapting for the window after leaving Pro, then frozen", () => {
    const end = at(ADAPTATION_DAYS);
    expect(operationalState(over({ now: since }))).toEqual({
      phase: "adapting",
      windowEndsAt: end,
    });
    expect(
      operationalState(over({ now: new Date(end.getTime() - 1) })).phase
    ).toBe("adapting");
    // the window ends exactly at its end instant
    expect(operationalState(over({ now: end })).phase).toBe("frozen");
    expect(operationalState(over({ now: at(30) })).phase).toBe("frozen");
  });

  it("is frozen, never open, when no start was recorded", () => {
    expect(operationalState(over({ since: null }))).toEqual({
      phase: "frozen",
      windowEndsAt: null,
    });
  });

  it("lifts the restriction as soon as the organization is within the limit again", () => {
    expect(
      operationalState(over({ liveVariants: 51, now: at(30) })).phase
    ).toBe("frozen");
    expect(
      operationalState(over({ liveVariants: 50, now: at(30) })).phase
    ).toBe("unrestricted");
  });

  it("follows a changed limit, so a grant that raises it releases variants", () => {
    expect(operationalState(over({ limit: 100, now: at(30) })).phase).toBe(
      "unrestricted"
    );
  });
});

const ids = (...names: string[]) => new Set(names);

describe("changing the selection", () => {
  const live = ids("a", "b", "c", "d", "e");

  it("has nothing to choose when nothing is restricted", () => {
    expect(() =>
      planSelectionChange({
        current: ids(),
        limit: 3,
        live,
        phase: "unrestricted",
        requested: ["a"],
      })
    ).toThrow(OperationalSelectionError);
  });

  it("replaces the choice freely while adapting", () => {
    expect(
      planSelectionChange({
        current: ids("a", "b"),
        limit: 3,
        live,
        phase: "adapting",
        requested: ["b", "c", "d"],
      })
    ).toEqual({ add: ["c", "d"], remove: ["a"] });
    // a repeated id is one choice
    expect(
      planSelectionChange({
        current: ids(),
        limit: 1,
        live,
        phase: "adapting",
        requested: ["a", "a"],
      })
    ).toEqual({ add: ["a"], remove: [] });
    // choosing none clears what was chosen: the default applies when the window ends
    expect(
      planSelectionChange({
        current: ids("a"),
        limit: 3,
        live,
        phase: "adapting",
        requested: [],
      })
    ).toEqual({ add: [], remove: ["a"] });
  });

  it("refuses more than the limit and variants that are not live", () => {
    const refusal = (requested: string[]) => () =>
      planSelectionChange({
        current: ids(),
        limit: 2,
        live,
        phase: "adapting",
        requested,
      });
    expect(refusal(["a", "b", "c"])).toThrow(
      expect.objectContaining({ code: "selection_too_large" })
    );
    expect(refusal(["a", "gone"])).toThrow(
      expect.objectContaining({ code: "variant_unavailable" })
    );
  });

  it("only grows once frozen: no swap, no removal", () => {
    const frozen = (current: Set<string>, requested: string[]) => () =>
      planSelectionChange({
        current,
        limit: 3,
        live,
        phase: "frozen",
        requested,
      });

    // the anti-rotation case: drop a, take d
    expect(frozen(ids("a", "b"), ["b", "d"])).toThrow(
      expect.objectContaining({ code: "selection_frozen" })
    );
    expect(frozen(ids("a", "b"), ["a"])).toThrow(
      expect.objectContaining({ code: "selection_frozen" })
    );
    // growing within the limit is allowed
    expect(frozen(ids("a", "b"), ["a", "b", "c"])()).toEqual({
      add: ["c"],
      remove: [],
    });
    // but not past it
    expect(frozen(ids("a", "b"), ["a", "b", "c", "d"])).toThrow(
      expect.objectContaining({ code: "selection_too_large" })
    );
  });

  it("lets a deleted variant leave the selection and frees its place to grow", () => {
    // "x" was selected and its product was deleted since: it is not live any more
    const result = planSelectionChange({
      current: ids("a", "x"),
      limit: 2,
      live,
      phase: "frozen",
      requested: ["a", "b"],
    });
    expect(result).toEqual({ add: ["b"], remove: ["x"] });
  });
});

describe("the default selection", () => {
  const candidate = (
    variantId: string,
    createdDay: number,
    soldDay: number | null,
    archived = false
  ): DefaultCandidate => ({
    archived,
    createdAt: at(createdDay),
    lastSoldAt: soldDay === null ? null : at(soldDay),
    variantId,
  });

  it("keeps what sold most recently, then the oldest, and is deterministic", () => {
    const candidates = [
      candidate("never-new", 5, null),
      candidate("sold-old", 1, 2),
      candidate("sold-recent", 3, 9),
      candidate("never-old", 0, null),
    ];
    expect(defaultSelection(candidates, 3)).toEqual([
      "sold-recent",
      "sold-old",
      "never-old",
    ]);
    expect(defaultSelection([...candidates].reverse(), 3)).toEqual(
      defaultSelection(candidates, 3)
    );
  });

  it("ranks variants of archived products after every other one, even ones that sold", () => {
    const candidates = [
      candidate("archived-sold", 0, 9, true),
      candidate("live-never", 5, null),
    ];
    expect(defaultSelection(candidates, 1)).toEqual(["live-never"]);
    expect(defaultSelection(candidates, 2)).toEqual([
      "live-never",
      "archived-sold",
    ]);
  });

  it("breaks a full tie by id and never returns more than the limit", () => {
    const tied = [candidate("b", 1, null), candidate("a", 1, null)];
    expect(defaultSelection(tied, 1)).toEqual(["a"]);
    expect(defaultSelection(tied, 0)).toEqual([]);
    expect(defaultSelection(tied, 10)).toEqual(["a", "b"]);
  });
});
