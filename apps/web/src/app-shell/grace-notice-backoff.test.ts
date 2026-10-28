import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("./grace-notice.tsx", import.meta.url),
  "utf8"
);

describe("the wait after failed reads in the grace notice", () => {
  it("is only written through the per-store functions, never with a literal that forgets the store", () => {
    // the writes of the ref: the effect drops another store's wait, the answers go through the guards
    const writes = source.match(/failed\.current = [^;]+;/gs) ?? [];
    expect(writes.map((write) => write.replace(/\s+/g, " "))).toEqual([
      "failed.current = planReadBackoffFor(failed.current, organizationId);",
      "failed.current = planReadSucceeded(failed.current, organizationId);",
      "failed.current = planReadFailed( failed.current, organizationId, now.getTime() );",
    ]);
  });
});
