import { describe, expect, it } from "vitest";
import {
  redactConnectionStrings,
  sqlConstraint,
  sqlState,
} from "./gate-errors";

const FAKE_SECRET = "senha-de-mentira";
const URL_WITH_SECRET = `postgres://usuario:${FAKE_SECRET}@host.exemplo:5432/banco?sslmode=verify-full`;
const REDACTED = "[redacted]";
const MAX_CAUSE_READS = 20;

function withCause(
  fields: Record<string, unknown>,
  cause?: unknown
): Record<string, unknown> {
  return cause === undefined ? fields : { ...fields, cause };
}

describe("redactConnectionStrings", () => {
  it("replaces a postgres:// URL with [redacted] and leaves no password behind", () => {
    const output = redactConnectionStrings(URL_WITH_SECRET);

    expect(output).toBe(REDACTED);
    expect(output).not.toContain(FAKE_SECRET);
  });

  it("covers postgresql:// and the scheme in upper case", () => {
    expect(redactConnectionStrings(`postgresql://u:${FAKE_SECRET}@h/db`)).toBe(
      REDACTED
    );
    expect(redactConnectionStrings(`POSTGRES://u:${FAKE_SECRET}@h/db`)).toBe(
      REDACTED
    );
    expect(redactConnectionStrings(`PostgreSQL://u:${FAKE_SECRET}@h/db`)).toBe(
      REDACTED
    );
  });

  it("redacts every connection string in the same text and keeps the words around them", () => {
    const output = redactConnectionStrings(
      `from ${URL_WITH_SECRET} to postgresql://outro:${FAKE_SECRET}@h2/db2 failed`
    );

    expect(output).toBe(`from ${REDACTED} to ${REDACTED} failed`);
    expect(output).not.toContain(FAKE_SECRET);
  });

  it("stops at a double quote and keeps the text around it", () => {
    const output = redactConnectionStrings(
      `connect("postgres://u:${FAKE_SECRET}@h/db") failed`
    );

    expect(output).toBe(`connect("${REDACTED}") failed`);
    expect(output).not.toContain(FAKE_SECRET);
  });

  it("stops at an apostrophe and keeps the text around it", () => {
    const output = redactConnectionStrings(
      `connect('postgres://u:${FAKE_SECRET}@h/db') failed`
    );

    expect(output).toBe(`connect('${REDACTED}') failed`);
    expect(output).not.toContain(FAKE_SECRET);
  });

  it("stops at whitespace", () => {
    expect(
      redactConnectionStrings(`postgres://u:${FAKE_SECRET}@h/db\nnext line`)
    ).toBe(`${REDACTED}\nnext line`);
  });

  it("leaves a text without a connection string unchanged", () => {
    const text = "connection terminated unexpectedly (57P01)\n  at gate.ts:10";

    expect(redactConnectionStrings(text)).toBe(text);
    expect(redactConnectionStrings("")).toBe("");
  });

  it("leaves a URL that is not a Postgres one", () => {
    const text = "see https://exemplo.com/a?b=c for details";

    expect(redactConnectionStrings(text)).toBe(text);
  });
});

describe("sqlConstraint", () => {
  it("reads the constraint of the error itself", () => {
    expect(sqlConstraint({ constraint: "sales_pkey" })).toBe("sales_pkey");
  });

  it("reads the constraint from a cause three levels down", () => {
    const error = withCause(
      { message: "outer" },
      withCause({ message: "middle" }, { constraint: "sales_pkey" })
    );

    expect(sqlConstraint(error)).toBe("sales_pkey");
  });

  it("returns the nearest constraint when two levels have one", () => {
    expect(
      sqlConstraint(
        withCause({ constraint: "outer_key" }, { constraint: "inner_key" })
      )
    ).toBe("outer_key");
  });

  it("returns undefined for a cycle of causes without looping", () => {
    let reads = 0;
    const first: { cause?: unknown } = {};
    const second: { cause?: unknown } = {};
    const cycleLink = (target: object) => () => {
      reads += 1;
      if (reads > MAX_CAUSE_READS) {
        throw new Error("the walk did not stop at the cycle");
      }
      return target;
    };
    Object.defineProperty(first, "cause", { get: cycleLink(second) });
    Object.defineProperty(second, "cause", { get: cycleLink(first) });

    expect(sqlConstraint(first)).toBeUndefined();
    expect(reads).toBe(2);
  });

  it("returns undefined when no level has a constraint", () => {
    expect(
      sqlConstraint(withCause({ message: "a" }, { code: "23505" }))
    ).toBeUndefined();
  });

  it("ignores a constraint that is not a string", () => {
    expect(sqlConstraint({ constraint: 42 })).toBeUndefined();
  });

  it("returns undefined for a value that is not an object", () => {
    expect(sqlConstraint(null)).toBeUndefined();
    expect(sqlConstraint("texto")).toBeUndefined();
    expect(sqlConstraint(42)).toBeUndefined();
    expect(sqlConstraint(undefined)).toBeUndefined();
  });
});

describe("sqlState against sqlConstraint", () => {
  it("does not take a code that is not five characters of [0-9A-Z]", () => {
    const error = { code: "ECONNREFUSED" };

    expect(sqlState(error)).toBeUndefined();
    expect(sqlState({ code: "2305" })).toBeUndefined();
    expect(sqlState({ code: "23505x" })).toBeUndefined();
    expect(sqlState({ code: "23a05" })).toBeUndefined();
  });

  it("takes a constraint of any text, where a code must look like a state", () => {
    expect(sqlConstraint({ constraint: "not a SQLSTATE at all" })).toBe(
      "not a SQLSTATE at all"
    );
    expect(sqlConstraint({ constraint: "ECONNREFUSED" })).toBe("ECONNREFUSED");
    expect(sqlState({ code: "23505" })).toBe("23505");
  });

  it("skips a cause with a malformed code and finds the state below it", () => {
    expect(
      sqlState(withCause({ code: "ECONNREFUSED" }, { code: "57P01" }))
    ).toBe("57P01");
  });
});
