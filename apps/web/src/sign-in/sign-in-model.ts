import { buildSocialSignInRequest } from "../lib/sign-in-path";

/** What the person can be told when the start of the Google sign-in does not work. */
export type SignInFailure = "indisponivel" | "limite";

export interface AuthMethodsView {
  emailPassword: boolean;
  google: boolean;
  turnstileSiteKey: string | null;
}

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

const GOOGLE_AUTHORIZATION_HOST = "accounts.google.com";

/** The answer of `/api/auth-methods`, or null when it is not what the server promises. */
export function parseAuthMethods(body: unknown): AuthMethodsView | null {
  if (typeof body !== "object" || body === null) {
    return null;
  }
  const { emailPassword, google, turnstileSiteKey } = body as Record<
    string,
    unknown
  >;
  if (typeof google !== "boolean" || typeof emailPassword !== "boolean") {
    return null;
  }
  return {
    emailPassword,
    google,
    turnstileSiteKey:
      typeof turnstileSiteKey === "string" && turnstileSiteKey.length > 0
        ? turnstileSiteKey
        : null,
  };
}

/**
 * Which sign-in methods are on. `null` means "could not tell" (network, 5xx, an odd answer): the
 * screen then keeps the Google button, which fails by itself with its own text if Google is off.
 */
export async function loadAuthMethods(
  fetcher: Fetcher = fetch
): Promise<AuthMethodsView | null> {
  try {
    const response = await fetcher("/api/auth-methods", {
      cache: "no-store",
      credentials: "same-origin",
    });
    return response.ok ? parseAuthMethods(await response.json()) : null;
  } catch {
    return null;
  }
}

/** Whether the browser already has a session (a return from Google, or someone who is already in). */
export async function hasSession(fetcher: Fetcher = fetch): Promise<boolean> {
  try {
    const response = await fetcher("/api/auth/get-session", {
      cache: "no-store",
      credentials: "same-origin",
    });
    if (!response.ok) {
      return false;
    }
    const body: unknown = await response.json();
    return (
      typeof body === "object" &&
      body !== null &&
      "session" in body &&
      (body as { session: unknown }).session !== null &&
      typeof (body as { session: unknown }).session === "object"
    );
  } catch {
    return false;
  }
}

/** The address Better Auth says to go to: Google's, over https, and nothing else. */
export function googleAuthorizationUrl(body: unknown): string | null {
  if (typeof body !== "object" || body === null) {
    return null;
  }
  const { url } = body as { url?: unknown };
  if (typeof url !== "string") {
    return null;
  }
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" &&
      parsed.hostname === GOOGLE_AUTHORIZATION_HOST
      ? parsed.toString()
      : null;
  } catch {
    return null;
  }
}

export type GoogleStart =
  | { failure: SignInFailure; status: "failed" }
  | { status: "redirect"; url: string };

/**
 * `POST /api/auth/sign-in/social` (AC-2). 429 is "too many tries"; every other refusal, a network
 * failure and a useless answer are "unavailable". Nothing is retried and nothing is stored.
 */
export async function startGoogleSignIn(
  returnTo: string | undefined,
  fetcher: Fetcher = fetch
): Promise<GoogleStart> {
  let response: Response;
  try {
    response = await fetcher("/api/auth/sign-in/social", {
      body: JSON.stringify(buildSocialSignInRequest(returnTo)),
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      method: "POST",
    });
  } catch {
    return { failure: "indisponivel", status: "failed" };
  }
  if (response.status === 429) {
    return { failure: "limite", status: "failed" };
  }
  if (!response.ok) {
    return { failure: "indisponivel", status: "failed" };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { failure: "indisponivel", status: "failed" };
  }
  const url = googleAuthorizationUrl(body);
  return url
    ? { status: "redirect", url }
    : { failure: "indisponivel", status: "failed" };
}
