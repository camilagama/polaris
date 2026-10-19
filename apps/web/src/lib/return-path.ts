const MAX_RETURN_PATH_LENGTH = 200;
// The `callbackURL` carries the destination totally encoded (three characters for each ASCII one, six for an accented one) inside `voltar`.
const MAX_CALLBACK_LENGTH = 800;
const PLACEHOLDER_ORIGIN = "http://polaris.invalid";
const MAX_DECODE_ROUNDS = 3;
const sensitivePrefixes = ["/api", "/rpc"];
const SIGN_IN_PATH = "/entrar";
// The characters Better Auth 1.6.23 accepts in a relative callback: a plain path and a query without
// `( ) ! ~ * '`, which `encodeURIComponent` leaves alone. The app enforces it itself so that a hostile
// value gets the same 403 whatever the library does with it.
const callbackPathPattern =
  /^\/(?!\/|\\|%2f|%5c)[\w\-.+/@]*(?:\?[\w\-.+/=&%@]*)?$/i;

const LINE_SEPARATOR = 0x20_28;
const PARAGRAPH_SEPARATOR = 0x20_29;

/** C0 and C1 controls, DEL, and the Unicode line and paragraph separators. */
function hasControlCharacter(text: string): boolean {
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (
      code <= 0x1f ||
      (code >= 0x7f && code <= 0x9f) ||
      code === LINE_SEPARATOR ||
      code === PARAGRAPH_SEPARATOR
    ) {
      return true;
    }
  }
  return false;
}

/** A `.` or `..` segment in the path part (before `?`) of a decoded value. */
function hasDotSegment(decoded: string): boolean {
  const path = decoded.split("?")[0] ?? "";
  return path.split("/").some((segment) => segment === "." || segment === "..");
}

function startsWithSegment(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function fullyDecoded(value: string): string | undefined {
  let current = value;
  for (let round = 0; round < MAX_DECODE_ROUNDS; round += 1) {
    let next: string;
    try {
      next = decodeURIComponent(current);
    } catch {
      return undefined;
    }
    if (next === current) {
      return current;
    }
    current = next;
  }
  // Still changing after the allowed rounds: refuse instead of guessing.
  return undefined;
}

/** The path of a candidate that belongs to this app and nothing else, or undefined. */
function appPathname(
  value: unknown,
  maxLength: number
): { pathname: string; url: URL } | undefined {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength
  ) {
    return undefined;
  }

  // The checks run on the decoded text, so `%2F%2Fevil` and `%0d%0a` are seen as what they become.
  const decoded = fullyDecoded(value);
  if (
    decoded === undefined ||
    hasControlCharacter(decoded) ||
    !decoded.startsWith("/") ||
    decoded.startsWith("//") ||
    decoded.includes("\\") ||
    hasDotSegment(decoded)
  ) {
    return undefined;
  }

  let url: URL;
  try {
    url = new URL(value, PLACEHOLDER_ORIGIN);
  } catch {
    return undefined;
  }
  // A path with dot segments is refused before and after the URL parser: it resolves `/x/../api` and
  // `/.//evil` into another path, and `..%2f` only becomes a dot segment once decoded.
  const pathname = fullyDecoded(url.pathname);
  if (
    url.origin !== PLACEHOLDER_ORIGIN ||
    pathname === undefined ||
    pathname.startsWith("//") ||
    hasDotSegment(pathname) ||
    sensitivePrefixes.some((prefix) =>
      startsWithSegment(pathname.toLowerCase(), prefix)
    )
  ) {
    return undefined;
  }

  return { pathname: pathname.toLowerCase(), url };
}

/**
 * A destination to go back to after sign-in (`voltar`): a path of this app, never the sign-in page
 * itself, `/api`, `/rpc`, another host, a scheme or anything with control characters (ADR 0017).
 */
export function parseReturnPath(value: unknown): string | undefined {
  const path = appPathname(value, MAX_RETURN_PATH_LENGTH);
  if (!path || startsWithSegment(path.pathname, SIGN_IN_PATH)) {
    return undefined;
  }
  return value as string;
}

/**
 * Whether a `callbackURL` or `errorCallbackURL` sent to the auth server is a path of this app. The
 * sign-in page is allowed as the target (it carries the destination in `voltar`), but then that
 * destination has to be a valid return path.
 */
export function isSafeAuthCallbackPath(value: unknown): boolean {
  const path = appPathname(value, MAX_CALLBACK_LENGTH);
  if (!(path && callbackPathPattern.test(value as string))) {
    return false;
  }
  if (!startsWithSegment(path.pathname, SIGN_IN_PATH)) {
    return true;
  }

  const destinations = path.url.searchParams.getAll("voltar");
  return destinations.every((destination) => parseReturnPath(destination));
}
