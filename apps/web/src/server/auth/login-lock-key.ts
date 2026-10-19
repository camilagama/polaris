import { limiterKey } from "./abuse-protection";

const LOGIN_LOCK_SCOPE = "login-lock";

/**
 * The e-mail as the sign-in lock counts it. Better Auth finds a user by `email.toLowerCase()` (Better Auth
 * 1.6, `findUserByEmail`), so two spellings that reach the same account must reach the same counter, or
 * a locked e-mail would be one capital letter away from a fresh count. The lowercase comes first, so
 * everything Better Auth fuses is fused here too; the trim and the NFC are extra and only fuse more (the format
 * of the e-mail is validated before the attempt is reserved, so no spelling is ever refused for them).
 */
export function normalizeLoginLockEmail(email: string): string {
  return email.toLowerCase().trim().normalize("NFC");
}

/**
 * The key of the row of `auth_login_lock`: the HMAC-SHA-256 (lowercase hex, 64 characters) of the normalized
 * e-mail, with its own scope and the Better Auth secret (ADR 0100). No new secret exists: rotating
 * `BETTER_AUTH_SECRET` only zeroes counters that live one day.
 */
export async function loginLockKey(
  secret: string,
  email: string
): Promise<string> {
  const scoped = await limiterKey(
    secret,
    LOGIN_LOCK_SCOPE,
    normalizeLoginLockEmail(email)
  );
  return scoped.slice(LOGIN_LOCK_SCOPE.length + 1);
}
