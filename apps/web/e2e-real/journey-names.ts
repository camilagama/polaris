import { createHash } from "node:crypto";

/**
 * Names and ids of the journeys' data (T-125a). Every organization and its owner are `qa-<project>-<journey>-t<attempt>`:
 * the project is in the name because both projects share the run database, and the attempt because a retry starts
 * from its own clean organization (nothing is deleted). The user id is a UUID v5 of that name.
 */

// a fixed namespace of the e2e suite (UUID v4 written once); any constant works, it only has to never change
const NAMESPACE = "5b0c2c1e-5d0a-4b8e-9a43-6f1f2b7d9e10";
const namePattern = /^[a-z0-9-]+$/;

export function journeyName(
  project: string,
  journey: string,
  attempt: number
): string {
  if (
    !(
      namePattern.test(project) &&
      namePattern.test(journey) &&
      Number.isInteger(attempt) &&
      attempt >= 0
    )
  ) {
    throw new Error(`Refused journey name: ${project} ${journey} ${attempt}`);
  }
  return `qa-${project}-${journey}-t${attempt}`;
}

/** RFC 9562 version 5 (SHA-1, name-based). */
export function uuidV5(name: string, namespace: string = NAMESPACE): string {
  const hash = createHash("sha1")
    .update(Buffer.from(namespace.replaceAll("-", ""), "hex"))
    .update(name, "utf8")
    .digest();
  const bytes = hash.subarray(0, 16);
  bytes[6] = ((bytes[6] as number) % 16) + 0x50;
  bytes[8] = ((bytes[8] as number) % 64) + 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * The client address of a journey user (`cf-connecting-ip`, which the local preview keeps when the client sends it):
 * the IPv6 documentation range (RFC 3849) and 96 bits of a SHA-256 of the name. The Worker's rate limits count per
 * session and per address, and on the loopback every request would be `127.0.0.1`, one bucket for the whole run,
 * shared by both previews (one `.wrangler/state`) and by the retry. With one address per name, each test and
 * attempt has its own bucket, as each person has in production, and the limit itself stays the deployed one.
 */
export function journeyClientIp(name: string): string {
  const hex = createHash("sha256").update(name, "utf8").digest("hex");
  const groups = Array.from({ length: 6 }, (_, index) =>
    hex.slice(index * 4, index * 4 + 4)
  );
  return `2001:db8:${groups.join(":")}`;
}
