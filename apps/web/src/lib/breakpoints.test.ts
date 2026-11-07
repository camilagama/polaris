import { describe, expect, it } from "vitest";
import {
  COLLAPSIBLE_QUERY,
  PHONE_QUERY,
  TWO_MONTHS_QUERY,
} from "@/lib/breakpoints";

const REM_IN_PX = 16;
const WIDTH_IN_REM = /\((?:min|max)-width: ([\d.]+)rem\)/;
const PIXELS = /px/;

function remOf(query: string) {
  const match = WIDTH_IN_REM.exec(query);
  return Number(match?.[1]);
}

describe("breakpoints in rem", () => {
  it("are the same lines as before with the default 16 px font", () => {
    expect(remOf(PHONE_QUERY) * REM_IN_PX).toBe(760);
    expect(remOf(COLLAPSIBLE_QUERY) * REM_IN_PX).toBe(1024);
    expect(remOf(TWO_MONTHS_QUERY) * REM_IN_PX).toBe(1280);
  });

  it("use no px, so a larger system font moves them as it moves the CSS", () => {
    for (const query of [PHONE_QUERY, COLLAPSIBLE_QUERY, TWO_MONTHS_QUERY]) {
      expect(query).not.toMatch(PIXELS);
    }
  });

  it("the phone is the exact complement of `md:`, the same line as the CSS", () => {
    expect(PHONE_QUERY).toBe("not all and (min-width: 47.5rem)");
  });
});
