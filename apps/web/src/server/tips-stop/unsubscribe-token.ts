/**
 * The token of the link that stops the tips e-mails (ADR 0106, D8): `<user>.<mac>`, the internal ID of the person in
 * base64url and an HMAC-SHA-256 over that ID and the purpose of the token. Nothing else: no address, no name and no
 * instant. The e-mail is read days later and a one-click stop (RFC 8058) has to work then; a leaked token only takes
 * that one person out of the tips, so only the rotation of the secret (`*_PREVIOUS_SECRET`) ends it.
 *
 * The secret is its own, never the session's (`BETTER_AUTH_SECRET`) nor the one of the suppression; the purpose sits in
 * the signed text too, so a token of another purpose signed with the same bytes is refused all the same.
 */

/** The purpose bound into every MAC: another purpose (the suppression, say) signs another text. */
export const UNSUBSCRIBE_TOKEN_PURPOSE = "polaris/email-tips-stop/v1";

/** The query parameter of the link that carries the token. */
export const UNSUBSCRIBE_TOKEN_PARAMETER = "t";

/** The path of the page and of the one-click POST (`List-Unsubscribe` and `List-Unsubscribe-Post`). */
export const TIPS_STOP_PATH = "/api/parar-dicas";

const MIN_SECRET_LENGTH = 32;
const MAC_BYTES = 32;
/** The IDs of the people (Better Auth): letters, digits, `_` and `-`; a longer or other text is not one. */
const USER_ID = /^[A-Za-z0-9_-]{1,128}$/;
const TRAILING_PADDING = /[=]+$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const encoder = new TextEncoder();

export interface UnsubscribeSecrets {
  current: string;
  /** The secret of the rotation before: a token signed with it still opens until it is removed. */
  previous?: string | undefined;
}

export interface UnsubscribeSecretBindings {
  BETTER_AUTH_SECRET?: string | undefined;
  UNSUBSCRIBE_TOKEN_PREVIOUS_SECRET?: string | undefined;
  UNSUBSCRIBE_TOKEN_SECRET?: string | undefined;
}

function usableSecret(
  secret: string | undefined,
  forbidden: string | undefined
): string | undefined {
  if (!secret || secret.length < MIN_SECRET_LENGTH || secret === forbidden) {
    return undefined;
  }
  return secret;
}

/**
 * The secrets of the token, or undefined while the current one is missing, short or the same as the session's: the
 * route then fails closed and nobody gets a token. A previous secret that is not usable is ignored.
 */
export function unsubscribeSecretsOf(
  bindings: UnsubscribeSecretBindings | undefined
): UnsubscribeSecrets | undefined {
  const session = bindings?.BETTER_AUTH_SECRET;
  const current = usableSecret(bindings?.UNSUBSCRIBE_TOKEN_SECRET, session);
  if (current === undefined) {
    return undefined;
  }
  const previous = usableSecret(
    bindings?.UNSUBSCRIBE_TOKEN_PREVIOUS_SECRET,
    session
  );
  return previous === undefined || previous === current
    ? { current }
    : { current, previous };
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(TRAILING_PADDING, "");
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> | undefined {
  if (!BASE64URL.test(text) || text.length % 4 === 1) {
    return undefined;
  }
  const padded = text.replaceAll("-", "+").replaceAll("_", "/");
  try {
    const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return undefined;
  }
}

async function macKey(secret: string, usage: "sign" | "verify") {
  return await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    [usage]
  );
}

function signedText(userId: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(`${UNSUBSCRIBE_TOKEN_PURPOSE}\u0000${userId}`);
}

/** The token of one person, always signed with the current secret; the same person gets the same token every time. */
export async function createUnsubscribeToken(
  secrets: UnsubscribeSecrets,
  userId: string
): Promise<string> {
  if (!USER_ID.test(userId)) {
    throw new Error("unsubscribe token: not an ID of a person");
  }
  const mac = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      await macKey(secrets.current, "sign"),
      signedText(userId)
    )
  );
  return `${toBase64Url(encoder.encode(userId))}.${toBase64Url(mac)}`;
}

/**
 * The person of a token whose MAC is right under the current or the previous secret, or undefined for any other text
 * (tampered, of another purpose, signed with another secret, malformed). The comparison is the one of
 * `crypto.subtle.verify`, which does not stop at the first different byte.
 */
export async function verifyUnsubscribeToken(
  secrets: UnsubscribeSecrets,
  token: string | undefined
): Promise<string | undefined> {
  const parts = token?.split(".");
  if (parts?.length !== 2) {
    return undefined;
  }
  const [encodedUser = "", encodedMac = ""] = parts;
  const userBytes = fromBase64Url(encodedUser);
  const mac = fromBase64Url(encodedMac);
  if (userBytes === undefined || mac?.length !== MAC_BYTES) {
    return undefined;
  }
  const userId = new TextDecoder("utf-8", { fatal: false }).decode(userBytes);
  // both parts in their one canonical encoding (the last character of a MAC has spare bits that `atob` ignores), so
  // one person has one token per secret and the text of a token can be compared as it is
  if (
    !USER_ID.test(userId) ||
    toBase64Url(userBytes) !== encodedUser ||
    toBase64Url(mac) !== encodedMac
  ) {
    return undefined;
  }
  const text = signedText(userId);
  const matches = await Promise.all(
    [secrets.current, secrets.previous].map(async (secret) =>
      secret === undefined
        ? false
        : await crypto.subtle.verify(
            "HMAC",
            await macKey(secret, "verify"),
            mac,
            text
          )
    )
  );
  if (matches.includes(true)) {
    return userId;
  }
  return undefined;
}

/**
 * The link of the footer and of `List-Unsubscribe` for a token already made: the origin of the app, the path of the
 * page and the token as the one parameter. Pure: the consumer of the e-mails makes the token and calls this.
 */
export function unsubscribeLink(baseURL: string, token: string): string {
  const url = new URL(TIPS_STOP_PATH, new URL(baseURL).origin);
  url.searchParams.set(UNSUBSCRIBE_TOKEN_PARAMETER, token);
  return url.toString();
}
