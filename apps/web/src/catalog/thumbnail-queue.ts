import type { ThumbnailCache } from "./thumbnail-cache";
import {
  THUMBNAIL_BATCH_LIMIT,
  type ThumbnailTransport,
} from "./thumbnail-transport";

/**
 * Who asks the server for thumbnails, and when. The rules, in the order they bind:
 *
 * - Only a row on screen starts a request (`show`); nothing is asked for a row nobody sees, and the catalog is
 *   never preloaded.
 * - At most one batch in flight, of up to 24 ids. A batch that a visible row started is completed with the next
 *   rows of the list (`setSequence`) that this device does not have yet: rolling a list from top to bottom then asks
 *   in full batches (1.248 rows, 52 requests), and the completion never makes a request of its own.
 * - An id this device already has is never asked again (an asset id is immutable), nor one the server answered as
 *   missing. Missing shows the marker; nothing falls back to the per-image route.
 * - Offline nothing is asked. A batch that failed (network, timeout, 429, 5xx) gives its ids back with a wait that
 *   grows, with jitter; after `MAX_ATTEMPTS` they rest with the marker until the connection comes back, and then
 *   the rows on screen ask once. A refusal (no session, no permission) stops asking until the connection comes
 *   back.
 * - Nothing here throws to a screen or makes it wait: a row with no thumbnail shows the marker.
 */
const MAX_ATTEMPTS = 3;
const FIRST_RETRY_MS = 2000;
const MAX_RETRY_MS = 60_000;
const BATCH_TIMEOUT_MS = 15_000;

export interface ThumbnailLoaderOptions {
  cache: ThumbnailCache;
  isOnline: () => boolean;
  organizationId: string;
  /** A number in [0, 1): the jitter of the waits. */
  random?: () => number;
  /** Runs the callback after the delay and returns how to cancel it (setTimeout in the browser). */
  schedule: (callback: () => void, delayMs: number) => () => void;
  /** Hears the connection change; returns how to stop hearing it. */
  subscribeOnline: (listener: () => void) => () => void;
  timeoutMs?: number;
  transport: ThumbnailTransport;
}

export class ThumbnailLoader {
  private readonly options: ThumbnailLoaderOptions;
  private readonly random: () => number;
  private readonly visible = new Map<string, number>();
  /** Looked up in the cache and not there: the server is the only source left. */
  private readonly wanted = new Set<string>();
  private readonly looking = new Set<string>();
  private readonly missing = new Set<string>();
  private readonly resting = new Set<string>();
  private readonly attempts = new Map<string, number>();
  private readonly listeners = new Map<string, Set<() => void>>();
  private sequence: readonly string[] = [];
  private positions = new Map<string, number>();
  private inFlight = false;
  private refused = false;
  private disposed: boolean;
  private failures = 0;
  private cancelWait: (() => void) | null = null;
  private abortInFlight: (() => void) | null = null;
  private wasOnline: boolean;
  private readonly stopOnline: () => void;

  constructor(options: ThumbnailLoaderOptions) {
    this.disposed = false;
    this.options = options;
    this.random = options.random ?? Math.random;
    this.wasOnline = options.isOnline();
    this.stopOnline = options.subscribeOnline(() => this.connectionChanged());
  }

  /** The URL to show, or `null` for the marker. A string, so a render can compare it. */
  url(assetId: string): string | null {
    return this.options.cache.peek(assetId);
  }

  subscribe(assetId: string, listener: () => void): () => void {
    const set = this.listeners.get(assetId) ?? new Set();
    set.add(listener);
    this.listeners.set(assetId, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) {
        this.listeners.delete(assetId);
      }
    };
  }

  /** The order of the rows of the list now (their capa ids; `null` for a row with none). */
  setSequence(assetIds: readonly (string | null | undefined)[]): void {
    this.sequence = assetIds.filter((id): id is string => Boolean(id));
    this.positions = new Map(this.sequence.map((id, index) => [id, index]));
  }

  /** A row with this capa is on screen; the returned function says it left. */
  show(assetId: string): () => void {
    this.visible.set(assetId, (this.visible.get(assetId) ?? 0) + 1);
    this.consider(assetId);
    let shown = true;
    return () => {
      if (!shown) {
        return;
      }
      shown = false;
      const count = (this.visible.get(assetId) ?? 1) - 1;
      if (count > 0) {
        this.visible.set(assetId, count);
      } else {
        this.visible.delete(assetId);
      }
    };
  }

  dispose(): void {
    this.disposed = true;
    this.stopOnline();
    this.cancelWait?.();
    this.cancelWait = null;
    this.abortInFlight?.();
    this.abortInFlight = null;
    this.listeners.clear();
  }

  private consider(assetId: string): void {
    if (
      this.disposed ||
      this.looking.has(assetId) ||
      this.missing.has(assetId)
    ) {
      return;
    }
    if (this.options.cache.peek(assetId)) {
      this.options.cache.used(assetId).catch(() => undefined);
      this.becomeReady(assetId);
      return;
    }
    if (this.wanted.has(assetId)) {
      this.pump();
      return;
    }
    this.looking.add(assetId);
    this.options.cache
      .lookup(assetId)
      .catch(() => null)
      .then((url) => {
        this.looking.delete(assetId);
        if (url) {
          this.becomeReady(assetId);
        } else if (!(this.missing.has(assetId) || this.disposed)) {
          this.wanted.add(assetId);
          this.pump();
        }
      });
  }

  private becomeReady(assetId: string): void {
    this.wanted.delete(assetId);
    this.attempts.delete(assetId);
    this.notify(assetId);
  }

  private notify(assetId: string): void {
    for (const listener of [...(this.listeners.get(assetId) ?? [])]) {
      listener();
    }
  }

  private mayAsk(): boolean {
    return (
      !(this.disposed || this.inFlight || this.refused || this.cancelWait) &&
      this.options.isOnline()
    );
  }

  private visibleWanted(): string[] {
    const ids = [...this.wanted].filter(
      (id) => this.visible.has(id) && !this.resting.has(id)
    );
    const at = (id: string) =>
      this.positions.get(id) ?? Number.MAX_SAFE_INTEGER;
    return ids.sort((a, b) => at(a) - at(b));
  }

  /** The rows after the last one on screen that this device does not have: the free seats of the batch. */
  private async completion(batch: readonly string[]): Promise<string[]> {
    const free = THUMBNAIL_BATCH_LIMIT - batch.length;
    const last = Math.max(
      -1,
      ...[...batch, ...this.visible.keys()].map(
        (id) => this.positions.get(id) ?? -1
      )
    );
    if (free <= 0 || last < 0) {
      return [];
    }
    const taken = new Set(batch);
    const candidates: string[] = [];
    for (let index = last + 1; index < this.sequence.length; index += 1) {
      if (candidates.length >= free * 2) {
        break;
      }
      const id = this.sequence[index] as string;
      if (
        !(
          taken.has(id) ||
          this.missing.has(id) ||
          this.resting.has(id) ||
          this.looking.has(id) ||
          this.options.cache.inMemory(id)
        )
      ) {
        taken.add(id);
        candidates.push(id);
      }
    }
    const known = await this.options.cache
      .known(candidates)
      .catch(() => new Set<string>());
    return candidates.filter((id) => !known.has(id)).slice(0, free);
  }

  private pump(): void {
    if (!this.mayAsk()) {
      return;
    }
    const visible = this.visibleWanted().slice(0, THUMBNAIL_BATCH_LIMIT);
    if (visible.length === 0) {
      return;
    }
    this.inFlight = true;
    this.send(visible)
      .catch(() => undefined)
      .finally(() => {
        this.inFlight = false;
        this.pump();
      });
  }

  private async send(visible: string[]): Promise<void> {
    const batch = [...visible, ...(await this.completion(visible))];
    if (this.disposed) {
      return;
    }
    const controller = new AbortController();
    this.abortInFlight = () => controller.abort();
    const cancelTimeout = this.options.schedule(
      () =>
        controller.abort(
          new DOMException("thumbnails_timeout", "TimeoutError")
        ),
      this.options.timeoutMs ?? BATCH_TIMEOUT_MS
    );
    const result = await this.options
      .transport({
        ids: batch,
        organizationId: this.options.organizationId,
        signal: controller.signal,
      })
      .catch(() => ({ kind: "failed" as const }));
    cancelTimeout();
    this.abortInFlight = null;
    if (this.disposed) {
      return;
    }
    if (result.kind === "refused") {
      this.refused = true;
      return;
    }
    if (result.kind === "failed") {
      this.failed(batch);
      return;
    }
    this.failures = 0;
    for (const id of batch) {
      const blob = result.items.get(id) ?? null;
      if (blob && this.options.cache.store(id, blob)) {
        this.becomeReady(id);
      } else {
        this.wanted.delete(id);
        this.missing.add(id);
      }
    }
  }

  /** Only the rows on screen count a try: an id that only filled a seat never rests for a batch it did not start. */
  private failed(batch: readonly string[]): void {
    for (const id of batch.filter((each) => this.visible.has(each))) {
      const attempts = (this.attempts.get(id) ?? 0) + 1;
      this.attempts.set(id, attempts);
      if (attempts >= MAX_ATTEMPTS) {
        this.resting.add(id);
      }
      this.wanted.add(id);
    }
    this.failures += 1;
    const base = Math.min(
      MAX_RETRY_MS,
      FIRST_RETRY_MS * 2 ** (this.failures - 1)
    );
    const delay = Math.round(base * (0.5 + this.random()));
    this.cancelWait = this.options.schedule(() => {
      this.cancelWait = null;
      this.pump();
    }, delay);
  }

  /** Back online: the rows on screen ask once, the rested ones included; going offline asks nothing. */
  private connectionChanged(): void {
    const online = this.options.isOnline();
    const cameBack = online && !this.wasOnline;
    this.wasOnline = online;
    if (!cameBack || this.disposed) {
      return;
    }
    this.cancelWait?.();
    this.cancelWait = null;
    this.failures = 0;
    this.refused = false;
    this.resting.clear();
    this.attempts.clear();
    this.pump();
  }
}
