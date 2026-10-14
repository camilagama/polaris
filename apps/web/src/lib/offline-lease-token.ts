import {
  assertOfflineLeaseCurrent,
  InvalidOfflineLeaseError,
  OFFLINE_LEASE_VERSION,
  type OfflineLeaseClaims,
  parseOfflineLeaseClaims,
  serializeOfflineLeaseClaims,
} from "@polaris/domain/offline/offline-lease";

/**
 * The signed form of an offline lease: `v1.<keyId>.<payload>.<signature>`,
 * where payload is the base64url JSON claims and the signature is HMAC-SHA256
 * over everything before the last dot. The server signs and verifies (it is the
 * only holder of the secret); the client can read the claims to show when the
 * lease ends and to stop offline mutations, but cannot forge or extend them.
 */
const OFFLINE_LEASE_MIN_SECRET_BYTES = 32;
const MAX_TOKEN_LENGTH = 4096;

export interface OfflineLeaseKey {
  id: string;
  secret: string;
}

export class InvalidOfflineLeaseKeyError extends Error {
  constructor() {
    super("invalid_offline_lease_key");
    this.name = "InvalidOfflineLeaseKeyError";
  }
}

const keyIdPattern = /^[A-Za-z0-9_-]{1,32}$/;
const base64UrlPattern = /^[A-Za-z0-9_-]*$/;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  if (!base64UrlPattern.test(text) || text.length % 4 === 1) {
    throw new InvalidOfflineLeaseError("malformed");
  }
  const padded = text.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function importKey(
  key: OfflineLeaseKey,
  usage: "sign" | "verify"
): Promise<CryptoKey> {
  const secret = encoder.encode(key.secret);
  if (
    !keyIdPattern.test(key.id) ||
    secret.length < OFFLINE_LEASE_MIN_SECRET_BYTES
  ) {
    throw new InvalidOfflineLeaseKeyError();
  }
  return await crypto.subtle.importKey(
    "raw",
    secret,
    { hash: "SHA-256", name: "HMAC" },
    false,
    [usage]
  );
}

export async function signOfflineLease(
  claims: OfflineLeaseClaims,
  key: OfflineLeaseKey
): Promise<string> {
  const payload = toBase64Url(
    encoder.encode(serializeOfflineLeaseClaims(claims))
  );
  const signingKey = await importKey(key, "sign");
  const head = `v${OFFLINE_LEASE_VERSION}.${key.id}.${payload}`;
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", signingKey, encoder.encode(head))
  );
  return `${head}.${toBase64Url(signature)}`;
}

function splitToken(token: string): {
  head: string;
  keyId: string;
  payload: string;
  signature: string;
} {
  const parts = token.split(".");
  const [version, keyId, payload, signature] = parts;
  if (
    parts.length !== 4 ||
    version === undefined ||
    keyId === undefined ||
    payload === undefined ||
    signature === undefined ||
    token.length > MAX_TOKEN_LENGTH
  ) {
    throw new InvalidOfflineLeaseError("malformed");
  }
  if (version !== `v${OFFLINE_LEASE_VERSION}`) {
    throw new InvalidOfflineLeaseError("unsupported_version");
  }
  return { head: `${version}.${keyId}.${payload}`, keyId, payload, signature };
}

function decodeClaims(payload: string): OfflineLeaseClaims {
  let json: string;
  try {
    json = decoder.decode(fromBase64Url(payload));
  } catch (error) {
    if (error instanceof InvalidOfflineLeaseError) {
      throw error;
    }
    throw new InvalidOfflineLeaseError("malformed", { cause: error });
  }
  return parseOfflineLeaseClaims(json);
}

/**
 * Verifies the signature (constant time, through Web Crypto), the shape of the
 * claims and the validity window. Any of the given keys may have signed the
 * token, which allows rotating the secret without dropping live leases.
 */
export async function verifyOfflineLease(
  token: string,
  keys: readonly OfflineLeaseKey[],
  now: Date,
  options: { checkWindow?: boolean } = {}
): Promise<OfflineLeaseClaims> {
  const { head, keyId, payload, signature } = splitToken(token);
  const key = keys.find((candidate) => candidate.id === keyId);
  if (!key) {
    throw new InvalidOfflineLeaseError("unknown_key");
  }
  const claims = decodeClaims(payload);
  const verified = await crypto.subtle.verify(
    "HMAC",
    await importKey(key, "verify"),
    fromBase64Url(signature),
    encoder.encode(head)
  );
  if (!verified) {
    throw new InvalidOfflineLeaseError("bad_signature");
  }
  // sync.push passes checkWindow: false: a command made while the lease was
  // valid may arrive after it expired (the server checks the creation time).
  if (options.checkWindow !== false) {
    assertOfflineLeaseCurrent(claims, now);
  }
  return claims;
}

/**
 * Reads the claims WITHOUT verifying anything. For the client only: to show when
 * the lease ends and to stop offline mutations after expiry. The server never
 * trusts the result; it verifies the token instead.
 */
export function readUnverifiedOfflineLease(
  token: string
): OfflineLeaseClaims | null {
  try {
    return decodeClaims(splitToken(token).payload);
  } catch {
    return null;
  }
}
