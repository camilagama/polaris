import { normalizePassword } from "./password-policy";

/**
 * The hash of a password without spending the Worker's CPU (ADR 0100, amended). The Worker computes only
 * `k = hex(HMAC-SHA-256(pepper, NFC password))` with WebCrypto, microseconds; the bcrypt of `k` (cost 11) runs in
 * PostgreSQL (`auth_password_hash` and `auth_password_crypt`, migration 0112), and waiting for the database is not
 * CPU time. The password never leaves the Worker, and `k` is worthless without the pepper.
 *
 * Stored as `pgbf1$<bcrypt>`: the digit reserves the version of the pepper; only version 1 exists, so a new pepper
 * invalidates every stored password. A hash in any other format never matches and is never recomputed in its own
 * algorithm (that would spend the Worker's CPU); one bcrypt of `k` is still made and dropped, so the answer takes as
 * long as the one for an e-mail without an account (Better Auth hashes the password typed for it).
 */
export const PASSWORD_HASH_PREFIX = "pgbf1$";
/** At least 32 characters: the runbook makes it from 32 random bytes in base64 (44 characters). */
const PASSWORD_PEPPER_MIN_LENGTH = 32;

const PASSWORD_HASH_QUERY_TIMEOUT_MS = 5000;
// what `auth_password_crypt` accepts: anything else would raise there, and it is a wrong password here
const STORED_BCRYPT_PATTERN = /^\$2a\$1[0-4]\$[./A-Za-z0-9]{53}$/;

/** The two calls to the database, by `k` only. */
export interface PasswordHashStore {
  /** The bcrypt of `k` with the salt and the cost of `hash`. */
  crypt: (key: string, hash: string) => Promise<string>;
  /** A new bcrypt of `k`, cost 11. */
  hash: (key: string) => Promise<string>;
}

export interface PasswordHasher {
  hash: (password: string) => Promise<string>;
  verify: (input: { hash: string; password: string }) => Promise<boolean>;
}

/** The part of a `pg` pool (or client) the store uses. */
export interface PasswordHashQueryable {
  query: (config: {
    query_timeout: number;
    text: string;
    values: unknown[];
  }) => Promise<{ rows: Record<string, unknown>[] }>;
}

/** Without a pepper there is no password: the sign-in by password fails closed. Never carries a value. */
export class PasswordPepperMissingError extends Error {
  constructor() {
    super("AUTH_PASSWORD_PEPPER is missing or shorter than 32 characters.");
    this.name = "PasswordPepperMissingError";
  }
}

/** The pepper of the bindings, or undefined when it cannot be one (absent, blank or too short). */
export function usablePasswordPepper(
  pepper: string | undefined
): string | undefined {
  const trimmed = pepper?.trim();
  return trimmed && trimmed.length >= PASSWORD_PEPPER_MIN_LENGTH
    ? trimmed
    : undefined;
}

const encoder = new TextEncoder();
const importedPeppers = new Map<string, Promise<CryptoKey>>();

function hmacKeyOf(pepper: string): Promise<CryptoKey> {
  let imported = importedPeppers.get(pepper);
  if (!imported) {
    imported = crypto.subtle.importKey(
      "raw",
      encoder.encode(pepper),
      { hash: "SHA-256", name: "HMAC" },
      false,
      ["sign"]
    );
    // a rotation leaves one more key behind, never more than the peppers of one isolate's life
    importedPeppers.set(pepper, imported);
  }
  return imported;
}

/** `k`: the HMAC-SHA-256 of the NFC password with the pepper, 64 lowercase hex digits. */
export async function passwordKey(
  pepper: string,
  password: string
): Promise<string> {
  const usable = usablePasswordPepper(pepper);
  if (!usable) {
    throw new PasswordPepperMissingError();
  }
  const signature = await crypto.subtle.sign(
    "HMAC",
    await hmacKeyOf(usable),
    encoder.encode(normalizePassword(password))
  );
  return Array.from(new Uint8Array(signature), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

/** Equal strings in a time that depends on their length only, never on where they first differ. */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) {
    // biome-ignore lint/suspicious/noBitwiseOperators: the comparison must not stop at the first difference
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return difference === 0;
}

export function createDatabasePasswordHashStore(
  queryable: () => PasswordHashQueryable
): PasswordHashStore {
  const run = async (text: string, values: string[]) => {
    const { rows } = await queryable().query({
      query_timeout: PASSWORD_HASH_QUERY_TIMEOUT_MS,
      text,
      values,
    });
    const value = rows[0]?.hash;
    if (typeof value !== "string") {
      throw new Error("The database returned no password hash.");
    }
    return value;
  };
  return {
    crypt: (key, hash) =>
      run("SELECT public.auth_password_crypt($1::text, $2::text) AS hash", [
        key,
        hash,
      ]),
    hash: (key) =>
      run("SELECT public.auth_password_hash($1::text) AS hash", [key]),
  };
}

export function createPasswordHasher({
  pepper,
  store,
}: {
  pepper: string | undefined;
  store: PasswordHashStore;
}): PasswordHasher {
  const keyOf = (password: string) => {
    if (pepper === undefined) {
      throw new PasswordPepperMissingError();
    }
    return passwordKey(pepper, password);
  };
  return {
    async hash(password) {
      const key = await keyOf(password);
      return `${PASSWORD_HASH_PREFIX}${await store.hash(key)}`;
    },
    async verify({ hash, password }) {
      const key = await keyOf(password);
      const stored = hash.startsWith(PASSWORD_HASH_PREFIX)
        ? hash.slice(PASSWORD_HASH_PREFIX.length)
        : "";
      if (!STORED_BCRYPT_PATTERN.test(stored)) {
        await store.hash(key);
        return false;
      }
      return constantTimeEqual(await store.crypt(key, stored), stored);
    },
  };
}
