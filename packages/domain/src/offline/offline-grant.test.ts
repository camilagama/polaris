import { integer, property } from "fast-check";
import { assertProperty } from "../testing/property";
import { describe, expect, it } from "vitest";
import {
  assertOfflineGrantRevokeReason,
  assertOfflineGrantWindow,
  InvalidDeviceLabelError,
  InvalidOfflineGrantRevokeReasonError,
  InvalidOfflineGrantWindowError,
  MAX_DEVICE_LABEL_CODE_POINTS,
  normalizeDeviceLabel,
  OFFLINE_GRANT_MAX_LIFETIME_MS,
  offlineGrantStatus,
} from "./offline-grant";

const issuedAt = new Date("2026-10-14T12:00:00.000Z");

describe("device label", () => {
  it("is optional and trimmed", () => {
    expect(normalizeDeviceLabel(undefined)).toBeNull();
    expect(normalizeDeviceLabel(null)).toBeNull();
    expect(normalizeDeviceLabel("   ")).toBeNull();
    expect(normalizeDeviceLabel("  Balcão  ")).toBe("Balcão");
  });

  it("counts code points, not UTF-16 units", () => {
    expect(
      normalizeDeviceLabel("😀".repeat(MAX_DEVICE_LABEL_CODE_POINTS))
    ).toHaveLength(MAX_DEVICE_LABEL_CODE_POINTS * 2);
    expect(() =>
      normalizeDeviceLabel("😀".repeat(MAX_DEVICE_LABEL_CODE_POINTS + 1))
    ).toThrow(InvalidDeviceLabelError);
  });

  it("rejects control characters and line breaks", () => {
    for (const label of ["a\nb", "a\u0000b", "a\tb", "a\u007fb"]) {
      expect(() => normalizeDeviceLabel(label)).toThrow(
        InvalidDeviceLabelError
      );
    }
  });
});

describe("offline grant window", () => {
  it("accepts up to exactly 72 hours", () => {
    expect(() =>
      assertOfflineGrantWindow({
        expiresAt: new Date(issuedAt.getTime() + OFFLINE_GRANT_MAX_LIFETIME_MS),
        issuedAt,
      })
    ).not.toThrow();
  });

  it("rejects 72 hours and one millisecond, zero and negative windows", () => {
    for (const delta of [OFFLINE_GRANT_MAX_LIFETIME_MS + 1, 0, -1]) {
      expect(() =>
        assertOfflineGrantWindow({
          expiresAt: new Date(issuedAt.getTime() + delta),
          issuedAt,
        })
      ).toThrow(InvalidOfflineGrantWindowError);
    }
    expect(() =>
      assertOfflineGrantWindow({
        expiresAt: new Date(Number.NaN),
        issuedAt,
      })
    ).toThrow(InvalidOfflineGrantWindowError);
  });

  it("accepts a window iff 0 < lifetime <= 72h (property)", () => {
    assertProperty(
      property(
        integer({ max: OFFLINE_GRANT_MAX_LIFETIME_MS * 2, min: -1000 }),
        (delta) => {
          const run = () =>
            assertOfflineGrantWindow({
              expiresAt: new Date(issuedAt.getTime() + delta),
              issuedAt,
            });
          if (delta > 0 && delta <= OFFLINE_GRANT_MAX_LIFETIME_MS) {
            expect(run).not.toThrow();
          } else {
            expect(run).toThrow(InvalidOfflineGrantWindowError);
          }
        }
      )
    );
  });
});

describe("offline grant status", () => {
  const expiresAt = new Date(issuedAt.getTime() + 3_600_000);

  it("is active until the expiry instant", () => {
    expect(offlineGrantStatus({ expiresAt, revokedAt: null }, issuedAt)).toBe(
      "active"
    );
    expect(offlineGrantStatus({ expiresAt, revokedAt: null }, expiresAt)).toBe(
      "expired"
    );
  });

  it("is revoked even after it would have expired", () => {
    expect(
      offlineGrantStatus(
        { expiresAt, revokedAt: issuedAt },
        new Date(expiresAt.getTime() + 1)
      )
    ).toBe("revoked");
  });
});

describe("revoke reason", () => {
  it("accepts the known reasons only", () => {
    expect(() =>
      assertOfflineGrantRevokeReason("device_revoked")
    ).not.toThrow();
    expect(() => assertOfflineGrantRevokeReason("because")).toThrow(
      InvalidOfflineGrantRevokeReasonError
    );
  });
});
