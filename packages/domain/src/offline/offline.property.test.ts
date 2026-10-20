import {
  array,
  constant,
  constantFrom,
  integer,
  oneof,
  property,
  string,
  tuple,
  uuid,
} from "fast-check";
import { describe, expect, it } from "vitest";
import { assertProperty } from "../testing/property";
import {
  assertOfflineGrantWindow,
  InvalidDeviceLabelError,
  InvalidOfflineGrantWindowError,
  MAX_DEVICE_LABEL_CODE_POINTS,
  normalizeDeviceLabel,
  offlineGrantStatus,
} from "./offline-grant";
import {
  assertOfflineLeaseCurrent,
  buildOfflineLeaseClaims,
  InvalidOfflineLeaseError,
  isOfflineLeaseClaims,
  OfflineLeaseNotAvailableError,
  parseOfflineLeaseClaims,
  planOfflineLeaseWindow,
  serializeOfflineLeaseClaims,
} from "./offline-lease";

/*
 * Invariants of the offline area (docs/testing/property-invariants.md, OFF-1 to OFF-5): the lease that
 * lets a device keep working without a connection, and the grant behind it. The oracles are restated
 * arithmetic on seconds, and a sort-and-dedupe model for the capabilities.
 */

const HOUR_MS = 3_600_000;
const SECOND_MS = 1000;
const wideInstant = integer({ max: 4_102_444_800_000, min: 1_000_000 });
// a third of the instants sit on a whole second and a third one millisecond before the next, so the
// rounding to whole seconds is exercised at both ends
const instant = oneof(
  wideInstant,
  wideInstant.map((ms) => ms - (ms % SECOND_MS)),
  wideInstant.map((ms) => ms - (ms % SECOND_MS) + 999)
).map((ms) => new Date(ms));

const capability = oneof(
  constantFrom(
    "sale:create",
    "sale:cancel",
    "inventory:receive",
    "product:read",
    "a",
    "z"
  ),
  string({ maxLength: 12, minLength: 1 })
);

describe("offline lease (OFF-1 to OFF-3)", () => {
  it("OFF-1: a lease built from the planned window is always valid, lasts whole seconds and never more than 72 hours", () => {
    assertProperty(
      property(
        instant,
        oneof(
          constant(null),
          integer({ max: 100 * HOUR_MS, min: -HOUR_MS }),
          // the edges: the 72-hour cap and the whole second of the end, one millisecond and one second either side
          constantFrom(
            -1000,
            -999,
            -1,
            0,
            1,
            999,
            1000,
            1001,
            1999,
            2000,
            72 * HOUR_MS - 1001,
            72 * HOUR_MS - 1000,
            72 * HOUR_MS - 1,
            72 * HOUR_MS,
            72 * HOUR_MS + 1,
            72 * HOUR_MS + 999,
            72 * HOUR_MS + 1000
          )
        ),
        uuid(),
        uuid(),
        array(capability, { maxLength: 10 }),
        integer({ max: 1000, min: 0 }),
        (now, entitlementDelta, jti, dev, caps, epoch) => {
          const entitlementEndsAt =
            entitlementDelta === null
              ? null
              : new Date(now.getTime() + entitlementDelta);
          let window: ReturnType<typeof planOfflineLeaseWindow>;
          try {
            window = planOfflineLeaseWindow({ entitlementEndsAt, now });
          } catch (error) {
            // refused: the model says the entitlement leaves less than one whole second
            expect(error).toBeInstanceOf(OfflineLeaseNotAvailableError);
            expect(entitlementEndsAt).not.toBeNull();
            const issued = Math.floor(now.getTime() / SECOND_MS) * SECOND_MS;
            const ends =
              Math.floor((entitlementEndsAt as Date).getTime() / SECOND_MS) *
              SECOND_MS;
            expect(ends).toBeLessThanOrEqual(issued);
            return;
          }
          const claims = buildOfflineLeaseClaims({
            capabilities: caps,
            deviceId: dev,
            epoch,
            expiresAt: window.expiresAt,
            grantId: jti,
            issuedAt: window.issuedAt,
            organizationId: "org-1",
            userId: "user-1",
          });
          expect(isOfflineLeaseClaims(claims)).toBe(true);
          expect(claims.exp).toBeGreaterThan(claims.iat);
          expect((claims.exp - claims.iat) * SECOND_MS).toBeLessThanOrEqual(
            72 * HOUR_MS
          );
          expect(window.issuedAt.getTime() % SECOND_MS).toBe(0);
          expect(window.expiresAt.getTime() % SECOND_MS).toBe(0);
          expect(window.issuedAt.getTime()).toBeLessThanOrEqual(now.getTime());
          // the exact lifetime: 72 hours, or less when the entitlement ends sooner (whole seconds)
          const issuedSeconds = Math.floor(now.getTime() / SECOND_MS);
          const endsSeconds =
            entitlementEndsAt === null
              ? Number.POSITIVE_INFINITY
              : Math.floor(entitlementEndsAt.getTime() / SECOND_MS);
          const expected = Math.min(259_200, endsSeconds - issuedSeconds);
          expect(expected).toBeGreaterThan(0);
          expect(claims.exp - claims.iat).toBe(expected);
        }
      )
    );
  });

  it("OFF-1: the lifetime of a lease or a grant is at least one second and at most 72 hours, with the edges refused", () => {
    assertProperty(
      property(
        wideInstant.map((ms) => new Date(ms - (ms % SECOND_MS))),
        oneof(
          integer({ max: 100 * HOUR_MS, min: -HOUR_MS }),
          constantFrom(
            -1000,
            -1,
            0,
            1,
            999,
            1000,
            1001,
            72 * HOUR_MS - 1000,
            72 * HOUR_MS - 1,
            72 * HOUR_MS,
            72 * HOUR_MS + 1,
            72 * HOUR_MS + 999,
            72 * HOUR_MS + 1000
          )
        ),
        (issuedAt, lifetimeMs) => {
          const expiresAt = new Date(issuedAt.getTime() + lifetimeMs);
          // the lease counts whole seconds (the expiry is rounded down), the grant counts milliseconds
          const wholeSeconds = Math.floor(lifetimeMs / SECOND_MS);
          const leaseOk = wholeSeconds >= 1 && wholeSeconds <= 259_200;
          const build = () =>
            buildOfflineLeaseClaims({
              capabilities: [],
              deviceId: "11111111-1111-4111-8111-111111111111",
              epoch: 0,
              expiresAt,
              grantId: "22222222-2222-4222-8222-222222222222",
              issuedAt,
              organizationId: "org-1",
              userId: "user-1",
            });
          if (leaseOk) {
            expect(build).not.toThrow();
          } else {
            expect(build).toThrow(InvalidOfflineLeaseError);
          }
          const grant = () => assertOfflineGrantWindow({ expiresAt, issuedAt });
          if (lifetimeMs >= 1 && lifetimeMs <= 259_200_000) {
            expect(grant).not.toThrow();
          } else {
            expect(grant).toThrow(InvalidOfflineGrantWindowError);
          }
        }
      )
    );
  });

  it("OFF-2: the lease holds at most 64 distinct capabilities of at most 64 characters, ids of at most 255, and refuses an epoch below 0 or an issue second below 1", () => {
    const edge = (max: number) =>
      oneof(
        integer({ max: max + 5, min: 0 }),
        constantFrom(0, 1, max - 1, max, max + 1)
      );
    assertProperty(
      property(
        edge(64),
        edge(64),
        edge(255),
        constantFrom(-1, 0, 1),
        constantFrom(-1, 0, 1, 2),
        (count, capabilityLength, idLength, epoch, issuedSeconds) => {
          // distinct capabilities: the first has exactly `capabilityLength` characters (0 is the empty one)
          const capabilities = Array.from({ length: count }, (_, index) =>
            index === 0 ? "c".repeat(capabilityLength) : `${index}`
          );
          const issuedAt = new Date(issuedSeconds * SECOND_MS);
          const build = () =>
            buildOfflineLeaseClaims({
              capabilities,
              deviceId: "11111111-1111-4111-8111-111111111111",
              epoch,
              expiresAt: new Date((issuedSeconds + 60) * SECOND_MS),
              grantId: "22222222-2222-4222-8222-222222222222",
              issuedAt,
              organizationId: "o".repeat(idLength),
              userId: "u".repeat(idLength),
            });
          const ok =
            count <= 64 &&
            (count === 0 ||
              (capabilityLength >= 1 && capabilityLength <= 64)) &&
            idLength >= 1 &&
            idLength <= 255 &&
            epoch >= 0 &&
            issuedSeconds >= 1;
          if (ok) {
            expect(build).not.toThrow();
          } else {
            expect(build).toThrow(InvalidOfflineLeaseError);
          }
        }
      )
    );
  });

  it("OFF-2: the signed bytes do not depend on the order or the repeats of the capabilities, and parsing them gives the claims back", () => {
    assertProperty(
      property(
        instant,
        uuid(),
        uuid(),
        array(capability, { maxLength: 12 }),
        integer({ max: 1000, min: 0 }),
        (now, jti, dev, caps, epoch) => {
          const window = planOfflineLeaseWindow({ now });
          const build = (capabilities: readonly string[]) =>
            buildOfflineLeaseClaims({
              capabilities,
              deviceId: dev,
              epoch,
              expiresAt: window.expiresAt,
              grantId: jti,
              issuedAt: window.issuedAt,
              organizationId: "org-1",
              userId: "user-1",
            });
          const claims = build(caps);
          // model: the sorted set of the capabilities
          expect(claims.caps).toEqual([...new Set(caps)].sort());
          const shuffled = [...caps].reverse().concat(caps);
          expect(serializeOfflineLeaseClaims(build(shuffled))).toBe(
            serializeOfflineLeaseClaims(claims)
          );
          expect(
            parseOfflineLeaseClaims(serializeOfflineLeaseClaims(claims))
          ).toEqual(claims);
        }
      )
    );
  });

  it("OFF-3: claims are current exactly while now is before the expiry second and the issue is at most 5 minutes ahead of the clock; an expired lease is reported as expired even if also issued ahead", () => {
    // the edges are written as literals (one second, five minutes), not read from the implementation's constants
    const FIVE_MINUTES_MS = 300_000;
    assertProperty(
      property(
        instant,
        // a negative lifetime is a lease that expired before it was issued: built by hand, as no builder makes one
        integer({ max: 72 * 3600, min: -3600 }),
        integer({ max: 80 * HOUR_MS, min: -12 * HOUR_MS }),
        (issuedAt, lifetimeSeconds, anyOffset) => {
          const iat = Math.floor(issuedAt.getTime() / SECOND_MS);
          const claims = {
            caps: [],
            dev: "11111111-1111-4111-8111-111111111111",
            epoch: 0,
            exp: iat + lifetimeSeconds,
            iat,
            jti: "22222222-2222-4222-8222-222222222222",
            org: "org-1",
            sub: "user-1",
            v: 1,
          } as const;
          // the edges of both rules (one millisecond either side), then a free offset
          const edges = [
            lifetimeSeconds * SECOND_MS - 1,
            lifetimeSeconds * SECOND_MS,
            lifetimeSeconds * SECOND_MS + 1,
            -FIVE_MINUTES_MS - 1,
            -FIVE_MINUTES_MS,
            -FIVE_MINUTES_MS + 1,
          ];
          const offsets = [...edges, anyOffset];
          for (const offset of offsets) {
            const now = new Date(iat * SECOND_MS + offset);
            const expired = now.getTime() >= claims.exp * SECOND_MS;
            const notYet =
              claims.iat * SECOND_MS > now.getTime() + FIVE_MINUTES_MS;
            let reason: string | undefined;
            try {
              assertOfflineLeaseCurrent(claims, now);
            } catch (error) {
              ({ reason } = error as InvalidOfflineLeaseError);
            }
            if (expired) {
              expect(reason).toBe("expired");
            } else if (notYet) {
              expect(reason).toBe("not_yet_valid");
            } else {
              expect(reason).toBeUndefined();
            }
          }
        }
      )
    );
  });
});

describe("offline grant (OFF-4 to OFF-5)", () => {
  it("OFF-4: revocation wins over time, and an unrevoked grant is active exactly until its expiry instant", () => {
    assertProperty(
      property(
        instant,
        oneof(
          integer({ max: 100 * HOUR_MS, min: -100 * HOUR_MS }),
          constantFrom(-1000, -1, 0, 1, 1000)
        ),
        oneof(constant(null), instant),
        (expiresAt, nowOffset, revokedAt) => {
          const now = new Date(expiresAt.getTime() + nowOffset);
          const status = offlineGrantStatus({ expiresAt, revokedAt }, now);
          if (revokedAt === null) {
            expect(status).toBe(nowOffset < 0 ? "active" : "expired");
          } else {
            expect(status).toBe("revoked");
          }
        }
      )
    );
  });

  it("OFF-5: a device label is kept trimmed when it is one clean line of at most 80 characters, empty means none, anything else is refused", () => {
    const awkward = constantFrom(
      "a",
      "Balcão",
      "😀",
      " ",
      "\t",
      "\n",
      "\u0000",
      "\u007f",
      "\u0085",
      "\u009f",
      "\u001f",
      "~",
      "\u00a1",
      " "
    );
    const label = oneof(
      constant(null),
      constant(undefined),
      array(awkward, { maxLength: 8 }).map((chars) => chars.join("")),
      tuple(
        integer({
          max: MAX_DEVICE_LABEL_CODE_POINTS + 3,
          min: MAX_DEVICE_LABEL_CODE_POINTS - 3,
        }),
        constantFrom("a", "😀"),
        constantFrom("", " ", "  ")
      ).map(([length, symbol, pad]) => `${pad}${symbol.repeat(length)}${pad}`),
      // a clean label of 79, 80 and 81 characters with one awkward character at the start, middle or end
      tuple(
        constantFrom(79, 80, 81),
        constantFrom("a", "😀"),
        awkward,
        constantFrom("start", "middle", "end")
      ).map(([length, symbol, odd, where]) => {
        const chars = [...symbol.repeat(length)];
        chars.splice({ end: length, middle: 40, start: 0 }[where], 0, odd);
        return chars.join("");
      })
    );
    assertProperty(
      property(label, (text) => {
        const run = () => normalizeDeviceLabel(text);
        const trimmed = text?.trim() ?? "";
        const hasControl = [...trimmed].some((char) => {
          const code = char.codePointAt(0) as number;
          return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
        });
        if (trimmed === "") {
          expect(run()).toBeNull();
        } else if ([...trimmed].length > 80 || hasControl) {
          expect(run).toThrow(InvalidDeviceLabelError);
        } else {
          expect(run()).toBe(trimmed);
        }
      })
    );
  });
});
