import { sha256Hex } from "../../lib/canonical-json";
import type { WorkerBindings } from "../environment";

/**
 * The identity of a command's content in `sync_commands.payload_hash` (plan
 * PR105, ADR 0079). It is an HMAC-SHA256 with a server secret: a plain SHA-256
 * of a customer's name, phone or email let anyone who reads the database or a
 * backup confirm a guessed value. The keyed hash still lets the server tell a
 * retry of the same command from a different command under the same ID.
 *
 * Rows written before the HMAC hold the plain SHA-256, and rows written before
 * a rotation hold the HMAC of the previous secret; a retry of such a command is
 * compared against those too (`equivalent`) so it replays instead of being
 * refused as a reused ID. Nothing is ever stored under them again.
 */
export class SyncPayloadHashUnavailableError extends Error {
  constructor() {
    super("sync_payload_hash_unavailable");
    this.name = "SyncPayloadHashUnavailableError";
  }
}

/** The same floor as the lease secret: 32 bytes. */
const MIN_SECRET_BYTES = 32;

export interface SyncPayloadHashKeys {
  current: string;
  /** Secrets of a rotation still accepted when comparing a retry. */
  previous: string[];
}

function usable(secret: string | undefined): secret is string {
  return (
    secret !== undefined &&
    new TextEncoder().encode(secret).length >= MIN_SECRET_BYTES
  );
}

/** Reads the secrets from the Worker; without a usable one `sync.push` fails closed. */
export function syncPayloadHashKeys(
  bindings: Pick<
    WorkerBindings,
    "SYNC_PAYLOAD_HASH_PREVIOUS_SECRET" | "SYNC_PAYLOAD_HASH_SECRET"
  >
): SyncPayloadHashKeys {
  const current = bindings.SYNC_PAYLOAD_HASH_SECRET;
  // An empty previous secret is the end of a rotation, not a broken one.
  const previous = bindings.SYNC_PAYLOAD_HASH_PREVIOUS_SECRET || undefined;
  if (!usable(current) || (previous !== undefined && !usable(previous))) {
    throw new SyncPayloadHashUnavailableError();
  }
  return { current, previous: previous === undefined ? [] : [previous] };
}

async function hmacSha256Hex(secret: string, text: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"]
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode(text))
  );
  return [...signature]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export interface CommandPayloadHashes {
  /** Hashes an older row may hold for this same content. */
  equivalent: string[];
  /** What a new row stores. */
  stored: string;
}

export async function commandPayloadHashes(
  text: string,
  keys: SyncPayloadHashKeys
): Promise<CommandPayloadHashes> {
  const [stored, rotated, unkeyed] = await Promise.all([
    hmacSha256Hex(keys.current, text),
    Promise.all(keys.previous.map((secret) => hmacSha256Hex(secret, text))),
    sha256Hex(text),
  ]);
  return {
    equivalent: [...rotated, unkeyed],
    stored,
  };
}
