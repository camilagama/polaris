import { scryptAsync } from "@noble/hashes/scrypt.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { normalizePassword } from "./password-policy";

// Preserve Better Auth Scrypt parameters and salt:key format while using the product-required NFC normalization.
const SCRYPT_OPTIONS = {
  dkLen: 64,
  maxmem: 128 * 16_384 * 16 * 2,
  N: 16_384,
  p: 1,
  r: 16,
};
const SALT_BYTES = 16;
const DERIVED_KEY_BYTES = 64;

export async function hashPasswordNfc(password: string): Promise<string> {
  const normalizedPassword = normalizePassword(password);
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const derivedKey = await scryptAsync(
    normalizedPassword,
    salt,
    SCRYPT_OPTIONS
  );

  return `${bytesToHex(salt)}:${bytesToHex(derivedKey)}`;
}

export async function verifyPasswordNfc({
  hash,
  password,
}: {
  hash: string;
  password: string;
}): Promise<boolean> {
  const [saltHex, expectedKeyHex, extra] = hash.split(":");

  if (!(saltHex && expectedKeyHex) || extra !== undefined) {
    return false;
  }

  try {
    const salt = hexToBytes(saltHex);
    const expectedKey = hexToBytes(expectedKeyHex);

    if (
      salt.length !== SALT_BYTES ||
      expectedKey.length !== DERIVED_KEY_BYTES
    ) {
      return false;
    }

    const normalizedPassword = normalizePassword(password);
    const actualKey = await scryptAsync(
      normalizedPassword,
      salt,
      SCRYPT_OPTIONS
    );

    return bytesToHex(actualKey) === expectedKeyHex.toLowerCase();
  } catch {
    return false;
  }
}
