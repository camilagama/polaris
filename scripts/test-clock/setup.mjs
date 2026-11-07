import { beforeEach, vi } from "vitest";
import { parseNow } from "./instants.mjs";

// A test that calls vi.useRealTimers() would otherwise leave the rest of its file on the real clock, so this runs before every test.
// The clock is frozen (no shouldAdvanceTime), so durations are measured with performance.now, which stays real.
export function freezeClock(instant) {
  if (!vi.isFakeTimers()) {
    vi.useFakeTimers({ now: instant, toFake: ["Date"] });
  }
}

function resolveZone(timeZone) {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone }).resolvedOptions()
      .timeZone;
  } catch {
    return null;
  }
}

// Intl accepts names the process itself does not honor (lowercase, +03:00): the process then falls back to the machine zone or UTC, so the only reliable check is the zone it actually resolved.
export function assertTimeZone(
  tz,
  effective = Intl.DateTimeFormat().resolvedOptions().timeZone
) {
  const requested =
    typeof tz === "string" && tz !== "" ? resolveZone(tz) : null;
  if (!requested) {
    throw new Error(
      `TZ ausente ou inválido (${JSON.stringify(tz ?? null)}) com POLARIS_TEST_NOW definido: sem o fuso do processo, a data seria lida no fuso da máquina. Use bun run test:datas, que fixa o fuso, ou defina TZ com um fuso IANA, por exemplo TZ=America/Sao_Paulo.`
    );
  }
  if (effective !== requested) {
    throw new Error(
      `TZ=${JSON.stringify(tz)} pede ${requested}, mas o processo usa ${JSON.stringify(effective ?? null)}: o processo não reconheceu o valor (minúsculas e deslocamentos como +03:00 não valem; escreva o nome IANA exato) e a data seria lida em outro fuso. Use bun run test:datas, que fixa o fuso.`
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
