import { describe, expect, it } from "vitest";
import {
  THUMBNAIL_CACHE_BUDGET_BYTES,
  ThumbnailCache,
  type ThumbnailDisk,
  thumbnailsToEvict,
} from "./thumbnail-cache";

/**
 * The cache of thumbnails: the budget of 10 MB with the least recently used leaving first, the plan with no offline
 * copy writing nothing to the disk, and a disk that fails leaving the cache in memory. The IndexedDB store itself
 * is proved in the browser (e2e/offline-thumbnails.e2e.ts); here it is a disk in memory with the same rule.
 */
const KB = 1024;

/** A disk with the eviction of the real one (`thumbnailsToEvict` in the same write), and a record of the calls. */
class MemoryDisk implements ThumbnailDisk {
  readonly records = new Map<
    string,
    { bytes: ArrayBuffer; lastUsed: number }
  >();
  readonly calls: string[] = [];
  closed: boolean;
  failWrites: boolean;

  constructor(failWrites = false) {
    this.closed = false;
    this.failWrites = failWrites;
  }

  close() {
    this.closed = true;
  }

  has(assetIds: readonly string[]) {
    this.calls.push("has");
    return Promise.resolve(
      new Set(assetIds.filter((id) => this.records.has(id)))
    );
  }

  take(assetId: string, now: number) {
    this.calls.push("take");
    const record = this.records.get(assetId);
    if (record) {
      record.lastUsed = now;
    }
    return Promise.resolve(record?.bytes);
  }

  touch(assetId: string, now: number) {
    this.calls.push("touch");
    const record = this.records.get(assetId);
    if (record) {
      record.lastUsed = now;
    }
    return Promise.resolve();
  }

  write(assetId: string, bytes: ArrayBuffer, now: number, budget: number) {
    this.calls.push("write");
    if (this.failWrites) {
      return Promise.reject(new DOMException("full", "QuotaExceededError"));
    }
    this.records.set(assetId, { bytes, lastUsed: now });
    const usage = [...this.records].map(([id, record]) => ({
      assetId: id,
      lastUsed: record.lastUsed,
      size: record.bytes.byteLength,
    }));
    for (const id of thumbnailsToEvict(usage, budget, assetId)) {
      this.records.delete(id);
    }
    return Promise.resolve();
  }
}

const blobOf = (size: number) =>
  new Blob([new Uint8Array(size)], { type: "image/webp" });

function setup(disk: Promise<ThumbnailDisk> | null) {
  const clock = { now: 1000 };
  const revoked: string[] = [];
  let made = 0;
  const cache = new ThumbnailCache({
    createUrl: () => {
      made += 1;
      return `blob:${made}`;
    },
    disk,
    now: () => clock.now,
    revokeUrl: (url) => revoked.push(url),
  });
  return { cache, clock, revoked };
}

describe("thumbnailsToEvict", () => {
  it("dentro do orçamento ninguém sai", () => {
    expect(
      thumbnailsToEvict(
        [
          { assetId: "a", lastUsed: 1, size: 4 },
          { assetId: "b", lastUsed: 2, size: 6 },
        ],
        10
      )
    ).toEqual([]);
  });

  it("acima do orçamento saem os menos usados até caber, e nunca o que acabou de entrar", () => {
    expect(
      thumbnailsToEvict(
        [
          { assetId: "novo", lastUsed: 0, size: 5 },
          { assetId: "recente", lastUsed: 9, size: 5 },
          { assetId: "velho", lastUsed: 1, size: 5 },
          { assetId: "medio", lastUsed: 5, size: 5 },
        ],
        10,
        "novo"
      )
    ).toEqual(["velho", "medio"]);
  });
});

describe("ThumbnailCache", () => {
  it("com cópia offline, acima de 10 MB o disco descarta as menos usadas e guarda as recentes", async () => {
    const disk = new MemoryDisk();
    const { cache, clock } = setup(Promise.resolve(disk));
    const size = 400 * KB;
    const count = Math.floor(THUMBNAIL_CACHE_BUDGET_BYTES / size);
    for (let index = 0; index < count; index += 1) {
      clock.now += 1;
      // biome-ignore lint/performance/noAwaitInLoops: one write after the other, in the order of use
      await cache.store(`a${index}`, blobOf(size));
    }
    clock.now += 60_000;
    await cache.lookup("a0");
    clock.now += 1;
    await cache.store("extra-1", blobOf(size));
    clock.now += 1;
    await cache.store("extra-2", blobOf(size));
    const total = [...disk.records.values()].reduce(
      (sum, record) => sum + record.bytes.byteLength,
      0
    );
    expect(total).toBeLessThanOrEqual(THUMBNAIL_CACHE_BUDGET_BYTES);
    expect(disk.records.has("a0")).toBe(true);
    expect(disk.records.has("a1")).toBe(false);
    expect(disk.records.has("a2")).toBe(false);
    expect(disk.records.has("extra-2")).toBe(true);
  });

  it("o uso de uma miniatura já em memória vai ao disco no máximo uma vez por minuto", async () => {
    const disk = new MemoryDisk();
    const { cache, clock } = setup(Promise.resolve(disk));
    await cache.store("a", blobOf(10));
    clock.now += 30_000;
    await cache.used("a");
    clock.now += 30_000;
    await cache.used("a");
    expect(disk.calls).toEqual(["write", "touch"]);
    expect(disk.records.get("a")?.lastUsed).toBe(clock.now);
  });

  it("a memória também tem orçamento: a menos usada sai e a URL dela é liberada", async () => {
    const { cache, revoked } = setup(null);
    const half = THUMBNAIL_CACHE_BUDGET_BYTES / 2;
    await cache.store("a", blobOf(half));
    await cache.store("b", blobOf(half));
    expect(cache.peek("a")).toBe("blob:1");
    await cache.store("c", blobOf(half));
    expect(cache.peek("b")).toBeNull();
    expect(revoked).toEqual(["blob:2"]);
    expect(cache.peek("a")).toBe("blob:1");
  });

  it("sem cópia offline (plano sem offline), nada vai ao disco e a miniatura continua em memória", async () => {
    const { cache } = setup(null);
    const url = await cache.store("a", blobOf(10));
    expect(url).toBe("blob:1");
    expect(await cache.usesDisk()).toBe(false);
    expect(await cache.lookup("a")).toBe("blob:1");
    expect(await cache.lookup("b")).toBeNull();
  });

  it("IndexedDB negado: o cache cai para a memória e a tela segue", async () => {
    const { cache } = setup(
      Promise.reject(new DOMException("denied", "SecurityError"))
    );
    expect(await cache.store("a", blobOf(10))).toBe("blob:1");
    expect(await cache.lookup("a")).toBe("blob:1");
    expect(await cache.usesDisk()).toBe(false);
  });

  it("disco cheio: a escrita falha uma vez, o disco sai de cena e a memória segue", async () => {
    const disk = new MemoryDisk(true);
    const { cache } = setup(Promise.resolve(disk));
    expect(await cache.store("a", blobOf(10))).toBe("blob:1");
    expect(await cache.usesDisk()).toBe(false);
    expect(disk.closed).toBe(true);
    await cache.store("b", blobOf(10));
    expect(disk.calls).toEqual(["write"]);
    expect(cache.peek("b")).toBe("blob:2");
  });

  it("lê do disco o que outra visita guardou e marca o uso", async () => {
    const disk = new MemoryDisk();
    disk.records.set("a", { bytes: new ArrayBuffer(10), lastUsed: 1 });
    const { cache, clock } = setup(Promise.resolve(disk));
    clock.now = 5000;
    expect(await cache.lookup("a")).toBe("blob:1");
    expect(disk.records.get("a")?.lastUsed).toBe(5000);
    expect(await cache.known(["a", "b"])).toEqual(new Set(["a"]));
  });

  it("descartar libera todas as URLs, fecha o disco e não guarda mais nada", async () => {
    const disk = new MemoryDisk();
    const { cache, revoked } = setup(Promise.resolve(disk));
    await cache.store("a", blobOf(10));
    cache.dispose();
    await cache.usesDisk();
    expect(revoked).toEqual(["blob:1"]);
    expect(disk.closed).toBe(true);
    expect(cache.peek("a")).toBeNull();
    expect(await cache.store("b", blobOf(10))).toBeNull();
    expect(disk.records.has("b")).toBe(false);
  });
});
