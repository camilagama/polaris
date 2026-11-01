import { beforeEach, vi } from "vitest";
import { parseNow } from "./instants.mjs";

// A test that calls vi.useRealTimers() would otherwise leave the rest of its file on the real clock, so this runs before every test.
// The clock is frozen (no shouldAdvanceTime), so durations are measured with performance.now, which stays real.
export function freezeClock(instant) {
  if (!vi.isFakeTimers()) {
    vi.useFakeTimers({ now: instant, toFake: ["Date"] });
  }
}

export function assertTimeZone(tz) {
  let valid = typeof tz === "string" && tz !== "";
  if (valid) {
    try {
      valid = Boolean(
        new Intl.DateTimeFormat("en-US", { timeZone: tz }).resolvedOptions()
          .timeZone
      );
    } catch {
      valid = false;
    }
  }
  if (!valid) {
    throw new Error(
      `TZ ausente ou inválido (${JSON.stringify(tz ?? null)}) com POLARIS_TEST_NOW definido: sem o fuso do processo, a data seria lida no fuso da máquina. Use bun run test:datas, que fixa o fuso, ou defina TZ com um fuso IANA, por exemplo TZ=America/Sao_Paulo.`
    );
  }
}

const raw = process.env.POLARIS_TEST_NOW;

if (raw !== undefined && raw !== "") {
  const instant = parseNow(raw);
  assertTimeZone(process.env.TZ);
  freezeClock(instant);
  beforeEach(() => {
    freezeClock(instant);
  });
}
