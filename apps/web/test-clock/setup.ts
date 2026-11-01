import { beforeEach, vi } from "vitest";

const raw = process.env.POLARIS_TEST_NOW;

if (raw !== undefined && raw !== "") {
  const instant = new Date(raw);
  if (!/Z$|[+-]\d{2}:\d{2}$/.test(raw) || Number.isNaN(instant.getTime())) {
    throw new Error(
      `POLARIS_TEST_NOW inválido: "${raw}". Use ISO 8601 com fuso, por exemplo 2026-11-01T03:30:00Z.`
    );
  }

  // A test that calls vi.useRealTimers() would leave the rest of its file on the real clock, so the pinned clock is reinstalled before every test.
  const install = () => {
    if (!vi.isFakeTimers()) {
      vi.useFakeTimers({ now: instant, toFake: ["Date"] });
    }
  };
  install();
  beforeEach(install);
}
