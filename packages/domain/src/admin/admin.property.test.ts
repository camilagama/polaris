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
    // The edges are written as literals of the rule (5 and 240), not as the constants of the code, so
    // moving a constant without moving the rule fails here; they carry most of the weight, since a
    // wide integer range almost never lands on them.
    const minutes = oneof(
      { arbitrary: constant(undefined), weight: 1 },
      { arbitrary: integer({ max: 290, min: -20 }), weight: 1 },
      {
        arbitrary: constantFrom(
          4,
          5,
          6,
          239,
          240,
          241,
          0,
          -1,
          60,
          4.5,
          4.999,
          5.5,
          239.5,
          240.001,
          Number.NaN,
          Number.POSITIVE_INFINITY,
          Number.NEGATIVE_INFINITY
        ),
        weight: 4,
      },
      { arbitrary: double({ max: 300, min: -10, noNaN: true }), weight: 1 }
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
// Clean text, and prose with line breaks and tabs inside (clean for a context, a control for a reason): the
// two that a random mix of characters almost never produces, since one control character spoils it.
const cleanShort = array(constantFrom("a", "ç", "😀", " "), {
  maxLength: 8,
}).map((chars) => chars.join(""));
const prose = array(constantFrom("a", "ç", "😀", " ", "\n", "\r", "\t"), {
  maxLength: 12,
}).map((chars) => chars.join(""));
const SYMBOLS = ["a", "ç", "😀"] as const;
/**
 * Long text around a limit, written with the literal of the rule: exactly limit - 1, limit and limit + 1
 * code points most of the time (a count by UTF-16 units would be off for the emoji), made of two symbols,
 * with blank padding that `trim` must remove before the count, and now and then one control character
 * in the middle (a line break and a tab are allowed in the context only).
 */
const textAround = (limit: number, withControl = true) =>
  tuple(
    oneof(
      { arbitrary: constantFrom(limit - 1, limit, limit + 1), weight: 4 },
      {
        arbitrary: integer({ max: limit + 3, min: Math.max(0, limit - 3) }),
        weight: 1,
      }
    ),
    constantFrom(...SYMBOLS),
    constantFrom(...SYMBOLS),
    constantFrom("", " ", "  ", "\n", "\t \r\n"),
    constantFrom(
      ...(withControl
        ? ["", "", "", "", "\u0000", "\n", "\t", "\u007f", "\u001f"]
        : [""])
    )
  ).map(([length, first, second, pad, injected]) => {
    const half = Math.floor(length / 2);
    return `${pad}${first.repeat(half)}${injected}${second.repeat(length - half)}${pad}`;
  });

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
    const anyInput = tuple(
      constantFrom(
        "support",
        "support",
        "privacy",
        "privacy",
        "other",
        "",
        "Support"
      ),
      oneof(shortText, cleanShort, cleanShort, textAround(500)),
      oneof(
        constant(null),
        constant(undefined),
        shortText,
        prose,
        prose,
        textAround(2000)
      )
    );
    // Aimed at the edges: a known kind and a reason with no control character, so the length (or, in the
    // context, the one control character) is what decides.
    const edgeInput = tuple(
      constantFrom("support", "privacy"),
      oneof(cleanShort, textAround(500, false)),
      oneof(prose, textAround(2000, false), textAround(2000))
    );
    const input = oneof(anyInput, edgeInput, edgeInput);
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
    // The edges are written with the 366 of the rule, not with the constant of the code.
    const limit = 366 * DAY_MS;
    const delta = oneof(
      {
        arbitrary: integer({ max: 400 * DAY_MS, min: -3 * DAY_MS }),
        weight: 1,
      },
      {
        arbitrary: constantFrom(
          0,
          1,
          -1,
          1000,
          -1000,
          limit - 1000,
          limit - 1,
          limit,
          limit + 1,
          limit + 1000,
          limit - DAY_MS,
          limit + DAY_MS
        ),
        weight: 4,
      }
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
    type Parts = [number, number, number, number, number, number];
    const randomParts = tuple(
      integer({ max: 2027, min: 2026 }),
      integer({ max: 13, min: 0 }),
      integer({ max: 32, min: 0 }),
      integer({ max: 25, min: 0 }),
      integer({ max: 61, min: 0 }),
      integer({ max: 61, min: 0 })
    );
    // Months inside the window (October 2026 to October 2027) with the day at the edges of the month
    // (first, last, one past the last, zero) and the clock at the edges of its fields.
    const windowMonths: [number, number][] = [
      [2026, 10],
      [2026, 11],
      [2026, 12],
      ...Array.from({ length: 10 }, (_, index): [number, number] => [
        2027,
        index + 1,
      ]),
    ];
    const edgeParts = tuple(
      constantFrom(...windowMonths),
      constantFrom("first", "last", "past", "zero"),
      constantFrom(0, 12, 23, 24),
      constantFrom(0, 59, 60),
      constantFrom(0, 59, 60)
    ).map(([[year, month], where, hour, minute, second]): Parts => {
      const last = daysInMonth(year, month);
      const day = { first: 1, last, past: last + 1, zero: 0 }[where];
      return [year, month, day, hour, minute, second];
    });
    // The two ends of the window (now, now + 366 days) and one second to each side of them.
    const windowEnds = constantFrom<Parts[]>(
      [2027, 10, 21, 12, 0, 0],
      [2027, 10, 21, 12, 0, 1],
      [2027, 10, 21, 11, 59, 59],
      [2026, 10, 20, 12, 0, 0],
      [2026, 10, 20, 12, 0, 1],
      [2026, 10, 20, 11, 59, 59]
    );
    const parts = oneof(randomParts, edgeParts, edgeParts, windowEnds);
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
