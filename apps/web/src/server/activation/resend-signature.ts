/**
 * The signature of Resend's webhook (Svix scheme), checked by hand with WebCrypto: no dependency enters the Worker's
 * precache. The signed text is `<svix-id>.<svix-timestamp>.<raw body>`; the secret is `whsec_` followed by the base64
 * of the key; `svix-signature` is a space-separated list of `v1,<base64 HMAC-SHA-256>` (more than one while a secret is
 * being rotated).
 */

/** How far the delivery's timestamp may be from the Worker's clock, in either direction. */
export const SVIX_TOLERANCE_SECONDS = 300;

const MIN_KEY_BYTES = 24;
const MAX_SIGNATURES_READ = 5;
/** Ten digits cover every second until the year 2286; more is not a timestamp and is refused before it is a number. */
const MAX_TIMESTAMP_DIGITS = 10;
const SVIX_ID = /^[A-Za-z0-9_-]{8,100}$/;
const DIGITS = /^[0-9]+$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const SECRET_PREFIX = "whsec_";

const encoder = new TextEncoder();

export interface SvixHeaders {
  id: string | null | undefined;
  signature: string | null | undefined;
  timestamp: string | null | undefined;
}

function base64Bytes(text: string): Uint8Array<ArrayBuffer> | null {
  if (text.length % 4 !== 0 || !BASE64.test(text)) {
    return null;
  }
  try {
    return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

/** The key bytes of a `whsec_` secret, or null when it is not one (the endpoint answers 503, not 401). */
export function svixKeyOf(
  secret: string | undefined
): Uint8Array<ArrayBuffer> | null {
  if (!secret?.startsWith(SECRET_PREFIX)) {
    return null;
  }
  const bytes = base64Bytes(secret.slice(SECRET_PREFIX.length));
  return bytes && bytes.byteLength >= MIN_KEY_BYTES ? bytes : null;
}

/**
 * Whether the delivery is the provider's: the three headers well formed, the timestamp inside the window of `nowMs`
 * and one `v1` signature that matches the key over the exact bytes of the body. `crypto.subtle.verify` compares in
 * constant time. Never throws: any failure is false.
 */
export async function verifySvixSignature(input: {
  body: string;
  headers: SvixHeaders;
  key: Uint8Array<ArrayBuffer>;
  nowMs: number;
}): Promise<boolean> {
  const { id, signature, timestamp } = input.headers;
  if (
    !(id && signature && timestamp && SVIX_ID.test(id)) ||
    timestamp.length > MAX_TIMESTAMP_DIGITS ||
    !DIGITS.test(timestamp)
  ) {
    return false;
  }
  if (
    Math.abs(input.nowMs / 1000 - Number(timestamp)) > SVIX_TOLERANCE_SECONDS
  ) {
    return false;
  }
  const candidates = signature
    .split(" ")
    .slice(0, MAX_SIGNATURES_READ)
    .flatMap((entry) => {
      const [version, value, ...rest] = entry.split(",");
      if (version !== "v1" || value === undefined || rest.length > 0) {
        return [];
      }
      const bytes = base64Bytes(value);
      return bytes ? [bytes] : [];
    });
  if (candidates.length === 0) {
    return false;
  }
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      input.key,
      { hash: "SHA-256", name: "HMAC" },
      false,
      ["verify"]
    );
    const signed = encoder.encode(`${id}.${timestamp}.${input.body}`);
    const results = await Promise.all(
      candidates.map((candidate) =>
        crypto.subtle.verify("HMAC", key, candidate, signed)
      )
    );
    return results.some(Boolean);
  } catch {
    return false;
  }
}
