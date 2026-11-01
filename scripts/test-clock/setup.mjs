import { beforeEach, vi } from "vitest";
import { parseNow } from "./instants.mjs";

// A test that calls vi.useRealTimers() would otherwise leave the rest of its file on the real clock, so this runs before every test.
// The clock is frozen (no shouldAdvanceTime), so durations are measured with performance.now, which stays real.
export function freezeClock(instant) {
  if (!vi.isFakeTimers()) {
    vi.useFakeTimers({ now: instant, toFake: ["Date"] });
  }
}

const raw = process.env.POLARIS_TEST_NOW;

if (raw !== undefined && raw !== "") {
  const instant = parseNow(raw);
  freezeClock(instant);
  beforeEach(() => {
    freezeClock(instant);
  });
}
