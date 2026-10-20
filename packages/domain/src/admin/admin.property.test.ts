import {
  array,
  constant,
  constantFrom,
  double,
  integer,
  oneof,
  property,
  string,
  tuple,
} from "fast-check";
import { describe, expect, it } from "vitest";
import { assertProperty, minimumSeen } from "../testing/property";
import {
  hasPlatformCapability,
  PLATFORM_CAPABILITIES,
  PlatformAuthorizationError,
  type PlatformCapability,
  assertPlatformCapability,
  platformCapabilitiesForRole,
} from "./platform-capabilities";
import {
  DEFAULT_ACCESS_MINUTES,
  InvalidSupportRequestError,
  MAX_ACCESS_MINUTES,
  MAX_CASE_CONTEXT_LENGTH,
  MAX_CASE_REASON_LENGTH,
  MAX_LEGAL_HOLD_REVIEW_DAYS,
  MIN_ACCESS_MINUTES,
  normalizeAccessMinutes,
  normalizeLegalHoldReviewAt,
  normalizeOpenCase,
} from "./support-access";

/*
 * Invariants of the admin area (docs/testing/property-invariants.md, ADM-1 to ADM-6). The oracles are
 * restated rules (integer ranges, calendar tables, code-point counts), not calls to the functions.
 */

const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------------------------
// Platform capabilities
// ---------------------------------------------------------------------------------------------

// Roles a hostile or confused caller could send, including the names every JavaScript object inherits.
const anyRole = oneof(
  string({ maxLength: 24 }),
  constantFrom(
    "platform_owner",
    "Platform_Owner",
    "platform_owner ",
    "owner",
    "admin",
    "__proto__",
    "constructor",
    "toString",
    "hasOwnProperty",
    "prototype",
    ""
  )
);
const anyCapability = oneof(
  constantFrom(...PLATFORM_CAPABILITIES),
  string({ maxLength: 24 }),
  constantFrom(
    "__proto__",
    "constructor",
    "PLATFORM:READ",
    "platform:read ",
    ""
  )
);

describe("platform capabilities (ADM-1 to ADM-2)", () => {
  it("ADM-1: only the one role that exists holds capabilities, and every other string holds none (fail closed)", () => {
    assertProperty(
      property(anyRole, anyCapability, (role, capability) => {
        if (role === "platform_owner") {
          return;
        }
        expect(platformCapabilitiesForRole(role)).toEqual([]);
        expect(hasPlatformCapability(role, capability)).toBe(false);
        expect(() =>
          assertPlatformCapability(role, capability as PlatformCapability)
        ).toThrow(PlatformAuthorizationError);
      })
    );
  });

  it("ADM-2: the owner holds exactly the listed capabilities; anything else, even a near miss, is refused", () => {
    const listed = new Set<string>(PLATFORM_CAPABILITIES);
    assertProperty(
      property(anyCapability, (capability) => {
        const holds = listed.has(capability);
        expect(hasPlatformCapability("platform_owner", capability)).toBe(holds);
        const run = () =>
          assertPlatformCapability(
            "platform_owner",
            capability as PlatformCapability
          );
        if (holds) {
          expect(run).not.toThrow();
        } else {
          expect(run).toThrow(PlatformAuthorizationError);
        }
      })
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Support access
// ---------------------------------------------------------------------------------------------

describe("support access window (ADM-3)", () => {
  it("ADM-3: a duration is accepted exactly when it is a whole number of minutes from 5 to 240, and nothing is the default hour", () => {
    const minutes = oneof(
      constant(undefined),
      integer({ max: MAX_ACCESS_MINUTES + 50, min: -20 }),
      constantFrom(
        MIN_ACCESS_MINUTES - 1,
        MIN_ACCESS_MINUTES,
        MAX_ACCESS_MINUTES,
        MAX_ACCESS_MINUTES + 1,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Number.NEGATIVE_INFINITY
      ),
      double({ max: 300, min: -10, noNaN: true })
    );
    assertProperty(
      property(minutes, (value) => {
        const run = () => normalizeAccessMinutes(value);
        const effective = value ?? DEFAULT_ACCESS_MINUTES;
        const valid =
          Number.isFinite(effective) &&
          effective === Math.trunc(effective) &&
          effective >= 5 &&
          effective <= 240;
        if (valid) {
          expect(run()).toBe(effective);
        } else {
          expect(run).toThrow(InvalidSupportRequestError);
        }
      })
    );
    expect(DEFAULT_ACCESS_MINUTES).toBe(60);
  });
});

/** Text that is mostly clean, with the characters that matter: control characters, line breaks, spaces, astral symbols. */
const awkwardChar = constantFrom(
  "a",
  "ç",
  "😀",
  " ",
  "\n",
  "\t",
  "\r",
  "\u0000",
  "\u001f",
  "\u007f",
  "\u0080"
);
const shortText = array(awkwardChar, { maxLength: 8 }).map((chars) =>
  chars.join("")
);
/** Long text around a limit: `length` code points of one symbol, so a count by UTF-16 units would be off for the emoji. */
const textAround = (limit: number) =>
  tuple(
    integer({ max: limit + 3, min: Math.max(0, limit - 3) }),
    constantFrom("a", "😀"),
    constantFrom("", " ", "  ")
  ).map(([length, symbol, pad]) => `${pad}${symbol.repeat(length)}${pad}`);

function hasControl(text: string, allowLineBreaks: boolean): boolean {
  return [...text].some((char) => {
    const code = char.codePointAt(0) as number;
    const allowed =
      allowLineBreaks && (code === 9 || code === 10 || code === 13);
    return (code < 32 || code === 127) && !allowed;
  });
}

describe("support case text (ADM-4)", () => {
  it("ADM-4: a case opens exactly when the kind is known and the trimmed reason and context respect the length and the control-character rules", () => {
    const input = tuple(
      constantFrom("support", "privacy", "other", "", "Support"),
      oneof(shortText, textAround(MAX_CASE_REASON_LENGTH)),
      oneof(
        constant(null),
        constant(undefined),
        shortText,
        textAround(MAX_CASE_CONTEXT_LENGTH)
      )
    );
    let opened = 0;
    assertProperty(
      property(input, ([kind, reason, context]) => {
        const trimmedReason = reason.trim();
        const trimmedContext = (context ?? "").trim();
        const valid =
          (kind === "support" || kind === "privacy") &&
          trimmedReason !== "" &&
          [...trimmedReason].length <= 500 &&
          !hasControl(trimmedReason, false) &&
          [...trimmedContext].length <= 2000 &&
          !hasControl(trimmedContext, true);
        const run = () =>
          normalizeOpenCase(
            context === undefined ? { kind, reason } : { context, kind, reason }
          );
        if (valid) {
          opened += 1;
          expect(run()).toEqual({
            context: trimmedContext === "" ? null : trimmedContext,
            kind,
            reason: trimmedReason,
          });
        } else {
          expect(run).toThrow(InvalidSupportRequestError);
        }
      })
    );
    expect(opened).toBeGreaterThanOrEqual(minimumSeen());
  });
});

// ---------------------------------------------------------------------------------------------
// Legal hold review date: calendar tables and offset arithmetic as the oracle
// ---------------------------------------------------------------------------------------------

const NOW = new Date("2026-10-20T12:00:00.000Z");

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

const two = (value: number) => String(value).padStart(2, "0");

describe("legal hold review date (ADM-5 to ADM-6)", () => {
  it("ADM-5: an instant in any offset is accepted exactly when it is after now and at most 366 days away, and comes back in UTC", () => {
    const delta = oneof(
      integer({ max: 400 * DAY_MS, min: -3 * DAY_MS }),
      constantFrom(
        0,
        1,
        -1,
        MAX_LEGAL_HOLD_REVIEW_DAYS * DAY_MS,
        MAX_LEGAL_HOLD_REVIEW_DAYS * DAY_MS + 1,
        MAX_LEGAL_HOLD_REVIEW_DAYS * DAY_MS - 1
      )
    );
    const offsetMinutes = integer({ max: 14 * 60, min: -12 * 60 });
    assertProperty(
      property(
        delta,
        offsetMinutes,
        constantFrom(true, false),
        (ms, offset, utcLetter) => {
          const at = NOW.getTime() + ms;
          // the wall clock of that instant in the offset, written by hand
          const wall = new Date(at + (utcLetter ? 0 : offset) * 60_000)
            .toISOString()
            .slice(0, 23);
          const sign = offset < 0 ? "-" : "+";
          const suffix = utcLetter
            ? "Z"
            : `${sign}${two(Math.floor(Math.abs(offset) / 60))}:${two(Math.abs(offset) % 60)}`;
          const run = () => normalizeLegalHoldReviewAt(`${wall}${suffix}`, NOW);
          if (ms > 0 && ms <= 366 * DAY_MS) {
            expect(run()).toBe(new Date(at).toISOString());
          } else {
            expect(run).toThrow(InvalidSupportRequestError);
          }
        }
      )
    );
  });

  it("ADM-6: a date that does not exist (30 February, hour 24, minute 60, month 13) is refused, never rolled over to a real one", () => {
    const parts = tuple(
      integer({ max: 2027, min: 2026 }),
      integer({ max: 13, min: 0 }),
      integer({ max: 32, min: 0 }),
      integer({ max: 25, min: 0 }),
      integer({ max: 61, min: 0 }),
      integer({ max: 61, min: 0 })
    );
    let real = 0;
    assertProperty(
      property(parts, ([year, month, day, hour, minute, second]) => {
        const text = `${year}-${two(month)}-${two(day)}T${two(hour)}:${two(minute)}:${two(second)}Z`;
        const exists =
          month >= 1 &&
          month <= 12 &&
          day >= 1 &&
          day <= daysInMonth(year, month) &&
          hour <= 23 &&
          minute <= 59 &&
          second <= 59;
        const at = exists
          ? Date.UTC(year, month - 1, day, hour, minute, second)
          : Number.NaN;
        const inRange =
          at > NOW.getTime() && at <= NOW.getTime() + 366 * DAY_MS;
        const run = () => normalizeLegalHoldReviewAt(text, NOW);
        if (exists && inRange) {
          real += 1;
          expect(run()).toBe(new Date(at).toISOString());
        } else {
          expect(run).toThrow(InvalidSupportRequestError);
        }
      })
    );
    expect(real).toBeGreaterThanOrEqual(Math.min(1, minimumSeen()));
  });
});
