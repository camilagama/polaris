import { describe, expect, it } from "vitest";
import {
  DEFAULT_ACCESS_MINUTES,
  InvalidSupportRequestError,
  isRevealableField,
  MAX_LEGAL_HOLD_REVIEW_DAYS,
  normalizeAccessMinutes,
  normalizeLegalHoldReviewAt,
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

describe("normalizeLegalHoldReviewAt", () => {
  const now = new Date("2026-10-18T12:00:00.000Z");

  it("accepts an instant with an offset, in the future and within the limit, and returns it in UTC", () => {
    expect(normalizeLegalHoldReviewAt("2026-11-18T09:00:00-03:00", now)).toBe(
      "2026-11-18T12:00:00.000Z"
    );
    expect(normalizeLegalHoldReviewAt("2026-10-18T12:00:01Z", now)).toBe(
      "2026-10-18T12:00:01.000Z"
    );
    const limit = new Date(
      now.getTime() + MAX_LEGAL_HOLD_REVIEW_DAYS * 86_400_000
    );
    expect(normalizeLegalHoldReviewAt(limit.toISOString(), now)).toBe(
      limit.toISOString()
    );
  });

  it("refuses what is not an instant with an offset, the past, now and what is past the limit", () => {
    const limit = new Date(
      now.getTime() + MAX_LEGAL_HOLD_REVIEW_DAYS * 86_400_000
    );
    for (const value of [
      undefined,
      null,
      20_261_118,
      "",
      "2026-11-18",
      "2026-11-18T09:00:00",
      "2026-13-40T09:00:00Z",
      "2026-11-31T09:00:00Z",
      "2027-02-30T09:00:00-03:00",
      "2026-11-18T24:00:00Z",
      "em 90 dias",
      "2026-10-18T12:00:00.000Z",
      "2026-10-17T12:00:00.000Z",
      new Date(limit.getTime() + 1).toISOString(),
    ]) {
      expect(() => normalizeLegalHoldReviewAt(value, now)).toThrow(
        InvalidSupportRequestError
      );
    }
  });
});
