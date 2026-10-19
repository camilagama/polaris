import { isSafeAuthCallbackPath, parseReturnPath } from "./return-path";

/** Why the sign-in screen is opened: the login is only old, or the session is already gone. */
export type SignInReason = "recente" | "sessao";
/** What went wrong on the way back from Google; each one has its own line on the screen. */
export type SignInError = "google" | "indisponivel" | "limite";

const SIGN_IN_PATH = "/entrar";
const reasons: readonly string[] = [
  "recente",
  "sessao",
] satisfies SignInReason[];
const errors: readonly string[] = [
  "google",
  "indisponivel",
  "limite",
] satisfies SignInError[];

/** `encodeURIComponent` leaves `! ' ( ) * ~` alone; Better Auth 1.6.23 does not accept them in a callback. */
function encodeAll(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*~]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

/** For the address bar: a slash needs no escape in a query value, and it keeps `voltar=/devices` readable. */
function encodeForAddress(value: string): string {
  return encodeURIComponent(value).replace(/%2F/gi, "/");
}

export type SignInPath = `/entrar?${string}`;

/**
 * The sign-in screen with a reason and the place to come back to. `returnTo` goes through the same
 * validation as the screen applies when it reads `voltar`; a destination that does not pass is left out.
 */
export function signInPath(options: {
  reason: SignInReason;
  returnTo?: string | undefined;
}): SignInPath {
  const destination = parseReturnPath(options.returnTo);
  return destination
    ? `${SIGN_IN_PATH}?motivo=${options.reason}&voltar=${encodeForAddress(destination)}`
    : `${SIGN_IN_PATH}?motivo=${options.reason}`;
}

/** Where "Sair" goes once the session ended: the sign-in screen with a valid destination, otherwise the start. */
export function logoutDestination(options: {
  reason: SignInReason;
  returnTo?: string | undefined;
}): "/" | SignInPath {
  return parseReturnPath(options.returnTo) ? signInPath(options) : "/";
}

/** The page the person is on, as a destination to return to (never the sign-in screen itself). */
export function currentReturnPath(location: {
  pathname: string;
  search: string;
}): string | undefined {
  return parseReturnPath(`${location.pathname}${location.search}`);
}

export interface SocialSignInRequest {
  callbackURL: string;
  errorCallbackURL: string;
  provider: "google";
}

/**
 * The body of `POST /api/auth/sign-in/social` (ADR 0100). The destination travels inside `voltar`,
 * fully encoded, because the callback of Better Auth 1.6.23 takes only `[\w-.+/=&%@]`. A destination
 * that does not fit goes to the start. The client never sends an `idToken`.
 */
export function buildSocialSignInRequest(
  returnTo?: string | undefined
): SocialSignInRequest {
  const destination = parseReturnPath(returnTo);
  const callbackURL = destination
    ? `${SIGN_IN_PATH}?voltar=${encodeAll(destination)}`
    : SIGN_IN_PATH;
  return {
    callbackURL: isSafeAuthCallbackPath(callbackURL)
      ? callbackURL
      : SIGN_IN_PATH,
    errorCallbackURL: `${SIGN_IN_PATH}?erro=google`,
    provider: "google",
  };
}

export interface SignInSearch {
  /** Only `google`, `indisponivel` and `limite`; anything else is dropped, never shown. */
  error?: SignInError;
  reason?: SignInReason;
  /** A valid destination, or undefined (then the person goes to the start). */
  returnTo?: string;
}

/** Reads `?voltar=`, `?motivo=` and `?erro=`. Unknown values are ignored and never reflected in the page. */
export function parseSignInSearch(search: string): SignInSearch {
  const params = new URLSearchParams(search);
  const reason = params.get("motivo");
  const error = params.get("erro");
  const returnTo = parseReturnPath(params.get("voltar"));
  return {
    ...(error && errors.includes(error) ? { error: error as SignInError } : {}),
    ...(reason && reasons.includes(reason)
      ? { reason: reason as SignInReason }
      : {}),
    ...(returnTo ? { returnTo } : {}),
  };
}
