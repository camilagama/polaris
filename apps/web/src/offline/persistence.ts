/**
 * Persistent storage (ADR 0015, plan PR52): without it the browser may evict
 * the outbox and the local collections under storage pressure. The answer is a
 * visible state, never assumed: "denied" means offline work is at risk and the
 * interface must say so.
 */
export type PersistentStorageState = "granted" | "denied" | "unsupported";

export async function requestPersistentStorage(): Promise<PersistentStorageState> {
  const storage =
    typeof navigator === "undefined" ? undefined : navigator.storage;
  if (!(storage && typeof storage.persist === "function")) {
    return "unsupported";
  }
  try {
    if (
      typeof storage.persisted === "function" &&
      (await storage.persisted())
    ) {
      return "granted";
    }
    return (await storage.persist()) ? "granted" : "denied";
  } catch {
    return "denied";
  }
}
