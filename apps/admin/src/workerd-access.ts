import { env } from "cloudflare:workers";

/**
 * The simulated Cloudflare Access of the Workers tests (`*.workerd.test.ts`, `*.workerd-db.test.ts`): signs
 * the token a person would carry. It reads the test key from `env.TEST_ACCESS_PRIVATE_JWK`, which only the
 * Vitest configs of the Workers harness set; the Worker never imports this file, and a test checks that no
 * wrangler file, workflow or Worker source mentions the key (access-mock-confinement.test.ts).
 */

const ENCODER = new TextEncoder();
const NOW_SECONDS = () => Math.floor(Date.now() / 1000);

function base64Url(bytes: Uint8Array | string): string {
  const raw =
    typeof bytes === "string"
      ? bytes
      : String.fromCharCode(...new Uint8Array(bytes));
  return btoa(raw)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

export interface TokenOptions {
  audience?: string;
  expiresInSeconds?: number;
  issuer?: string;
  keyId?: string;
  /** Another private key (JWK) than the team's: a token the team did not sign. */
  privateJwk?: JsonWebKey;
  /** The Access subject; the principal is found by it and the issuer (ADR 0070). */
  subject?: string;
}

/** A person's Access token, signed with the test key; `options` bend one claim at a time. */
export async function signAccessToken(
  options: TokenOptions = {}
): Promise<string> {
  const header = { alg: "RS256", kid: options.keyId ?? env.TEST_ACCESS_KEY_ID };
  const now = NOW_SECONDS();
  const payload = {
    aud: [options.audience ?? env.ACCESS_AUDIENCE],
    email: "operator@example.com",
    exp: now + (options.expiresInSeconds ?? 300),
    iat: now,
    iss: options.issuer ?? `https://${env.ACCESS_TEAM_DOMAIN}`,
    sub: options.subject ?? "operator-subject-1",
    type: "app",
  };
  const signingInput = `${base64Url(JSON.stringify(header))}.${base64Url(
    JSON.stringify(payload)
  )}`;
  const key = await crypto.subtle.importKey(
    "jwk",
    {
      ...(options.privateJwk ?? JSON.parse(env.TEST_ACCESS_PRIVATE_JWK)),
      alg: "RS256",
      ext: true,
    },
    { hash: "SHA-256", name: "RSASSA-PKCS1-v1_5" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    ENCODER.encode(signingInput)
  );
  return `${signingInput}.${base64Url(new Uint8Array(signature))}`;
}
