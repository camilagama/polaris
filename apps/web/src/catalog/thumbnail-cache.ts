/**
 * The thumbnails this tab already has, so a capa shown once is never asked again: an asset id is immutable (a new
 * capa is a new id), so nothing here is ever revalidated. Two layers, each with the same budget of 10 MB and the
 * same rule (the least recently used goes first):
 *
 * - memory, always: the object URLs the `<img>` elements point at;
 * - the disk of the namespace (user + store), only when the device keeps the offline copy of the store. Without
 *   it nothing is written anywhere.
 *
 * Any failure of the disk (refused, full, removed by the browser) ends its use for this cache: it goes on in
 * memory and the screen never waits on it.
 */
export const THUMBNAIL_CACHE_BUDGET_BYTES = 10 * 1024 * 1024;

export interface ThumbnailUsage {
  assetId: string;
  lastUsed: number;
  size: number;
}

/**
 * Who leaves so that the rest fits in the budget: the least recently used first (ties by id, so the choice is
 * the same in every tab), until the total is within the budget. `keep` never leaves (the one just written).
 */
export function thumbnailsToEvict(
  entries: readonly ThumbnailUsage[],
  budgetBytes: number,
  keep?: string
): string[] {
  let total = entries.reduce((sum, entry) => sum + entry.size, 0);
  if (total <= budgetBytes) {
    return [];
  }
  const oldestFirst = [...entries].sort(
    (a, b) =>
      a.lastUsed - b.lastUsed ||
      (a.assetId < b.assetId ? -1 : Number(a.assetId > b.assetId))
  );
  const evicted: string[] = [];
  for (const entry of oldestFirst) {
    if (total <= budgetBytes) {
      break;
    }
    if (entry.assetId === keep) {
      continue;
    }
    evicted.push(entry.assetId);
    total -= entry.size;
  }
  return evicted;
}

/** The thumbnails store of one namespace on the disk (offline/thumbnail-store.ts in the browser). */
export interface ThumbnailDisk {
  close: () => void;
  /** Which of these ids are on the disk, without reading their bytes. */
  has: (assetIds: readonly string[]) => Promise<Set<string>>;
  /** Reads the bytes and marks the use, or `undefined` when the id is not there. */
  take: (assetId: string, now: number) => Promise<ArrayBuffer | undefined>;
  /** Marks the use of an id, if it is there. */
  touch: (assetId: string, now: number) => Promise<void>;
  /** Writes the bytes and evicts by `thumbnailsToEvict`, in the same transaction. */
  write: (
    assetId: string,
    bytes: ArrayBuffer,
    now: number,
    budgetBytes: number
  ) => Promise<void>;
}

export interface ThumbnailCacheOptions {
  budgetBytes?: number;
  createUrl?: (blob: Blob) => string;
  /** `null`: the store keeps no offline copy on this device (memory only). A rejected promise is the same. */
  disk: Promise<ThumbnailDisk> | null;
  now: () => number;
  revokeUrl?: (url: string) => void;
}

const THUMBNAIL_TYPE = "image/webp";
const USE_MARK_INTERVAL_MS = 60_000;

export class ThumbnailCache {
  private readonly budgetBytes: number;
  private readonly createUrl: (blob: Blob) => string;
  private readonly revokeUrl: (url: string) => void;
  private readonly now: () => number;
  /** In use order: the first is the least recently used. */
  private readonly memory = new Map<string, { size: number; url: string }>();
  private disk: Promise<ThumbnailDisk | null>;
  private disposed: boolean;
  /** When this cache last marked the use of each id on the disk. */
  private readonly usedOnDisk = new Map<string, number>();

  constructor(options: ThumbnailCacheOptions) {
    this.disposed = false;
    this.budgetBytes = options.budgetBytes ?? THUMBNAIL_CACHE_BUDGET_BYTES;
    this.createUrl = options.createUrl ?? ((blob) => URL.createObjectURL(blob));
    this.revokeUrl = options.revokeUrl ?? ((url) => URL.revokeObjectURL(url));
    this.now = options.now;
    this.disk = options.disk
      ? options.disk.catch(() => null)
      : Promise.resolve(null);
  }

  /** Whether the disk still takes part (false once it failed, or for a store with no offline copy). */
  async usesDisk(): Promise<boolean> {
    return (await this.disk) !== null;
  }

  /** The URL already in memory, at once (the first render of a row already on screen). */
  peek(assetId: string): string | null {
    const entry = this.memory.get(assetId);
    if (!entry) {
      return null;
    }
    this.memory.delete(assetId);
    this.memory.set(assetId, entry);
    return entry.url;
  }

  /** Whether the URL is in memory, without counting it as a use. */
  inMemory(assetId: string): boolean {
    return this.memory.has(assetId);
  }

  /** From memory or, failing that, from the disk; `null` when this device does not have it. */
  async lookup(assetId: string): Promise<string | null> {
    const hit = this.peek(assetId);
    if (hit) {
      await this.used(assetId);
      return hit;
    }
    const bytes = await this.onDisk((disk) => disk.take(assetId, this.now()));
    if (!bytes || this.disposed) {
      return null;
    }
    this.usedOnDisk.set(assetId, this.now());
    return this.remember(assetId, new Blob([bytes], { type: THUMBNAIL_TYPE }));
  }

  /**
   * A row showed this thumbnail again: the disk learns of the use, at most once a minute per id (each mark rewrites
   * the record, and a list scrolled up and down shows the same rows many times).
   */
  async used(assetId: string): Promise<void> {
    const now = this.now();
    const last = this.usedOnDisk.get(assetId);
    if (last !== undefined && now - last < USE_MARK_INTERVAL_MS) {
      return;
    }
    this.usedOnDisk.set(assetId, now);
    await this.onDisk((disk) => disk.touch(assetId, now));
  }

  /** Of these ids, the ones this device already has (memory or disk), without reading the bytes. */
  async known(assetIds: readonly string[]): Promise<Set<string>> {
    const known = new Set(assetIds.filter((id) => this.memory.has(id)));
    const rest = assetIds.filter((id) => !known.has(id));
    if (rest.length === 0) {
      return known;
    }
    const onDisk = await this.onDisk((disk) => disk.has(rest));
    for (const id of onDisk ?? []) {
      known.add(id);
    }
    return known;
  }

  /** Keeps what the server sent and returns the URL to show. The disk write never holds the screen. */
  async store(assetId: string, blob: Blob): Promise<string | null> {
    if (this.disposed) {
      return null;
    }
    const url = this.remember(assetId, blob);
    this.usedOnDisk.set(assetId, this.now());
    const bytes = await blob.arrayBuffer().catch(() => null);
    if (bytes) {
      await this.onDisk((disk) =>
        disk.write(assetId, bytes, this.now(), this.budgetBytes)
      );
    }
    return url;
  }

  /** Lets go of every URL and of the disk (the store changed, the person left, the namespace was wiped). */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const { url } of this.memory.values()) {
      this.revokeUrl(url);
    }
    this.memory.clear();
    const { disk } = this;
    this.disk = Promise.resolve(null);
    disk.then((open) => open?.close()).catch(() => undefined);
  }

  private remember(assetId: string, blob: Blob): string {
    const existing = this.memory.get(assetId);
    if (existing) {
      return this.peek(assetId) ?? existing.url;
    }
    const url = this.createUrl(blob);
    this.memory.set(assetId, { size: blob.size, url });
    const usage = [...this.memory].map(([id, entry], order) => ({
      assetId: id,
      lastUsed: order,
      size: entry.size,
    }));
    for (const evicted of thumbnailsToEvict(usage, this.budgetBytes, assetId)) {
      const entry = this.memory.get(evicted);
      if (entry) {
        this.memory.delete(evicted);
        this.revokeUrl(entry.url);
      }
    }
    return url;
  }

  /** Runs on the disk when there is one; a failure turns the disk off for good and answers `undefined`. */
  private async onDisk<T>(
    work: (disk: ThumbnailDisk) => Promise<T>
  ): Promise<T | undefined> {
    const disk = await this.disk;
    if (!disk || this.disposed) {
      return undefined;
    }
    try {
      return await work(disk);
    } catch {
      this.disk = Promise.resolve(null);
      try {
        disk.close();
      } catch {
        // already closed by the browser
      }
      return undefined;
    }
  }
}
