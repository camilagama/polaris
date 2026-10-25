/**
 * Tells a failed download of a piece of the app (the `import()` of a screen, a missing or stale chunk) from an
 * error of the screen itself, and reloads the page at most once for it.
 */
const CHUNK_ERROR_MESSAGES = [
  // Chrome and Edge
  /Failed to fetch dynamically imported module/i,
  // Firefox
  /error loading dynamically imported module/i,
  // Safari
  /Importing a module script failed/i,
  // Vite's preload helper and the older bundlers
  /Unable to preload CSS/i,
  /Loading (?:CSS )?chunk [\w-]+ failed/i,
];

export function isChunkLoadError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return (
    error.name === "ChunkLoadError" ||
    CHUNK_ERROR_MESSAGES.some((pattern) => pattern.test(error.message))
  );
}

const RELOAD_MARK = "polaris:chunk-reload-at";
/**
 * A second chunk failure inside this window is not answered with another reload. The reload is the person's click,
 * so it cannot loop by itself; the window only stops a click on a page that just reloaded and failed the same way
 * from reloading again at once. (The browser keeps a failed module in its module map, so asking `import()` again
 * does not recover it either: only a new page load does.)
 */
export const RELOAD_WINDOW_MS = 10_000;

interface ReloadStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

/**
 * Reloads the page, once per window, so the missing piece is asked again from the server (a lazy component keeps
 * the promise of the import that failed, so only a new page load gives it another chance). Returns whether it
 * reloaded; false when it already did a moment ago or when the tab cannot remember it did (no loop either way).
 */
export function reloadOnceForChunkError(
  storage: ReloadStorage | null,
  now: number,
  reload: () => void
): boolean {
  try {
    const last = Number(storage?.getItem(RELOAD_MARK));
    if (!storage || (last > 0 && now - last < RELOAD_WINDOW_MS)) {
      return false;
    }
    storage.setItem(RELOAD_MARK, String(now));
  } catch {
    return false;
  }
  reload();
  return true;
}
