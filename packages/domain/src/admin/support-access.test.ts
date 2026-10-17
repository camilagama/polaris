import { describe, expect, it } from "vitest";
import {
  DEFAULT_ACCESS_MINUTES,
  InvalidSupportRequestError,
  isRevealableField,
  normalizeAccessMinutes,
  normalizeOpenCase,
  normalizeResolution,
  supportRefusalFromMessage,
} from "./support-access";

const refusal = (run: () => unknown) => {
  try {
    run();
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(InvalidSupportRequestError);
    return (error as InvalidSupportRequestError).code;
  }
  throw new Error("expected a refusal");
};

describe("opening a case", () => {
  it("keeps a trimmed reason and a context that may be absent", () => {
    expect(
      normalizeOpenCase({
        context: "  ",
        kind: "support",
        reason: "  Cliente sem acesso  ",
      })
    ).toEqual({ context: null, kind: "support", reason: "Cliente sem acesso" });
    expect(
      normalizeOpenCase({
        context: " ticket 42 ",
        kind: "privacy",
        reason: "Pedido do titular",
      })
    ).toMatchObject({ context: "ticket 42", kind: "privacy" });
  });

  it("refuses an unknown kind, an empty or long reason and a long context", () => {
    expect(
      refusal(() => normalizeOpenCase({ kind: "audit", reason: "x" }))
    ).toBe("invalid_case_kind");
    expect(
      refusal(() => normalizeOpenCase({ kind: "support", reason: "   " }))
    ).toBe("invalid_case_reason");
    expect(
      refusal(() =>
        normalizeOpenCase({ kind: "support", reason: "x".repeat(501) })
      )
    ).toBe("invalid_case_reason");
    expect(
      refusal(() =>
        normalizeOpenCase({
          context: "x".repeat(2001),
          kind: "support",
          reason: "x",
        })
      )
    ).toBe("invalid_case_context");
  });
});

describe("what an operator types", () => {
  it("refuses control characters (a line break is fine in a context)", () => {
    expect(
      refusal(() => normalizeOpenCase({ kind: "support", reason: "a\u0000b" }))
    ).toBe("invalid_case_reason");
    expect(
      refusal(() =>
        normalizeOpenCase({ kind: "support", reason: "a\u001b[31mb" })
      )
    ).toBe("invalid_case_reason");
    expect(
      refusal(() =>
        normalizeOpenCase({ context: "a\u0000", kind: "support", reason: "x" })
      )
    ).toBe("invalid_case_context");
    expect(
      normalizeOpenCase({
        context: "linha 1\nlinha 2",
        kind: "support",
        reason: "x",
      }).context
    ).toBe("linha 1\nlinha 2");
    expect(refusal(() => normalizeResolution("a\u0000"))).toBe(
      "invalid_case_resolution"
    );
    expect(refusal(() => normalizeResolution("x".repeat(501)))).toBe(
      "invalid_case_resolution"
    );
    expect(normalizeResolution("  ok  ")).toBe("ok");
    expect(normalizeResolution("   ")).toBeNull();
    expect(normalizeResolution(null)).toBeNull();
  });
});

describe("access duration", () => {
  it("defaults to an hour and stays between five minutes and four hours", () => {
    expect(normalizeAccessMinutes(undefined)).toBe(DEFAULT_ACCESS_MINUTES);
    expect(normalizeAccessMinutes(5)).toBe(5);
    expect(normalizeAccessMinutes(240)).toBe(240);
    for (const bad of [0, 4, 241, 60.5, Number.NaN, -1]) {
      expect(refusal(() => normalizeAccessMinutes(bad))).toBe(
        "invalid_duration"
      );
    }
  });
});

describe("the rest", () => {
  it("reveals only the four customer fields", () => {
    for (const field of ["name", "email", "phone", "notes"]) {
      expect(isRevealableField(field)).toBe(true);
    }
    for (const field of ["password", "token", "id", ""]) {
      expect(isRevealableField(field)).toBe(false);
    }
  });

  it("names a database refusal, and anything unknown is a generic invalid request", () => {
    expect(supportRefusalFromMessage("case_not_open")).toBe("case_not_open");
    expect(supportRefusalFromMessage("invalid page size")).toBe(
      "invalid_request"
    );
    expect(supportRefusalFromMessage("")).toBe("invalid_request");
  });
});
