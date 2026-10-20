/**
 * The service worker of the app shell (plan PR60). It does exactly three things:
 *
 * 1. precaches the shell of THIS build (index.html, the hashed JS and CSS, the
 *    manifest and icons) under a cache named after the build, so a deploy never
 *    mixes files of two builds;
 * 2. answers a navigation with the network when it can and with the cached shell
 *    when it cannot, so the app opens offline. The sign-in pages with the challenge
 *    have a copy of their own (`/entrar`, fetched at install): the policy of a
 *    document comes with it, and theirs lets the Turnstile widget load (ADR 0100);
 * 3. serves the precached static files cache-first.
 *
 * It never touches anything else. In particular it never answers, stores or even
 * sees `/rpc/*` and `/api/*` (tenant data and authentication), `/health` or
 * `/ready`: those requests are not intercepted, so no tenant data can end up in
 * Cache Storage. The tenant data a device keeps offline lives in its local
 * database and outbox (ADR 0015), not here.
 *
 * It does not call `skipWaiting` by itself: a new build waits until the page asks
 * (`SKIP_WAITING`), so an update never swaps the files under a running app or
 * reloads it while work is queued (PR61).
 *
 * The build tool prepends `POLARIS_BUILD` (the build id, its time and the list of
 * files to precache) and bundles this file as a classic script.
 */
export interface BuildManifest {
  /** Milliseconds since the epoch when the build was made; orders the caches. */
  builtAt: number;
  id: string;
  /** Paths served by the app, `/` first (the shell). */
  precache: string[];
}

declare const POLARIS_BUILD: BuildManifest | undefined;

export const SHELL_CACHE_PREFIX = "polaris-shell-";
const SHELL_PATH = "/";
/** The same shell under the policy of the sign-in pages (`auth-entry` in `public/_headers`). */
const AUTH_ENTRY_SHELL_PATH = "/entrar";
const TRAILING_SLASHES = /\/+$/;
/** `AUTH_ENTRY_PATHS` of @polaris/http-security (this script is bundled alone; a test keeps them equal). */
export const AUTH_ENTRY_PATHS: readonly string[] = [
  "/entrar",
  "/criar-conta",
  "/esqueci-a-senha",
  "/redefinir-senha",
  "/confirmar-email",
];
/** Static files are the same for every requester, whatever the `Vary` header says. */
const MATCH_OPTIONS = { ignoreVary: true };
/** Paths owned by the Worker: never intercepted, never cached. */
const WORKER_PATHS = ["/api/", "/rpc/"];
const WORKER_EXACT_PATHS = ["/health", "/ready"];

export type RequestRoute = "asset" | "bypass" | "navigate";

export function shellCacheName(build: Pick<BuildManifest, "builtAt" | "id">) {
  // Zero-padded so that sorting the names as text sorts the builds by time.
  return `${SHELL_CACHE_PREFIX}${String(build.builtAt).padStart(15, "0")}-${build.id}`;
}

function isWorkerPath(pathname: string): boolean {
  return (
    WORKER_EXACT_PATHS.includes(pathname) ||
    WORKER_PATHS.some((prefix) => pathname.startsWith(prefix))
  );
}

/** The cached copy a navigation falls back to when the network does not answer. */
export function offlineShellFor(url: string): string {
  const { pathname } = new URL(url);
  return AUTH_ENTRY_PATHS.includes(pathname.replace(TRAILING_SLASHES, ""))
    ? AUTH_ENTRY_SHELL_PATH
    : SHELL_PATH;
}

/** Decides what the worker does with a request; `bypass` means: do not touch it. */
export function routeFor(
  request: { method: string; mode: string; url: string },
  origin: string,
  precache: ReadonlySet<string>
): RequestRoute {
  if (request.method !== "GET") {
    return "bypass";
  }
  const url = new URL(request.url);
  if (url.origin !== origin || isWorkerPath(url.pathname)) {
    return "bypass";
  }
  if (request.mode === "navigate") {
    return "navigate";
  }
  return precache.has(url.pathname) ? "asset" : "bypass";
}

/**
 * Of the shell caches present, the ones to delete: everything except the current
 * build and the newest other one. The previous build is kept because a page that
 * is still open may load one more lazy chunk of it.
 */
export function cachesToDelete(
  names: readonly string[],
  current: string
): string[] {
  const others = names
    .filter((name) => name.startsWith(SHELL_CACHE_PREFIX) && name !== current)
    .sort()
    .reverse();
  return others.slice(1);
}

/** The messages a page may send. */
export function isSkipWaitingMessage(data: unknown): boolean {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { type?: unknown }).type === "SKIP_WAITING"
  );
}

// ------------------------------------------------------------------ worker
interface WaitableEvent {
  waitUntil: (work: Promise<unknown>) => void;
}
interface FetchLikeEvent {
  request: Request;
  respondWith: (response: Promise<Response>) => void;
}
interface WorkerScope {
  addEventListener: (type: string, listener: (event: never) => void) => void;
  clients: { claim: () => Promise<void> };
  location: { origin: string };
  skipWaiting: () => Promise<void>;
}

function startWorker(scope: WorkerScope, build: BuildManifest) {
  const cacheName = shellCacheName(build);
  const precache = new Set(build.precache);
  /** The current build's copy first, then any older one still kept. */
  const lookup = async (request: Request | string) =>
    (await (await caches.open(cacheName)).match(request, MATCH_OPTIONS)) ??
    (await caches.match(request, MATCH_OPTIONS));

  scope.addEventListener("install", ((event: WaitableEvent) => {
    event.waitUntil(
      (async () => {
        const cache = await caches.open(cacheName);
        // All or nothing: a half-cached shell is worse than none.
        await cache.addAll(
          [...build.precache, AUTH_ENTRY_SHELL_PATH].map(
            (path) => new Request(path, { cache: "reload" })
          )
        );
      })()
    );
  }) as never);

  scope.addEventListener("activate", ((event: WaitableEvent) => {
    event.waitUntil(
      (async () => {
        const names = await caches.keys();
        await Promise.all(
          cachesToDelete(names, cacheName).map((name) => caches.delete(name))
        );
        // No `clients.claim()`: pages loaded under an older worker keep it, so the
        // files they still load come from the cache that matches them.
      })()
    );
  }) as never);

  scope.addEventListener("message", ((event: { data: unknown }) => {
    if (isSkipWaitingMessage(event.data)) {
      scope.skipWaiting().catch(() => undefined);
    }
  }) as never);

  scope.addEventListener("fetch", ((event: FetchLikeEvent) => {
    const route = routeFor(event.request, scope.location.origin, precache);
    if (route === "bypass") {
      return;
    }
    if (route === "navigate") {
      event.respondWith(
        fetch(event.request).catch(
          async () =>
            (await lookup(offlineShellFor(event.request.url))) ??
            (await lookup(SHELL_PATH)) ??
            Response.error()
        )
      );
      return;
    }
    event.respondWith(
      lookup(event.request).then((cached) => cached ?? fetch(event.request))
    );
  }) as never);
}

if (
  typeof POLARIS_BUILD !== "undefined" &&
  typeof self !== "undefined" &&
  "registration" in self
) {
  startWorker(self as unknown as WorkerScope, POLARIS_BUILD);
}
