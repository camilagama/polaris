const LOCK_PREFIX = "polaris-local-file:";

/**
 * Runs `task` holding a Web Lock named after the OPFS file. Two tabs creating or
 * removing the same file at once (right after a wipe removed it, or on first use)
 * make one of them fail with NotFoundError inside the SQLite worker; one tab at a
 * time leaves the second a file that already exists. Different files never wait
 * for each other. Without Web Locks the task runs as is.
 */
export function withLocalFileLock<T>(
  databaseFile: string,
  task: () => Promise<T>
): Promise<T> {
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  if (typeof locks?.request !== "function") {
    return task();
  }
  return locks.request(`${LOCK_PREFIX}${databaseFile}`, task);
}
