import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("./grace-notice.tsx", import.meta.url),
  "utf8"
);

const READING_WRITE = /reading\.current\s*(?:\|\||&&|\?\?)?=[^;]+;/gs;
const SKIP_BLOCK = /if \(([^{]*?)\) \{\s*return;/s;
const IN_FLIGHT_CHECK =
  /(?:^|\|\|\s*)planReadInFlight\(reading\.current, organizationId\)\s*\|\|/;

function readingWrites(code: string): string[] {
  const writes = code.match(READING_WRITE) ?? [];
  return writes.map((write) => write.replace(/\s+/g, " "));
}

function skipsWhenReading(code: string): boolean {
  const condition = code.match(SKIP_BLOCK)?.[1] ?? "";
  return IN_FLIGHT_CHECK.test(condition.replace(/\s+/g, " "));
}

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

  it("tracks the read in flight by store: written only through the per-store functions", () => {
    expect(readingWrites(source)).toEqual([
      "reading.current = planReadStarted(reading.current, organizationId);",
      "reading.current = planReadEnded(reading.current, organizationId);",
    ]);
    expect(skipsWhenReading(source)).toBe(true);
  });

  it("rejects a write that forgets the store, a negated check and a check outside the skip", () => {
    const literal = source.replace(
      "reading.current = planReadStarted(reading.current, organizationId);",
      "reading.current = new Set();"
    );
    expect(readingWrites(literal)).not.toEqual(readingWrites(source));
    const compound = source.replace(
      "reading.current = planReadEnded(reading.current, organizationId);",
      "reading.current ||= planReadEnded(reading.current, organizationId);"
    );
    expect(readingWrites(compound)).not.toEqual(readingWrites(source));
    const negated = source.replace(
      "planReadInFlight(reading.current, organizationId) ||",
      "!planReadInFlight(reading.current, organizationId) ||"
    );
    expect(skipsWhenReading(negated)).toBe(false);
    const outside = source.replace(
      "planReadInFlight(reading.current, organizationId) ||",
      "false ||"
    );
    expect(skipsWhenReading(outside)).toBe(false);
  });
});
