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
  InvalidDeviceLabelError,
  MAX_DEVICE_LABEL_CODE_POINTS,
  normalizeDeviceLabel,
  offlineGrantStatus,
} from "./offline-grant";
import {
  assertOfflineLeaseCurrent,
  buildOfflineLeaseClaims,
  type InvalidOfflineLeaseError,
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
const instant = integer({ max: 4_102_444_800_000, min: 1_000_000 }).map(
  (ms) => new Date(ms)
);

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
        oneof(constant(null), integer({ max: 100 * HOUR_MS, min: -HOUR_MS })),
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
        integer({ max: 100 * HOUR_MS, min: -100 * HOUR_MS }),
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
      ).map(([length, symbol, pad]) => `${pad}${symbol.repeat(length)}${pad}`)
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
