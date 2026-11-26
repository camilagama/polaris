import type { WorkerBindings } from "../environment";

const SUPPRESSION_HMAC_PREFIX = "activation-suppression:v1:";
const SUPPRESSION_KEY_ID_TEXT = "activation-suppression-key-id:v1";
const KEY_ID_BYTES = 4;
export const MIN_SECRET_LENGTH = 32;

export interface ActivationSuppressionSecrets {
  current: string;
  previous?: string | undefined;
}

/** The other secrets of the Worker the suppression's must never equal: one list, every secret binding of the Worker. */
export const OTHER_SECRETS = [
  "ASAAS_API_KEY",
  "ASAAS_WEBHOOK_TOKEN",
  "ASAAS_WEBHOOK_TOKEN_NEXT",
  "AUTH_PASSWORD_PEPPER",
  "BETTER_AUTH_SECRET",
  "BILLING_PAYER_KEY",
  "GOOGLE_CLIENT_SECRET",
  "OFFLINE_LEASE_PREVIOUS_SECRET",
  "OFFLINE_LEASE_SECRET",
  "RESEND_API_KEY",
  "RESEND_WEBHOOK_SECRET",
  "SYNC_PAYLOAD_HASH_PREVIOUS_SECRET",
  "SYNC_PAYLOAD_HASH_SECRET",
  "TURNSTILE_SECRET_KEY",
  "UNSUBSCRIBE_TOKEN_PREVIOUS_SECRET",
  "UNSUBSCRIBE_TOKEN_SECRET",
  "WOOVI_APP_ID",
] as const;

export type SecretBindings = Pick<
  WorkerBindings,
  | "ACTIVATION_SUPPRESSION_HMAC_SECRET"
  | "ACTIVATION_SUPPRESSION_HMAC_SECRET_PREVIOUS"
  | (typeof OTHER_SECRETS)[number]
>;

/**
 * The secrets of the suppression's HMAC, or undefined when the current one is missing, shorter than 32 characters or
 * equal to another secret of the Worker, or when a previous one is set and is not usable: a suppression under a key
 * the Worker cannot use would go unseen, so the tips fail closed instead.
 */
export function activationSuppressionSecretsOf(
  bindings: SecretBindings
): ActivationSuppressionSecrets | undefined {
  const others = new Set(
    OTHER_SECRETS.map((name) => bindings[name]).filter(
      (value): value is string => typeof value === "string" && value !== ""
    )
  );
  const usable = (secret: string | undefined) =>
    secret !== undefined &&
    secret.length >= MIN_SECRET_LENGTH &&
    !others.has(secret);
  const current = bindings.ACTIVATION_SUPPRESSION_HMAC_SECRET;
  const previous = bindings.ACTIVATION_SUPPRESSION_HMAC_SECRET_PREVIOUS;
  if (!(current && usable(current))) {
    return undefined;
  }
  if (previous === undefined || previous === "") {
    return { current };
  }
  if (!usable(previous)) {
    return undefined;
  }
  return previous === current ? { current } : { current, previous };
}

const encoder = new TextEncoder();

/** The HMAC-SHA-256 of one normalized address under one secret, with the purpose in the signed text. */
export async function activationSuppressionHmac(
  secret: string,
  normalizedAddress: string
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"]
  );
  return new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      encoder.encode(`${SUPPRESSION_HMAC_PREFIX}${normalizedAddress}`)
    )
  );
}

/**
 * The identifier of one secret of the suppression, written with every row so the old secret can be retired when no row
 * is left under it: the first 4 bytes, in hexadecimal, of an HMAC-SHA-256 over a fixed purpose text. It does not reveal
 * the secret and changes with it.
 */
export async function activationSuppressionKeyId(
  secret: string
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"]
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      encoder.encode(SUPPRESSION_KEY_ID_TEXT)
    )
  );
  return Array.from(signature.slice(0, KEY_ID_BYTES), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}
