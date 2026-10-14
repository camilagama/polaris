import {
  buildOfflineLeaseClaims,
  InvalidOfflineLeaseError,
  OFFLINE_LEASE_CLOCK_SKEW_MS,
} from "@polaris/domain/offline/offline-lease";
import { describe, expect, it } from "vitest";
import {
  InvalidOfflineLeaseKeyError,
  readUnverifiedOfflineLease,
  signOfflineLease,
  verifyOfflineLease,
} from "./offline-lease-token";

const key = { id: "k1", secret: "a".repeat(32) };
const otherKey = { id: "k1", secret: "b".repeat(32) };
const issuedAt = new Date("2026-10-14T12:00:00.000Z");
const expiresAt = new Date(issuedAt.getTime() + 72 * 3_600_000);

const claims = () =>
  buildOfflineLeaseClaims({
    capabilities: ["sale:create", "catalog:read"],
    deviceId: "0198e5f0-0000-7000-8000-0000000000d1",
    epoch: 2,
    expiresAt,
    grantId: "0198e5f0-0000-7000-8000-0000000000a1",
    issuedAt,
    organizationId: "org-1",
    userId: "user-1",
  });

async function rejection(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(InvalidOfflineLeaseError);
    return (error as InvalidOfflineLeaseError).reason;
  }
  throw new Error("expected the lease to be rejected");
}

function replacePart(token: string, index: number, value: string): string {
  const parts = token.split(".");
  parts[index] = value;
  return parts.join(".");
}

function base64Url(text: string): string {
  return btoa(text)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

describe("offline lease token", () => {
  it("round-trips the claims", async () => {
    const token = await signOfflineLease(claims(), key);
    expect(token.startsWith("v1.k1.")).toBe(true);
    await expect(
      verifyOfflineLease(token, [key], new Date(issuedAt.getTime() + 1000))
    ).resolves.toEqual(claims());
  });

  it("rejects a changed payload (privilege escalation attempt)", async () => {
    const token = await signOfflineLease(claims(), key);
    const forged = base64Url(
      JSON.stringify({ ...claims(), caps: ["organization:manage"] })
    );
    expect(
      await rejection(
        verifyOfflineLease(replacePart(token, 2, forged), [key], issuedAt)
      )
    ).toBe("bad_signature");
  });

  it("rejects a different secret and a flipped signature", async () => {
    const token = await signOfflineLease(claims(), key);
    expect(
      await rejection(verifyOfflineLease(token, [otherKey], issuedAt))
    ).toBe("bad_signature");
    const signature = token.split(".")[3] ?? "";
    const flipped = `${signature.startsWith("A") ? "B" : "A"}${signature.slice(1)}`;
    expect(
      await rejection(
        verifyOfflineLease(replacePart(token, 3, flipped), [key], issuedAt)
      )
    ).toBe("bad_signature");
  });

  it("verifies with any configured key id, enabling rotation", async () => {
    const next = { id: "k2", secret: "c".repeat(40) };
    const oldToken = await signOfflineLease(claims(), key);
    const newToken = await signOfflineLease(claims(), next);
    await expect(
      verifyOfflineLease(oldToken, [next, key], issuedAt)
    ).resolves.toBeDefined();
    await expect(
      verifyOfflineLease(newToken, [next, key], issuedAt)
    ).resolves.toBeDefined();
    expect(
      await rejection(verifyOfflineLease(oldToken, [next], issuedAt))
    ).toBe("unknown_key");
  });

  it("checks the validity window after the signature", async () => {
    const token = await signOfflineLease(claims(), key);
    expect(await rejection(verifyOfflineLease(token, [key], expiresAt))).toBe(
      "expired"
    );
    const early = new Date(
      issuedAt.getTime() - OFFLINE_LEASE_CLOCK_SKEW_MS - 1000
    );
    expect(await rejection(verifyOfflineLease(token, [key], early))).toBe(
      "not_yet_valid"
    );
  });

  it("rejects malformed tokens with a typed error", async () => {
    const token = await signOfflineLease(claims(), key);
    for (const bad of [
      "",
      "abc",
      "v1.k1.payload",
      `${token}.extra`,
      replacePart(token, 2, "%%%"),
      replacePart(token, 2, "e30"),
      replacePart(token, 3, "***"),
      `v1.k1.${"a".repeat(5000)}.sig`,
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: each token is checked on its own
      const reason = await rejection(verifyOfflineLease(bad, [key], issuedAt));
      expect(["malformed", "bad_signature"]).toContain(reason);
    }
    expect(
      await rejection(
        verifyOfflineLease(replacePart(token, 0, "v2"), [key], issuedAt)
      )
    ).toBe("unsupported_version");
  });

  it("refuses short secrets and invalid key ids", async () => {
    await expect(
      signOfflineLease(claims(), { id: "k1", secret: "short" })
    ).rejects.toBeInstanceOf(InvalidOfflineLeaseKeyError);
    await expect(
      signOfflineLease(claims(), { id: "bad id", secret: "a".repeat(32) })
    ).rejects.toBeInstanceOf(InvalidOfflineLeaseKeyError);
  });

  it("lets the client read the claims without trusting them", async () => {
    const token = await signOfflineLease(claims(), key);
    expect(readUnverifiedOfflineLease(token)).toEqual(claims());
    expect(readUnverifiedOfflineLease("garbage")).toBeNull();
  });
});
