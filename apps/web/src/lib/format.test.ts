import { describe, expect, it } from "vitest";
import { formatFileSize } from "./format";

const wholeKilobytes = /^\d+ KB$/;

describe("formatFileSize", () => {
  it("writes sizes in KB under a megabyte and in MB with a comma above", () => {
    expect(formatFileSize(300)).toBe("1 KB");
    expect(formatFileSize(40_000)).toBe("40 KB");
    expect(formatFileSize(400_000)).toBe("400 KB");
    expect(formatFileSize(820_400)).toBe("820 KB");
    expect(formatFileSize(1_200_000)).toBe("1,2 MB");
    expect(formatFileSize(16_777_216)).toBe("16,8 MB");
  });

  it("never writes 0,0 MB", () => {
    for (const bytes of [0, 1, 49_999, 999_999]) {
      expect(formatFileSize(bytes)).toMatch(wholeKilobytes);
    }
  });
});
