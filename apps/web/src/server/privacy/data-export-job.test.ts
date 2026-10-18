import type { ClaimedDataExport } from "@polaris/db/privacy-maintenance";
import { TenantAuthorizationError } from "@polaris/db/tenant-transaction";
import { describe, expect, it, vi } from "vitest";
import { buildImageParts, ExportTooLargeError } from "./data-export-build";
import { runDataExports } from "./data-export-job";

const organizationId = "org_1";
const exportId = "0199c2d0-0000-7000-8000-0000000000aa";
const claimed: ClaimedDataExport = {
  attempt: 1,
  formats: ["json", "images"],
  id: exportId,
  organizationId,
  requestedBy: "user_1",
};
const prefix = `exports/v1/${organizationId}/${exportId}/`;
const now = new Date("2026-10-17T12:00:00.000Z");

function objectOf(bytes: Uint8Array) {
  return {
    arrayBuffer: () =>
      Promise.resolve(
        bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength
        )
      ),
  } as never;
}

function fixture(input: {
  claims?: (ClaimedDataExport | null)[];
  collect?: ReturnType<typeof vi.fn>;
  deletable?: { id: string; organizationId: string }[];
  images?: { assetId: string; byteSize: number; storageKey: string }[];
  objects?: Map<string, Uint8Array>;
}) {
  const objects = input.objects ?? new Map<string, Uint8Array>();
  const claims = [...(input.claims ?? [claimed, null])];
  const client = {
    claimDataExport: vi.fn(() => Promise.resolve(claims.shift() ?? null)),
    claimDataExportById: vi.fn(
      (_exportId: string, _organizationId: string, _lease: number) =>
        Promise.resolve(claims.shift() ?? null)
    ),
    completeDataExport: vi.fn(() =>
      Promise.resolve({ expiresAt: now, totalBytes: 1 })
    ),
    expireDataExports: vi.fn(() => Promise.resolve(2)),
    failDataExport: vi.fn((_id: string, _code: string, final: boolean) =>
      Promise.resolve(final)
    ),
    listDataExportsToDelete: vi.fn(() =>
      Promise.resolve(input.deletable ?? [])
    ),
    markDataExportFilesDeleted: vi.fn(() => Promise.resolve(true)),
    recordDataExportFile: vi.fn((_file: { name: string; ordinal: number }) =>
      Promise.resolve()
    ),
  };
  const bucket = {
    delete: vi.fn((key: string) => {
      objects.delete(key);
      return Promise.resolve();
    }),
    get: vi.fn((key: string) => {
      const bytes = objects.get(key);
      return Promise.resolve(bytes ? objectOf(bytes) : null);
    }),
    list: vi.fn((options: { prefix: string }) =>
      Promise.resolve({
        objects: [...objects.keys()]
          .filter((key) => key.startsWith(options.prefix))
          .map((key) => ({ key, uploaded: now })),
        truncated: false,
      })
    ),
    put: vi.fn((key: string, value: Uint8Array) => {
      objects.set(key, value);
      return Promise.resolve({ etag: "e" });
    }),
  };
  const collect =
    input.collect ??
    vi.fn(() =>
      Promise.resolve({
        entries: [{ bytes: new Uint8Array([1, 2, 3]), name: "data/a.json" }],
        images: input.images ?? [],
        summaries: [{ columns: ["id"], name: "a", rows: 1 }],
      })
    );
  const readAsRequester = vi.fn(
    (
      _claimed: ClaimedDataExport,
      operation: (transaction: never) => Promise<unknown>
    ) => operation({} as never)
  );
  return {
    bucket,
    client,
    collect,
    deps: {
      bucket,
      client,
      collect,
      now: () => now,
      readAsRequester,
    } as never,
    objects,
    readAsRequester,
  };
}

describe("the data export job", () => {
  it("builds the archive as the requester, stores it, records it and finishes", async () => {
    const f = fixture({});
    const report = await runDataExports(f.deps);
    expect(report).toEqual({ deleted: 0, expired: 2, failed: 0, ready: 1 });
    expect(f.readAsRequester).toHaveBeenCalledWith(
      claimed,
      expect.any(Function)
    );
    const key = `${prefix}polaris-dados-2026-10-17.zip`;
    expect([...f.objects.keys()]).toEqual([key]);
    expect(f.client.recordDataExportFile).toHaveBeenCalledWith(
      expect.objectContaining({
        exportId,
        name: "polaris-dados-2026-10-17.zip",
        ordinal: 1,
      })
    );
    expect(f.client.completeDataExport).toHaveBeenCalledWith(exportId, 24);
    expect(f.client.failDataExport).not.toHaveBeenCalled();
    expect(Array.from(f.objects.get(key)?.slice(0, 4) ?? [])).toEqual([
      0x50, 0x4b, 3, 4,
    ]);
  });

  it("takes only the requests it is allowed, and skips the sweep when asked (the queue consumer)", async () => {
    const f = fixture({
      claims: [claimed, claimed, null],
      deletable: [{ id: exportId, organizationId }],
    });
    const report = await runDataExports({
      ...(f.deps as object),
      maxExports: 1,
      sweep: false,
    } as never);
    expect(report).toEqual({ deleted: 0, expired: 0, failed: 0, ready: 1 });
    expect(f.client.claimDataExport).toHaveBeenCalledTimes(1);
    expect(f.client.expireDataExports).not.toHaveBeenCalled();
    expect(f.client.listDataExportsToDelete).not.toHaveBeenCalled();
    expect(f.client.markDataExportFilesDeleted).not.toHaveBeenCalled();
  });

  it("takes only the export a queue event names, by ID and organization, once, whatever maxExports says", async () => {
    const f = fixture({ claims: [claimed, claimed, null] });
    const report = await runDataExports({
      ...(f.deps as object),
      maxExports: 5,
      sweep: false,
      target: { exportId, organizationId },
    } as never);
    expect(report).toEqual({ deleted: 0, expired: 0, failed: 0, ready: 1 });
    expect(f.client.claimDataExportById).toHaveBeenCalledTimes(1);
    expect(f.client.claimDataExportById).toHaveBeenCalledWith(
      exportId,
      organizationId,
      960
    );
    expect(f.client.claimDataExport).not.toHaveBeenCalled();
    expect(f.client.completeDataExport).toHaveBeenCalledWith(exportId, 24);
  });

  it("builds nothing when the named export cannot be taken", async () => {
    const f = fixture({ claims: [null] });
    const report = await runDataExports({
      ...(f.deps as object),
      target: { exportId, organizationId },
    } as never);
    expect(report).toMatchObject({ failed: 0, ready: 0 });
    expect(f.client.claimDataExportById).toHaveBeenCalledTimes(1);
    expect(f.client.claimDataExport).not.toHaveBeenCalled();
    expect(f.collect).not.toHaveBeenCalled();
    expect(f.bucket.put).not.toHaveBeenCalled();
    expect(f.client.completeDataExport).not.toHaveBeenCalled();
  });

  it("only sweeps, and claims nothing, when maxExports is 0", async () => {
    const f = fixture({
      claims: [claimed],
      deletable: [{ id: exportId, organizationId }],
    });
    const report = await runDataExports({
      ...(f.deps as object),
      maxExports: 0,
    } as never);
    expect(report).toEqual({ deleted: 1, expired: 2, failed: 0, ready: 0 });
    expect(f.client.expireDataExports).toHaveBeenCalledTimes(1);
    expect(f.client.markDataExportFilesDeleted).toHaveBeenCalledWith(exportId);
    expect(f.client.claimDataExport).not.toHaveBeenCalled();
    expect(f.client.claimDataExportById).not.toHaveBeenCalled();
  });

  it("stores the images in parts after the data archive", async () => {
    const f = fixture({
      images: [{ assetId: "a1", byteSize: 3, storageKey: "media/a1.webp" }],
      objects: new Map([["media/a1.webp", new Uint8Array([9, 9, 9])]]),
    });
    await runDataExports(f.deps);
    expect(
      f.client.recordDataExportFile.mock.calls.map(([file]) => [
        file.ordinal,
        file.name,
      ])
    ).toEqual([
      [1, "polaris-dados-2026-10-17.zip"],
      [2, "polaris-imagens-2026-10-17-parte-001.zip"],
    ]);
  });

  it("clears what an earlier attempt left before it starts", async () => {
    const stale = `${prefix}polaris-dados-2026-10-16.zip`;
    const f = fixture({ objects: new Map([[stale, new Uint8Array([1])]]) });
    await runDataExports(f.deps);
    expect(f.objects.has(stale)).toBe(false);
    expect(f.objects.size).toBe(1);
  });

  it("tries again after an ordinary failure", async () => {
    const f = fixture({
      collect: vi.fn(() => Promise.reject(new Error("boom"))),
    });
    const report = await runDataExports(f.deps);
    expect(f.client.failDataExport).toHaveBeenCalledWith(
      exportId,
      "export_failed",
      false
    );
    expect(report).toMatchObject({ failed: 0, ready: 0 });
    expect(f.client.completeDataExport).not.toHaveBeenCalled();
  });

  it.each([
    ["too large", new ExportTooLargeError(), "export_too_large"],
    [
      "not authorized",
      new TenantAuthorizationError("tenant_access_denied"),
      "export_not_authorized",
    ],
  ])(
    "fails for good when retrying cannot help (%s)",
    async (_name, error, code) => {
      const f = fixture({ collect: vi.fn(() => Promise.reject(error)) });
      const report = await runDataExports(f.deps);
      expect(f.client.failDataExport).toHaveBeenCalledWith(
        exportId,
        code,
        true
      );
      expect(report.failed).toBe(1);
      expect(f.objects.size).toBe(0);
    }
  );

  it("does not stop the others when one export fails", async () => {
    const second = { ...claimed, id: "0199c2d0-0000-7000-8000-0000000000bb" };
    const f = fixture({ claims: [claimed, second, null] });
    let calls = 0;
    f.collect.mockImplementation(() => {
      calls += 1;
      return calls === 1
        ? Promise.reject(new Error("boom"))
        : Promise.resolve({ entries: [], images: [], summaries: [] });
    });
    const report = await runDataExports(f.deps);
    expect(report.ready).toBe(1);
    expect(f.client.completeDataExport).toHaveBeenCalledWith(second.id, 24);
  });

  it("removes the files of expired exports before it says they are gone", async () => {
    const id = "0199c2d0-0000-7000-8000-0000000000cc";
    const key = `exports/v1/org_2/${id}/x.zip`;
    const f = fixture({
      claims: [null],
      deletable: [{ id, organizationId: "org_2" }],
      objects: new Map([[key, new Uint8Array([1])]]),
    });
    const report = await runDataExports(f.deps);
    expect(f.objects.has(key)).toBe(false);
    expect(f.client.markDataExportFilesDeleted).toHaveBeenCalledWith(id);
    expect(report.deleted).toBe(1);
  });

  it("claims at most a couple of exports per run", async () => {
    const f = fixture({ claims: [claimed, claimed, claimed, claimed] });
    await runDataExports(f.deps);
    expect(f.client.claimDataExport).toHaveBeenCalledTimes(2);
  });
});

describe("the data export job under stress", () => {
  it("keeps going when recording a failure fails too", async () => {
    const second = { ...claimed, id: "0199c2d0-0000-7000-8000-0000000000bb" };
    const f = fixture({ claims: [claimed, second, null] });
    let calls = 0;
    f.collect.mockImplementation(() => {
      calls += 1;
      return calls === 1
        ? Promise.reject(new Error("boom"))
        : Promise.resolve({ entries: [], images: [], summaries: [] });
    });
    f.client.failDataExport.mockRejectedValueOnce(new Error("database_down"));
    const report = await runDataExports(f.deps);
    expect(report.ready).toBe(1);
    expect(f.client.completeDataExport).toHaveBeenCalledWith(second.id, 24);
  });

  it("removes what it stored when the failure comes after the first file", async () => {
    const f = fixture({});
    f.client.recordDataExportFile.mockRejectedValue(
      new TenantAuthorizationError("tenant_access_denied")
    );
    const report = await runDataExports(f.deps);
    expect(report.failed).toBe(1);
    expect(f.objects.size).toBe(0);
    expect(f.bucket.put).toHaveBeenCalledTimes(1);
  });

  it("does not start a second export when the first took most of the run", async () => {
    const times = [0, 5 * 60_000];
    const f = fixture({ claims: [claimed, claimed, null] });
    let call = 0;
    const clock = () => {
      const at = times[Math.min(call, times.length - 1)] ?? 0;
      call += 1;
      return new Date(at);
    };
    await runDataExports({ ...(f.deps as object), now: clock } as never);
    expect(f.client.claimDataExport).toHaveBeenCalledTimes(1);
  });

  it("lets go of the data files before it reads the images", async () => {
    const entries = [{ bytes: new Uint8Array([1]), name: "data/a.json" }];
    const f = fixture({
      collect: vi.fn(() =>
        Promise.resolve({
          entries,
          images: [{ assetId: "a1", byteSize: 1, storageKey: "media/a1.webp" }],
          summaries: [],
        })
      ),
      objects: new Map([["media/a1.webp", new Uint8Array([9])]]),
    });
    await runDataExports(f.deps);
    expect(entries).toHaveLength(0);
  });
});

describe("the image parts", () => {
  it("splits by size and lists what it could not include in the last part", async () => {
    const big = new Uint8Array(20 * 1024 * 1024);
    const objects = new Map<string, Uint8Array>([
      ["k1", big],
      ["k2", big],
    ]);
    const stored: { name: string; ordinal: number; size: number }[] = [];
    const result = await buildImageParts({
      bucket: {
        get: (key: string) => {
          const bytes = objects.get(key);
          return Promise.resolve(bytes ? objectOf(bytes) : null);
        },
      },
      generatedAt: now,
      images: [
        { assetId: "a", byteSize: big.length, storageKey: "k1" },
        { assetId: "b", byteSize: big.length, storageKey: "k2" },
        { assetId: "c", byteSize: 1, storageKey: "missing" },
      ],
      sink: {
        store: (part) => {
          stored.push({
            name: part.name,
            ordinal: part.ordinal,
            size: part.bytes.length,
          });
          return Promise.resolve();
        },
      },
    });
    expect(result).toEqual({ omitted: 1, parts: 2 });
    expect(stored.map((part) => part.ordinal)).toEqual([2, 3]);
    expect(stored[0]?.name).toBe("polaris-imagens-2026-10-17-parte-001.zip");
    for (const part of stored) {
      expect(part.size).toBeLessThanOrEqual(32 * 1024 * 1024);
    }
  });

  it("makes no part when there is nothing to put in it", async () => {
    const sink = { store: vi.fn(() => Promise.resolve()) };
    await expect(
      buildImageParts({
        bucket: { get: () => Promise.resolve(null) },
        generatedAt: now,
        images: [],
        sink,
      })
    ).resolves.toEqual({ omitted: 0, parts: 0 });
    expect(sink.store).not.toHaveBeenCalled();
  });
});
