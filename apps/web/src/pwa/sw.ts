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
 * It only stores and serves what is the kind of file it asked for: a 200 with the
 * content type of a script for a `.js`, of a style sheet for a `.css`, and never an
 * HTML page for anything but a page. The host answers an unknown path with the
 * shell (a chunk that is not there yet, or no longer) and that must not be
 * cached as if it were the chunk.
 *
 * The build tool prepends `POLARIS_BUILD` (the build id and the list of files to
 * precache) and bundles this file as a classic script. Nothing in it depends on
 * when the build was made: the same content is the same worker, so the browser
 * finds no update (and the person is told of none) when only the time changed.
 */
export interface BuildManifest {
  /** A hash of what a user downloads: the worker changes when, and only when, it changes. */
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

export function shellCacheName(build: Pick<BuildManifest, "id">) {
  return `${SHELL_CACHE_PREFIX}${build.id}`;
}

const JAVASCRIPT_TYPE = /^(?:text|application)\/(?:x-)?(?:java|ecma)script/i;
const CSS_TYPE = /^text\/css/i;
const HTML_TYPE = /^text\/html/i;
const FILE_EXTENSION = /\.([a-z0-9]+)$/i;

interface ResponseLike {
  headers: { get: (name: string) => string | null };
  status: number;
}

/**
 * Whether a response is the file asked for: 200, and the content type its extension calls for (script, style
 * sheet or page); any other file only has to not be a page.
 */
export function isExpectedResponse(
  path: string,
  response: ResponseLike
): boolean {
  if (response.status !== 200) {
    return false;
  }
  const type = response.headers.get("content-type") ?? "";
  const extension = FILE_EXTENSION.exec(path)?.[1]?.toLowerCase();
  if (extension === "js" || extension === "mjs") {
    return JAVASCRIPT_TYPE.test(type);
  }
  if (extension === "css") {
    return CSS_TYPE.test(type);
  }
  const isPage =
    extension === "html" ||
    path === SHELL_PATH ||
    AUTH_ENTRY_PATHS.includes(path);
  return isPage ? HTML_TYPE.test(type) : !HTML_TYPE.test(type);
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

/** How many builds before the current one keep their shell (see `cachesToDelete`). */
const KEEP_PREVIOUS_BUILDS = 2;

/**
 * Of the shell caches present, the ones to delete: everything except the current
 * build and the `keepPrevious` newest other ones. The previous builds are kept
 * because a page that is still open may load one more lazy chunk of its own build,
 * and a tab left open through two updates is still on the build before the previous
 * one. A tab open through three or more updates loses its chunks: that case falls
 * to the reload-once of the error boundary (`reloadOnceForChunkError`), which can
 * cost what was typed and not saved; keeping more shells costs a copy of the precache each (about 1 MB gzip,
 * more on disk: not measured). `names` come in the order the caches were created (what
 * `caches.keys()` returns), which is the order of the builds: the names carry no time.
 */
export function cachesToDelete(
  names: readonly string[],
  current: string,
  keepPrevious = KEEP_PREVIOUS_BUILDS
): string[] {
  const others = names.filter(
    (name) => name.startsWith(SHELL_CACHE_PREFIX) && name !== current
  );
  return others.slice(0, Math.max(others.length - keepPrevious, 0));
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
  /** The file from the network, only if it is the file asked for (see `isExpectedResponse`). */
  const fetchExpected = async (path: string) => {
    const request = new Request(path, { cache: "reload" });
    const response = await fetch(request);
    if (!isExpectedResponse(path, response)) {
      throw new Error(`unexpected response for ${path}`);
    }
    return { request, response };
  };

  scope.addEventListener("install", ((event: WaitableEvent) => {
    event.waitUntil(
      (async () => {
        const cache = await caches.open(cacheName);
        // All or nothing: a half-cached shell is worse than none, and so is a page cached in place of a chunk.
        const files = await Promise.all(build.precache.map(fetchExpected));
        await Promise.all(
          files.map(({ request, response }) => cache.put(request, response))
        );
        // The sign-in copy is a bonus: without it a sign-in page offline gets the shell of / (the challenge
        // then says to reload), so a failure here never stops the worker from installing.
        await fetchExpected(AUTH_ENTRY_SHELL_PATH)
          .then(({ request, response }) => cache.put(request, response))
          .catch(() => undefined);
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
    const { pathname } = new URL(event.request.url);
    event.respondWith(
      lookup(event.request).then((cached) =>
        // a copy that is not the file (a page kept in place of a chunk by an older worker) is not served.
        // The copy is cloned: the `Response` straight from `cache.match` made Chrome refuse the page's
        // `modulepreload` of a chunk ("a preload ... is not used because it is a cross-world service worker
        // resource mismatch") and fetch it a second time; a clone is taken as the preload's (measured).
        cached && isExpectedResponse(pathname, cached)
          ? cached.clone()
          : fetch(event.request)
      )
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
