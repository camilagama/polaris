import { describe, expect, it } from "vitest";
import { formatDate } from "./screen-parts";

describe("formatDate", () => {
  it("writes the day as dd/mm/aaaa, never the month spelled out", () => {
    expect(formatDate("2026-10-14T12:00:00")).toBe("14/10/2026");
  });

  it("keeps the year and pads day and month on the first of January", () => {
    expect(formatDate("2026-01-01T12:00:00")).toBe("01/01/2026");
  });
});
