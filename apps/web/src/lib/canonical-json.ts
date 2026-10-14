/**
 * Deterministic text of a JSON value (object keys sorted), so two payloads that
 * differ only in key order are the same command. Used by the outbox to compare
 * an idempotent retry and by the server to hash the content of a command.
 */
export type CanonicalJson =
  | boolean
  | number
  | string
  | null
  | CanonicalJson[]
  | { [key: string]: CanonicalJson };

export function canonicalJson(value: CanonicalJson): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalJson(value[key] ?? null)}`
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Hex SHA-256 of a text. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
  );
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
