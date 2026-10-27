import { describe, expect, it, vi } from "vitest";
import {
  ACTIVATION_FUNNEL_STATEMENT_TIMEOUT_MS,
  readActivationFunnel,
} from "./admin-diagnostics-repository";
import type { AdminQueryable } from "./platform-principal-repository";

const STABLE_OR_TABLE = /admin_activation_funnel\(|\bFROM\b/;
const PRINCIPAL = "0199a0a0-0000-7000-8000-000000000001";
const WRAPPER =
  /^SELECT public\.admin_read_activation_funnel\(\$1, \$2\) AS result/;

function client(
  answer: (text: string) => Promise<{ rows: Record<string, unknown>[] }>
) {
  const query = vi.fn((text: string, _values: unknown[]) => answer(text));
  return { client: { query } as unknown as AdminQueryable, query };
}

describe("readActivationFunnel", () => {
  it("reads only through the audited wrapper, in one transaction with its own statement timeout", async () => {
    const { client: database, query } = client((text) =>
      Promise.resolve({
        rows: WRAPPER.test(text) ? [{ at: "now", result: { weeks: 4 } }] : [],
      })
    );

    expect(await readActivationFunnel(database, PRINCIPAL, 4)).toEqual({
      weeks: 4,
    });
    expect(query.mock.calls.map(([text]) => text)).toEqual([
      "BEGIN",
      `SET LOCAL statement_timeout = ${ACTIVATION_FUNNEL_STATEMENT_TIMEOUT_MS}`,
      expect.stringMatching(WRAPPER),
      "COMMIT",
    ]);
    expect(query.mock.calls[2]?.[1]).toEqual([PRINCIPAL, 4]);
    // never the STABLE function itself, never a table
    for (const [text] of query.mock.calls) {
      expect(text).not.toMatch(STABLE_OR_TABLE);
    }
  });

  it("rolls back and says it timed out when the database cancels the read", async () => {
    const { client: database, query } = client((text) =>
      WRAPPER.test(text)
        ? Promise.reject(
            Object.assign(
              new Error("canceling statement due to statement timeout"),
              { code: "57014" }
            )
          )
        : Promise.resolve({ rows: [] })
    );

    await expect(readActivationFunnel(database, PRINCIPAL, 4)).rejects.toThrow(
      "activation_funnel_timeout"
    );
    expect(query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
  });

  it("rolls back and passes any other failure on as it is", async () => {
    const failure = Object.assign(new Error("not an active principal"), {
      code: "42501",
    });
    const { client: database, query } = client((text) =>
      WRAPPER.test(text)
        ? Promise.reject(failure)
        : Promise.resolve({ rows: [] })
    );

    await expect(readActivationFunnel(database, PRINCIPAL, 4)).rejects.toBe(
      failure
    );
    expect(query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
  });

  it.each([0, 27, 1.5, Number.NaN])(
    "refuses %s weeks before the database",
    async (weeks) => {
      const { client: database, query } = client(() =>
        Promise.resolve({ rows: [] })
      );
      await expect(
        readActivationFunnel(database, PRINCIPAL, weeks)
      ).rejects.toThrow("invalid_weeks");
      expect(query).not.toHaveBeenCalled();
    }
  );
});
