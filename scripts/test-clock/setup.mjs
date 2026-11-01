import { beforeEach, vi } from "vitest";
import { parseNow } from "./instants.mjs";

const raw = process.env.POLARIS_TEST_NOW;

if (raw !== undefined && raw !== "") {
  const instant = parseNow(raw);

  // Reinstalled before every test: one that calls vi.useRealTimers() would otherwise leave the rest of its file on the real clock.
  // The clock is frozen (no shouldAdvanceTime), so durations are measured with performance.now, which stays real.
  const install = () => {
    if (!vi.isFakeTimers()) {
      vi.useFakeTimers({ now: instant, toFake: ["Date"] });
    }
  };
  install();
  beforeEach(install);
}
