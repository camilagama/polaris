import { ProviderNotConfiguredError } from "../provider-port";

/**
 * The signature of a Woovi webhook (ADR 0101, emenda Woovi): `x-webhook-signature`
 * is base64 of RSA-SHA256 (PKCS #1 v1.5) over the **raw body**, made with
 * Woovi's private key. It is checked over the exact bytes received, before any
 * `JSON.parse`, so a body with its keys reordered or its spacing changed does
 * not pass. The public keys are pinned in configuration
 * (`WOOVI_WEBHOOK_PUBLIC_KEYS`), never fetched at run time: one key, or two
 * during a rotation. The deprecated HMAC (`X-OpenPix-Signature`) is not read.
 */

/** The largest body whose signature is checked: the route refuses more before this. */
export const MAX_WOOVI_WEBHOOK_BYTES = 64 * 1024;
/** Keys accepted at once: the current one and, during a rotation, the next. */
const MAX_PUBLIC_KEYS = 2;
/** Base64 of a 4096-bit signature is 684 characters; anything longer is not one. */
const MAX_SIGNATURE_LENGTH = 1024;
const pemArmor = /-----(?:BEGIN|END) PUBLIC KEY-----/g;
const whitespace = /\s+/g;
const base64Pattern = /^[A-Za-z\d+/]+={0,2}$/;
const encoder = new TextEncoder();

/** An imported public key (`CryptoKey`), named without the DOM or Node types. */
type WooviPublicKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

function base64Bytes(text: string): Uint8Array<ArrayBuffer> | null {
  if (!base64Pattern.test(text) || text.length % 4 !== 0) {
    return null;
  }
  try {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return null;
  }
}

const imported = new Map<string, Promise<WooviPublicKey[]>>();

async function importKeys(setting: string): Promise<WooviPublicKey[]> {
  const entries = setting
    .split(",")
    .map((entry) => entry.replace(pemArmor, "").replace(whitespace, ""))
    .filter((entry) => entry.length > 0);
  if (entries.length === 0 || entries.length > MAX_PUBLIC_KEYS) {
    throw new ProviderNotConfiguredError();
  }
  return await Promise.all(
    entries.map(async (entry) => {
      const der = base64Bytes(entry);
      if (!der) {
        throw new ProviderNotConfiguredError();
      }
      try {
        return await crypto.subtle.importKey(
          "spki",
          der,
          { hash: "SHA-256", name: "RSASSA-PKCS1-v1_5" },
          false,
          ["verify"]
        );
      } catch {
        // biome-ignore lint/style/useErrorCause: A key that does not import is a setting to fix, nothing more.
        throw new ProviderNotConfiguredError();
      }
    })
  );
}

/**
 * The public keys of a `WOOVI_WEBHOOK_PUBLIC_KEYS` setting: one or two SPKI
 * keys separated by a comma, each as base64 of its DER or as PEM. Imported once
 * per isolate. A missing, empty or unreadable setting is
 * `ProviderNotConfiguredError`: without a key the adapter never answers 200.
 */
export async function wooviPublicKeys(
  setting: string | undefined
): Promise<WooviPublicKey[]> {
  const value = setting ?? "";
  let keys = imported.get(value);
  if (!keys) {
    keys = importKeys(value);
    imported.set(value, keys);
    // a failed import is not kept: a fixed setting is read again
    keys.catch(() => imported.delete(value));
  }
  return await keys;
}

/**
 * True when `signature` is a valid signature of `rawBody` by one of the keys.
 * The body is the text the route decoded from the bytes received (UTF-8, the
 * byte order mark kept), so encoding it again gives those bytes back.
 */
export async function wooviSignatureMatches(
  rawBody: string,
  signature: string | null,
  keys: readonly WooviPublicKey[]
): Promise<boolean> {
  if (
    signature === null ||
    signature.length === 0 ||
    signature.length > MAX_SIGNATURE_LENGTH ||
    !base64Pattern.test(signature)
  ) {
    return false;
  }
  const signed = base64Bytes(signature);
  const body = encoder.encode(rawBody);
  if (!signed || body.byteLength > MAX_WOOVI_WEBHOOK_BYTES) {
    return false;
  }
  for (const key of keys) {
    // biome-ignore lint/performance/noAwaitInLoops: At most two keys, tried one after the other.
    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      signed,
      body
    );
    if (valid) {
      return true;
    }
  }
  return false;
}
