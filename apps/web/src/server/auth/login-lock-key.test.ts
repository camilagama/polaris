// biome-ignore-all lint/performance/noAwaitInLoops: the probes run one at a time, for a clear failure
import { createHmac } from "node:crypto";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { describe, expect, it } from "vitest";
import { limiterKey } from "./abuse-protection";
import { loginLockKey, normalizeLoginLockEmail } from "./login-lock-key";

const secret = "test-only-better-auth-secret-32-bytes";
const HEX_64 = /^[0-9a-f]{64}$/;

// spellings of e-mails a person could type: case, accents in composed and decomposed form, the dotless i
// and the Kelvin sign (which lowercase to other letters), a Turkish capital, spaces around
const spellings = [
  "Ana@Example.com",
  "ana@example.com",
  "ANA@EXAMPLE.COM",
  "aNa@eXaMpLe.CoM",
  "José@Example.com",
  "josé@example.com",
  "José@Example.com",
  "josé@example.com",
  "İ@example.com",
  "i̇@example.com",
  "ı@example.com",
  "I@example.com",
  "K@example.com",
  "K@example.com",
  "k@example.com",
  " ana@example.com",
  "ana@example.com ",
  "ß@example.com",
  "SS@example.com",
  "ss@example.com",
];

async function betterAuthFinder() {
  const auth = betterAuth({
    baseURL: "http://localhost",
    database: memoryAdapter({
      account: [],
      session: [],
      user: [],
      verification: [],
    }),
    emailAndPassword: { enabled: true },
    secret,
  });
  const { internalAdapter } = await auth.$context;
  return internalAdapter;
}

describe("the key of the sign-in lock", () => {
  it("is 64 lowercase hex digits and never carries the e-mail", async () => {
    const key = await loginLockKey(secret, "ana@example.com");

    expect(key).toMatch(HEX_64);
    expect(key).not.toContain("ana");
    expect(key).not.toContain(":");
  });

  it("is the HMAC-SHA-256 of the scope and the normalized e-mail with the secret (the key the gate computes)", async () => {
    const key = await loginLockKey(secret, "Ana@Example.com ");

    expect(key).toBe(
      createHmac("sha256", secret)
        .update("login-lock\u0000ana@example.com")
        .digest("hex")
    );
  });

  it("depends on the secret and on its own scope", async () => {
    const key = await loginLockKey(secret, "ana@example.com");

    expect(await loginLockKey(`${secret}-other`, "ana@example.com")).not.toBe(
      key
    );
    // the same e-mail under another scope is the key of another limiter
    const other = await limiterKey(secret, "auth-ip", "ana@example.com");
    expect(other.slice("auth-ip:".length)).not.toBe(key);
  });

  it("counts separately for e-mails that are not the same address", async () => {
    expect(await loginLockKey(secret, "ana@example.com")).not.toBe(
      await loginLockKey(secret, "bia@example.com")
    );
  });

  it("fuses every spelling that Better Auth resolves to the same account", async () => {
    const adapter = await betterAuthFinder();
    // Better Auth stores the e-mail lowercased and looks it up lowercased: any two spellings that find the same
    // user must share the counter, or one capital letter would escape a lock
    const created = new Map<string, string>();
    for (const spelling of spellings) {
      const found = await adapter.findUserByEmail(spelling);
      if (found) {
        created.set(spelling, found.user.id);
        continue;
      }
      const user = await adapter.createUser({
        email: spelling,
        emailVerified: false,
        name: "Test",
      });
      created.set(spelling, user.id);
    }
    let fusedByBetterAuth = 0;
    for (const a of spellings) {
      for (const b of spellings) {
        if (created.get(a) === created.get(b)) {
          fusedByBetterAuth += 1;
          expect(await loginLockKey(secret, a)).toBe(
            await loginLockKey(secret, b)
          );
        }
      }
    }
    // the corpus does fuse something beyond each spelling with itself
    expect(fusedByBetterAuth).toBeGreaterThan(spellings.length);
  });

  it("also fuses the surrounding spaces and the composed and decomposed accents, which Better Auth does not", () => {
    expect(normalizeLoginLockEmail("  Ana@Example.com ")).toBe(
      "ana@example.com"
    );
    expect(normalizeLoginLockEmail("José@x.com")).toBe(
      normalizeLoginLockEmail("josé@x.com")
    );
  });

  it("is a fixed point, so a key of an already normalized e-mail does not move", () => {
    for (const spelling of spellings) {
      const once = normalizeLoginLockEmail(spelling);
      expect(normalizeLoginLockEmail(once)).toBe(once);
    }
  });
});
