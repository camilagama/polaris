import { afterEach, describe, expect, it } from "vitest";
import { commandSeed, nextCommandId, startCommandIds } from "./seed";

const UUID_V5 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SEED_PATTERN = /^[a-f0-9]{16}$/;
const original = process.env.E2E_SEED;

function idsOf(scope: string, count: number): string[] {
  startCommandIds(scope);
  return Array.from({ length: count }, () => nextCommandId());
}

afterEach(() => {
  if (original === undefined) {
    delete process.env.E2E_SEED;
  } else {
    process.env.E2E_SEED = original;
  }
});

describe("command ids of the seeds", () => {
  it("repeats the same ids for the same seed and scope", () => {
    process.env.E2E_SEED = "0123456789abcdef";
    const first = idsOf("online/venda/t0", 3);
    expect(idsOf("online/venda/t0", 3)).toEqual(first);
    expect(new Set(first).size).toBe(3);
    for (const id of first) {
      expect(id).toMatch(UUID_V5);
    }
  });

  it("changes with the scope and with the seed", () => {
    process.env.E2E_SEED = "0123456789abcdef";
    const [venda] = idsOf("online/venda/t0", 1);
    const [retry] = idsOf("online/venda/t1", 1);
    process.env.E2E_SEED = "fedcba9876543210";
    const [otherSeed] = idsOf("online/venda/t0", 1);
    expect(new Set([venda, retry, otherSeed]).size).toBe(3);
  });

  it("draws a seed once when none is given, and keeps it", () => {
    delete process.env.E2E_SEED;
    const drawn = commandSeed();
    expect(drawn).toMatch(SEED_PATTERN);
    expect(commandSeed()).toBe(drawn);
    expect(process.env.E2E_SEED).toBe(drawn);
  });

  it("refuses a seed that is not 16 lowercase hex digits", () => {
    for (const bad of ["ABCDEF0123456789", "123", "0123456789abcdeg"]) {
      process.env.E2E_SEED = bad;
      expect(() => commandSeed()).toThrow("E2E_SEED");
    }
  });
});
