import {
  createPasswordHasher,
  type PasswordHasher,
  type PasswordHashStore,
} from "./password-hash";

/**
 * A stand-in of the two database functions for the tests without PostgreSQL: a bcrypt-shaped string
 * (`$2a$11$`, 22 characters of salt, 31 of digest) whose digest is a SHA-256 of salt and key, so a check
 * recomputes it from the salt of the stored hash as `crypt` does. The real bcrypt is proven by the gate.
 */
export const testPasswordPepper =
  "test-only-password-pepper-of-32-chars-at-least";

const ALPHABET =
  "./ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const SALT_LENGTH = 22;
const DIGEST_LENGTH = 31;
const PREFIX = "$2a$11$";

function encode(bytes: Uint8Array, length: number): string {
  return Array.from(
    bytes.slice(0, length),
    (byte) => ALPHABET[byte % ALPHABET.length]
  ).join("");
}

async function digestOf(salt: string, key: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${salt}:${key}`)
  );
  return encode(new Uint8Array(digest), DIGEST_LENGTH);
}

export function createTestPasswordHashStore(): PasswordHashStore & {
  keys: string[];
} {
  const keys: string[] = [];
  return {
    async crypt(key, hash) {
      keys.push(key);
      const salt = hash.slice(PREFIX.length, PREFIX.length + SALT_LENGTH);
      return `${PREFIX}${salt}${await digestOf(salt, key)}`;
    },
    async hash(key) {
      keys.push(key);
      const salt = encode(
        crypto.getRandomValues(new Uint8Array(SALT_LENGTH)),
        SALT_LENGTH
      );
      return `${PREFIX}${salt}${await digestOf(salt, key)}`;
    },
    keys,
  };
}

export function createTestPasswordHasher(): PasswordHasher {
  return createPasswordHasher({
    pepper: testPasswordPepper,
    store: createTestPasswordHashStore(),
  });
}
