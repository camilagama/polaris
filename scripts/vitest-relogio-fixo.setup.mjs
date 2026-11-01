import { beforeEach, vi } from "vitest";

const raw = process.env.POLARIS_TEST_NOW;

/**
 * Pins `Date` to the instant in POLARIS_TEST_NOW (an ISO string; give the offset, e.g. `2026-11-01T03:30:00Z`, because without one the date is read in the process time zone) so a suite
 * can be run as if it started at a critical moment (first minute of a month, year turn, leap day).
 * Without the variable this file does nothing.
 *
 * Only `Date` is faked: timers, `performance.now` and `process.hrtime` stay real, and `shouldAdvanceTime` lets the
 * pinned clock move with real time so elapsed-time measurements and polling loops behave. The clock is installed when
 * the file loads (module-level `new Date()` in a test file sees it) and again before each test, because a test that
 * calls `vi.useRealTimers()` would otherwise leave the rest of its file on the real clock. A test that already fakes
 * its own clock keeps it: `isFakeTimers()` is true by then and the hook leaves it alone.
 */
function pin(at) {
  if (!vi.isFakeTimers()) {
    vi.useFakeTimers({ now: at, shouldAdvanceTime: true, toFake: ["Date"] });
  }
}

if (raw !== undefined && raw !== "") {
  const at = new Date(raw);
  if (Number.isNaN(at.getTime())) {
    throw new Error(`POLARIS_TEST_NOW is not a valid date: ${raw}`);
  }
  pin(at);
  beforeEach(() => {
    pin(at);
  });
}
