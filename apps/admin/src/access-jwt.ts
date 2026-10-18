/**
 * Cloudflare Access login for the Admin app (plan PR92, ADR 0070). Access puts a
 * signed token in a request header; the Worker verifies the signature against
 * the team's published keys and checks the issuer, the audience, the validity
 * window and the subject itself. A header that merely says who someone is
 * (such as the e-mail header) is never trusted.
 */

export interface AccessJwtConfig {
  /** The application audience tag of the Access application protecting the Admin. */
  audience: string;
  /** https://<team>.cloudflareaccess.com */
  issuer: string;
}

export interface AccessKey {
  alg?: string;
  e: string;
  kid: string;
  kty: string;
  n: string;
  use?: string;
}

export interface AccessClaims {
  /** Display only; the subject is the identity. */
  email: string | null;
  expiresAt: number;
  issuedAt: number;
  /** The issuer the token was verified against (the identity is this issuer plus the subject). */
  issuer: string;
  subject: string;
}

export type AccessJwtFailure =
  | "bad_claims"
  | "bad_signature"
  | "expired"
  | "malformed"
  | "not_yet_valid"
  | "unknown_key"
  | "unsupported_algorithm"
  | "wrong_audience"
  | "wrong_issuer"
  | "wrong_token_type";

export class AccessJwtError extends Error {
  readonly code: AccessJwtFailure;

  constructor(code: AccessJwtFailure, options?: ErrorOptions) {
    super(code, options);
    this.name = "AccessJwtError";
    this.code = code;
  }
}

const MAX_TOKEN_LENGTH = 8192;
const MAX_SUBJECT_LENGTH = 512;
/** Clock skew accepted between Access and this Worker. */
const LEEWAY_SECONDS = 30;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const TEAM_DOMAIN = /^[a-z0-9][a-z0-9-]{0,62}\.cloudflareaccess\.com$/;

function decodeBase64Url(segment: string): Uint8Array {
  if (!BASE64URL.test(segment)) {
    throw new AccessJwtError("malformed");
  }
  const padded = segment
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(segment.length / 4) * 4, "=");
  try {
    return Uint8Array.from(atob(padded), (character) =>
      character.charCodeAt(0)
    );
  } catch (cause: unknown) {
    throw new AccessJwtError("malformed", { cause });
  }
}

function decodeJson(segment: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(decodeBase64Url(segment))
    );
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new AccessJwtError("malformed");
    }
    return value as Record<string, unknown>;
  } catch (error: unknown) {
    if (error instanceof AccessJwtError) {
      throw error;
    }
    throw new AccessJwtError("malformed", { cause: error });
  }
}

function numberClaim(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** The issuer for an Access team domain, or null when it is not one (a misconfigured Worker must not guess). */
export function accessIssuer(teamDomain: string): string | null {
  return TEAM_DOMAIN.test(teamDomain) ? `https://${teamDomain}` : null;
}

async function verifySignature(
  key: AccessKey,
  signingInput: string,
  signature: Uint8Array
): Promise<boolean> {
  const publicKey = await crypto.subtle.importKey(
    "jwk",
    { alg: "RS256", e: key.e, ext: true, kty: "RSA", n: key.n },
    { hash: "SHA-256", name: "RSASSA-PKCS1-v1_5" },
    false,
    ["verify"]
  );
  return await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    publicKey,
    signature as BufferSource,
    new TextEncoder().encode(signingInput)
  );
}

function checkAudience(aud: unknown, audience: string): void {
  const audiences = Array.isArray(aud) ? aud : [aud];
  if (!audiences.some((candidate) => candidate === audience)) {
    throw new AccessJwtError("wrong_audience");
  }
}

function checkWindow(
  payload: Record<string, unknown>,
  now: Date
): [number, number] {
  const seconds = Math.floor(now.getTime() / 1000);
  const exp = numberClaim(payload.exp);
  const iat = numberClaim(payload.iat);
  const nbf = payload.nbf === undefined ? null : numberClaim(payload.nbf);
  if (
    exp === null ||
    iat === null ||
    (payload.nbf !== undefined && nbf === null)
  ) {
    throw new AccessJwtError("bad_claims");
  }
  if (exp + LEEWAY_SECONDS <= seconds) {
    throw new AccessJwtError("expired");
  }
  if (
    iat - LEEWAY_SECONDS > seconds ||
    (nbf !== null && nbf - LEEWAY_SECONDS > seconds)
  ) {
    throw new AccessJwtError("not_yet_valid");
  }
  return [iat, exp];
}

/**
 * Verifies an Access token and returns who it names. Only RS256 is accepted (never
 * "none" or a shared-secret algorithm), the key must be one Access published, and
 * only a person's application token counts (a service token, which carries a common name, is not an operator).
 */
export async function verifyAccessJwt(
  token: string,
  config: AccessJwtConfig,
  keys: readonly AccessKey[],
  now: Date
): Promise<AccessClaims> {
  if (token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
    throw new AccessJwtError("malformed");
  }
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new AccessJwtError("malformed");
  }
  const [headerSegment = "", payloadSegment = "", signatureSegment = ""] =
    parts;
  const header = decodeJson(headerSegment);
  if (header.alg !== "RS256") {
    throw new AccessJwtError("unsupported_algorithm");
  }
  const key =
    typeof header.kid === "string"
      ? keys.find(
          (candidate) => candidate.kid === header.kid && candidate.kty === "RSA"
        )
      : undefined;
  if (!key) {
    throw new AccessJwtError("unknown_key");
  }
  const validSignature = await verifySignature(
    key,
    `${headerSegment}.${payloadSegment}`,
    decodeBase64Url(signatureSegment)
  ).catch(() => false);
  if (!validSignature) {
    throw new AccessJwtError("bad_signature");
  }

  const payload = decodeJson(payloadSegment);
  if (payload.iss !== config.issuer) {
    throw new AccessJwtError("wrong_issuer");
  }
  checkAudience(payload.aud, config.audience);
  const [issuedAt, expiresAt] = checkWindow(payload, now);
  // a person's application token; a service token carries a common name instead of a person
  if (payload.type !== "app" || payload.common_name !== undefined) {
    throw new AccessJwtError("wrong_token_type");
  }
  const { sub, email } = payload;
  if (
    typeof sub !== "string" ||
    sub === "" ||
    sub.length > MAX_SUBJECT_LENGTH
  ) {
    throw new AccessJwtError("bad_claims");
  }
  return {
    email: typeof email === "string" ? email : null,
    expiresAt,
    issuedAt,
    issuer: config.issuer,
    subject: sub,
  };
}

export interface AccessKeyStore {
  /** The keys, refreshed when stale or when the requested key ID is not among them. */
  keys: (kid?: string) => Promise<readonly AccessKey[]>;
}

const KEYS_TTL_MS = 5 * 60 * 1000;
/** Keys kept past their time to live are still served when a renewal fails, but not forever. */
const MAX_STALE_MS = 60 * 60 * 1000;
/** A token naming an unknown key triggers a refresh, never more often than this. */
const MIN_REFETCH_MS = 60 * 1000;
/** After a failed renewal, the next one waits this long (the cached keys are served meanwhile). */
const RETRY_AFTER_FAILURE_MS = 10 * 1000;

export function createAccessKeyStore(input: {
  fetchKeys: (url: string) => Promise<unknown>;
  now?: () => number;
  teamDomain: string;
}): AccessKeyStore {
  const clock = input.now ?? Date.now;
  let cached: readonly AccessKey[] = [];
  let fetchedAt = Number.NEGATIVE_INFINITY;
  let attemptedAt = Number.NEGATIVE_INFINITY;
  let inflight: Promise<void> | null = null;

  async function download(): Promise<void> {
    const body = (await input.fetchKeys(
      `https://${input.teamDomain}/cdn-cgi/access/certs`
    )) as { keys?: unknown } | null;
    const keys = Array.isArray(body?.keys)
      ? (body.keys as AccessKey[]).filter(
          (key) =>
            typeof key?.kid === "string" &&
            key.kty === "RSA" &&
            typeof key.n === "string" &&
            typeof key.e === "string"
        )
      : [];
    if (keys.length === 0) {
      throw new Error("access_keys_unavailable");
    }
    cached = keys;
    fetchedAt = clock();
  }

  /** One download at a time: a burst of requests shares it instead of each starting its own. */
  function refresh(): Promise<void> {
    attemptedAt = clock();
    inflight ??= download().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  return {
    async keys(kid) {
      const age = clock() - fetchedAt;
      const sinceAttempt = clock() - attemptedAt;
      if (cached.length === 0) {
        await refresh();
        return cached;
      }
      const stale = age > KEYS_TTL_MS && sinceAttempt > RETRY_AFTER_FAILURE_MS;
      const unknown =
        kid !== undefined &&
        !cached.some((key) => key.kid === kid) &&
        sinceAttempt > MIN_REFETCH_MS;
      if (stale || unknown) {
        try {
          await refresh();
        } catch (error: unknown) {
          // the last keys Access published are still the best known, for a while
          if (age > MAX_STALE_MS) {
            throw error;
          }
        }
      }
      return cached;
    },
  };
}

/** Reads the unverified key ID only to decide whether the key list needs refreshing; the token is still fully verified afterwards. */
export function unverifiedKeyId(token: string): string | undefined {
  try {
    const header = decodeJson(token.split(".")[0] ?? "");
    return typeof header.kid === "string" ? header.kid : undefined;
  } catch {
    return undefined;
  }
}
