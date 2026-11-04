// biome-ignore-all lint/performance/noAwaitInLoops: each case on its own, for a clear failure
import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  constantTimeEqual,
  createDatabasePasswordHashStore,
  createPasswordHasher,
  PASSWORD_HASH_PREFIX,
  PasswordPepperMissingError,
  passwordKey,
  usablePasswordPepper,
} from "./password-hash";
import {
  createTestPasswordHashStore,
  testPasswordPepper,
} from "./password-hash-test-support";

const KEY_PATTERN = /^[0-9a-f]{64}$/;
const STORED_PATTERN = /^pgbf1\$\$2a\$11\$[./A-Za-z0-9]{53}$/;
const OLD_SCRYPT_HASH = `${"ab".repeat(16)}:${"cd".repeat(64)}`;

describe("passwordKey", () => {
  it("is the HMAC-SHA-256 of the NFC password with the pepper, in lowercase hex", async () => {
    const expected = createHmac("sha256", testPasswordPepper)
      .update("Ação2026", "utf8")
      .digest("hex");
    expect(await passwordKey(testPasswordPepper, "Ação2026")).toBe(expected);
    expect(await passwordKey(testPasswordPepper, "Ação2026")).toBe(expected);
    expect(expected).toMatch(KEY_PATTERN);
  });

  it("changes with the pepper", async () => {
    const other = `${testPasswordPepper}-other`;
    expect(await passwordKey(other, "Abcdefg1")).not.toBe(
      await passwordKey(testPasswordPepper, "Abcdefg1")
    );
  });

  it("refuses a pepper that is absent, blank or shorter than 32 characters, without its value", async () => {
    for (const pepper of ["", "   ", "x".repeat(31)]) {
      const failure = await passwordKey(pepper, "Abcdefg1").catch(
        (error: unknown) => error
      );
      expect(failure).toBeInstanceOf(PasswordPepperMissingError);
      expect(String(failure)).not.toContain("x".repeat(31));
    }
    expect(usablePasswordPepper(undefined)).toBeUndefined();
    expect(usablePasswordPepper(` ${"y".repeat(32)} `)).toBe("y".repeat(32));
  });
});

describe("password hasher", () => {
  it("stores pgbf1$ and the bcrypt of k, and checks the right password and only it", async () => {
    const store = createTestPasswordHashStore();
    const hasher = createPasswordHasher({ pepper: testPasswordPepper, store });
    const stored = await hasher.hash("Ação2026");
    expect(stored).toMatch(STORED_PATTERN);
    expect(await hasher.verify({ hash: stored, password: "Ação2026" })).toBe(
      true
    );
    expect(await hasher.verify({ hash: stored, password: "Ação2026" })).toBe(
      true
    );
    expect(await hasher.verify({ hash: stored, password: "Acao2026" })).toBe(
      false
    );
  });

  it("sends only k to the store, never the password", async () => {
    const store = createTestPasswordHashStore();
    const hasher = createPasswordHasher({ pepper: testPasswordPepper, store });
    const stored = await hasher.hash("Senha secreta 1A");
    await hasher.verify({ hash: stored, password: "Senha secreta 1A" });
    expect(store.keys).toHaveLength(2);
    for (const key of store.keys) {
      expect(key).toMatch(KEY_PATTERN);
      expect(key).not.toContain("Senha");
    }
  });

  it("answers an old scrypt hash, or any hash without the prefix, as a wrong password without computing anything", async () => {
    const store = {
      crypt: vi.fn(() => Promise.resolve("never")),
      hash: vi.fn(() => Promise.resolve("never")),
    };
    const hasher = createPasswordHasher({ pepper: testPasswordPepper, store });
    for (const hash of [
      OLD_SCRYPT_HASH,
      "",
      `${PASSWORD_HASH_PREFIX}not-a-bcrypt`,
      `pgbf2$$2a$11$${"a".repeat(53)}`,
    ]) {
      expect(await hasher.verify({ hash, password: "Abcdefg1" })).toBe(false);
    }
    expect(store.crypt).not.toHaveBeenCalled();
  });

  it("fails closed without a pepper", async () => {
    const hasher = createPasswordHasher({
      pepper: undefined,
      store: createTestPasswordHashStore(),
    });
    await expect(hasher.hash("Abcdefg1")).rejects.toBeInstanceOf(
      PasswordPepperMissingError
    );
    await expect(
      hasher.verify({
        hash: `${PASSWORD_HASH_PREFIX}$2a$11$${"a".repeat(53)}`,
        password: "Abcdefg1",
      })
    ).rejects.toBeInstanceOf(PasswordPepperMissingError);
  });
});

describe("database store", () => {
  it("calls the two functions with k only, with a timeout", async () => {
    const query = vi.fn((_config: { text: string; values: unknown[] }) =>
      Promise.resolve({ rows: [{ hash: "$2a$11$x" }] })
    );
    const store = createDatabasePasswordHashStore(() => ({ query }));
    await store.hash("a".repeat(64));
    await store.crypt("b".repeat(64), "$2a$11$y");
    expect(query.mock.calls.map(([config]) => config)).toEqual([
      {
        query_timeout: 5000,
        text: "SELECT public.auth_password_hash($1::text) AS hash",
        values: ["a".repeat(64)],
      },
      {
        query_timeout: 5000,
        text: "SELECT public.auth_password_crypt($1::text, $2::text) AS hash",
        values: ["b".repeat(64), "$2a$11$y"],
      },
    ]);
  });

  it("fails when the database returns no hash", async () => {
    const store = createDatabasePasswordHashStore(() => ({
      query: () => Promise.resolve({ rows: [] }),
    }));
    await expect(store.hash("a".repeat(64))).rejects.toThrow(
      "no password hash"
    );
  });
});

describe("constantTimeEqual", () => {
  it("compares whole strings", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", "ab")).toBe(false);
    expect(constantTimeEqual("", "")).toBe(true);
  });
});
