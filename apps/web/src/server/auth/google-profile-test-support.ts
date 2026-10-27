import type { GoogleProfile } from "better-auth/social-providers";

/**
 * The claims Google answers for a test user, whole: since Better Auth 1.7 a provider's `getUserInfo` returns the
 * full profile, and the account is keyed by its `sub` (no `user.id` of its own).
 */
export function googleTestProfile(
  sub: string,
  email: string,
  emailVerified: boolean
): GoogleProfile {
  return {
    aud: "google-test-client",
    azp: "google-test-client",
    email,
    email_verified: emailVerified,
    exp: 0,
    family_name: "User",
    given_name: "Google Test",
    iat: 0,
    iss: "https://accounts.google.com",
    name: "Google Test User",
    picture: "",
    sub,
  };
}
