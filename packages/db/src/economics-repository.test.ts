import { describe, expect, it } from "vitest";
import { inBlocks } from "./economics-repository";

describe("inBlocks", () => {
  it("splits a list into consecutive blocks that keep every value once and in order", () => {
    expect(inBlocks([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(inBlocks([], 3)).toEqual([]);
    expect(inBlocks([1, 2, 3], 3)).toEqual([[1, 2, 3]]);
  });

  it("keeps a very long list under the block size", () => {
    const ids = Array.from({ length: 70_000 }, (_, index) => index);
    const blocks = inBlocks(ids, 5000);
    expect(blocks).toHaveLength(14);
    expect(
      Math.max(...blocks.map((block) => block.length))
    ).toBeLessThanOrEqual(5000);
    expect(blocks.flat()).toEqual(ids);
  });
});
