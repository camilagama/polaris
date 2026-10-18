import { describe, expect, it } from "vitest";
import {
  ACCESS_LOG_MAX_WINDOW_MS,
  InvalidAccessLogRequestError,
  isLegalReference,
  normalizeAccessLogRequest,
} from "./access-log";

const valid = {
  from: "2026-10-01T00:00:00.000Z",
  legalReference: "1234567-42.2026.8.26.0100",
  to: "2026-10-08T00:00:00.000Z",
  user: "user-1",
};

function refusal(input: Parameters<typeof normalizeAccessLogRequest>[0]) {
  try {
    normalizeAccessLogRequest(input);
  } catch (error) {
    expect(error).toBeInstanceOf(InvalidAccessLogRequestError);
    return (error as InvalidAccessLogRequestError).code;
  }
  return null;
}

describe("the case reference", () => {
  it("is the CNJ number and nothing else", () => {
    expect(isLegalReference("0001234-09.2026.8.26.0001")).toBe(true);
    for (const text of [
      "",
      " 0001234-09.2026.8.26.0001",
      "0001234-09.2026.8.26.0001\n",
      "000123-56.2026.8.26.0001",
      "0001234-5.2026.8.26.0001",
      "0001234-09.2026.8.26.001",
      "processo 0001234-09.2026.8.26.0001",
      "٠٠٠١٢٣٤-٥٦.٢٠٢٦.٨.٢٦.٠٠٠١",
    ]) {
      expect(isLegalReference(text), text).toBe(false);
    }
    // right shape, wrong check digits: an invented or mistyped number
    expect(isLegalReference("0001234-56.2026.8.26.0001")).toBe(false);
    expect(isLegalReference("0001234-10.2026.8.26.0001")).toBe(false);
    expect(isLegalReference("1234567-89.2026.8.26.0100")).toBe(false);
    expect(isLegalReference("1234567-42.2026.8.26.0100")).toBe(true);
    expect(isLegalReference(1_234_567)).toBe(false);
    expect(isLegalReference(null)).toBe(false);
  });
});

describe("a read of the access log", () => {
  it("normalizes a request by user, with the default page and no cursor", () => {
    expect(normalizeAccessLogRequest(valid)).toEqual({
      after: null,
      filter: { kind: "user", userId: "user-1" },
      from: new Date(valid.from),
      legalReference: valid.legalReference,
      limit: 25,
      to: new Date(valid.to),
    });
  });

  it("accepts one IP, v4 or v6, and trims it", () => {
    const { user: _user, ...rest } = valid;
    expect(
      normalizeAccessLogRequest({ ...rest, ip: " 203.0.113.5 " }).filter
    ).toEqual({ ip: "203.0.113.5", kind: "ip" });
    expect(
      normalizeAccessLogRequest({ ...rest, ip: "2001:db8::1" }).filter
    ).toEqual({ ip: "2001:db8::1", kind: "ip" });
  });

  it("asks for an IPv4 address in the form that is stored, not its IPv6 mapping", () => {
    const { user: _user, ...rest } = valid;
    expect(
      normalizeAccessLogRequest({ ...rest, ip: "::ffff:203.0.113.5" }).filter
    ).toEqual({ ip: "203.0.113.5", kind: "ip" });
  });

  it("refuses zero or two filters, a network and a user with control characters", () => {
    const { user: _user, ...rest } = valid;
    expect(refusal(rest)).toBe("invalid_filter");
    expect(refusal({ ...valid, ip: "203.0.113.5" })).toBe("invalid_filter");
    expect(refusal({ ...rest, ip: "203.0.113.0/24" })).toBe("invalid_filter");
    expect(refusal({ ...rest, ip: "300.1.1.1" })).toBe("invalid_filter");
    expect(refusal({ ...valid, user: "a\nb" })).toBe("invalid_filter");
    expect(refusal({ ...valid, user: "x".repeat(65) })).toBe("invalid_filter");
    // an identifier of the Better Auth shape only: nothing that is an IP, an e-mail or a document ends in the audit
    for (const user of [
      "203.0.113.5",
      "ana@example.invalid",
      "123.456.789-09",
      "a b",
      "a:b",
    ]) {
      expect(refusal({ ...valid, user }), user).toBe("invalid_filter");
    }
    expect(refusal({ ...valid, user: 5 })).toBe("invalid_filter");
  });

  it("holds the window to 31 days, forward in time", () => {
    const from = new Date(valid.from);
    const edge = new Date(from.getTime() + ACCESS_LOG_MAX_WINDOW_MS);
    expect(refusal({ ...valid, to: edge.toISOString() })).toBeNull();
    expect(
      refusal({ ...valid, to: new Date(edge.getTime() + 1).toISOString() })
    ).toBe("invalid_window");
    expect(refusal({ ...valid, to: valid.from })).toBe("invalid_window");
    expect(refusal({ ...valid, from: undefined })).toBe("invalid_window");
    expect(refusal({ ...valid, to: "not a date" })).toBe("invalid_window");
    // a year the database would refuse is a refusal here, not an error there
    expect(
      refusal({
        ...valid,
        from: "0001-01-01T00:00:00.000Z",
        to: "0001-01-10T00:00:00.000Z",
      })
    ).toBe("invalid_window");
    expect(
      refusal({
        ...valid,
        from: "9999-01-01T00:00:00.000Z",
        to: "9999-01-10T00:00:00.000Z",
      })
    ).toBe("invalid_window");
  });

  it("holds the page to 1 to 50 whole numbers and the cursor to a UUID", () => {
    expect(refusal({ ...valid, limit: 1 })).toBeNull();
    expect(refusal({ ...valid, limit: 50 })).toBeNull();
    for (const limit of [0, 51, 1.5, "10", -1]) {
      expect(refusal({ ...valid, limit }), String(limit)).toBe("invalid_page");
    }
    expect(refusal({ ...valid, after: "nope" })).toBe("invalid_cursor");
    expect(
      normalizeAccessLogRequest({
        ...valid,
        after: "0199A0A0-0000-7000-8000-0000000000C1",
      }).after
    ).toBe("0199a0a0-0000-7000-8000-0000000000c1");
  });

  it("checks the case number first", () => {
    expect(
      refusal({ ...valid, legalReference: "texto", user: undefined })
    ).toBe("invalid_reference");
  });
});
