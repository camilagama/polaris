import type { ClaimedOrganizationPurge } from "@polaris/db/privacy-maintenance";
import { logger } from "@polaris/observability/logger";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runOrganizationPurges } from "./organization-purge-job";

const orgA = "org_1";
const orgB = "org_2";
const assetA = "0199c2d0-0000-7000-8000-0000000000a1";
const assetB = "0199c2d0-0000-7000-8000-0000000000b2";
const uploaded = new Date("2026-10-17T12:00:00.000Z");

const exportsA = `exports/v1/${orgA}/`;
const mediaA = `media/v2/${orgA}/`;

function claim(
  organizationId: string,
  phase: "purge" | "sweep" = "purge",
  attempt = 1
): ClaimedOrganizationPurge {
  return { attempt, organizationId, phase };
}

function seed(objects: Map<string, Uint8Array>, keys: string[]) {
  for (const key of keys) {
    objects.set(key, new Uint8Array([1]));
  }
}

function fixture(
  input: {
    claims?: (ClaimedOrganizationPurge | null)[];
    media?: Record<string, { id: string; storageKey: string }[]>;
    now?: () => Date;
    markTouched?: () => Promise<void>;
    onPurge?: (organizationId: string) => Promise<void> | void;
    recordFailure?: () => Promise<void>;
  } = {}
) {
  const objects = new Map<string, Uint8Array>();
  const claims = [...(input.claims ?? [claim(orgA), null])];
  const bucket = {
    delete: vi.fn((keys: string | string[]) => {
      for (const key of [keys].flat()) {
        objects.delete(key);
      }
      return Promise.resolve();
    }),
    list: vi.fn((options: { prefix: string }) =>
      Promise.resolve({
        objects: [...objects.keys()]
          .filter((key) => key.startsWith(options.prefix))
          .map((key) => ({ key, uploaded })),
        truncated: false,
      })
    ),
  };
  const client = {
    claimOrganizationPurge: vi.fn((_lease: number) =>
      Promise.resolve(claims.shift() ?? null)
    ),
    completeOrganizationPurgeSweep: vi.fn((_id: string) =>
      Promise.resolve(true)
    ),
    listOrganizationPurgeMedia: vi.fn((id: string) =>
      Promise.resolve(input.media?.[id] ?? [])
    ),
    markOrganizationPurgeStorageTouched: vi.fn((_id: string) =>
      input.markTouched ? input.markTouched() : Promise.resolve()
    ),
    purgeOrganizationData: vi.fn(async (id: string) => {
      await input.onPurge?.(id);
    }),
    recordOrganizationPurgeFailure: vi.fn((_id: string, _code: string) =>
      input.recordFailure ? input.recordFailure() : Promise.resolve()
    ),
  };
  const run = () =>
    runOrganizationPurges({
      bucket: bucket as never,
      client: client as never,
      now: input.now ?? (() => uploaded),
    });
  return { bucket, client, objects, run };
}

function keysUnder(objects: Map<string, Uint8Array>, ...prefixes: string[]) {
  return [...objects.keys()].filter((key) =>
    prefixes.some((prefix) => key.startsWith(prefix))
  );
}

/** The job writes through the typed logger; the tests read what it wrote and keep the output quiet. */
function quiet() {
  return {
    error: vi.spyOn(logger, "error").mockImplementation(() => undefined),
    warn: vi.spyOn(logger, "warn").mockImplementation(() => undefined),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runOrganizationPurges", () => {
  it("removes the exports, masters and derivatives of the organization before the database and then sweeps", async () => {
    const survivors = [
      `exports/v1/${orgB}/e1/data.json`,
      "exports/v1/org_10/e1/data.json",
      `media/v2/${orgB}/other.jpg`,
      "media/v2/org_10/other.jpg",
      `media/v2/${orgB}/${assetB}/master.jpg`,
      `media/derivatives/v1/${assetB}/320.webp`,
      `media/derivatives/v1/${assetB}/640.webp`,
    ];
    const seenAtPurge: string[][] = [];
    const ctx = fixture({
      media: {
        [orgA]: [{ id: assetA, storageKey: `media/v2/${orgA}/${assetA}.jpg` }],
      },
      onPurge: () => {
        seenAtPurge.push(
          keysUnder(
            ctx.objects,
            exportsA,
            mediaA,
            `media/derivatives/v1/${assetA}/`
          )
        );
      },
    });
    seed(ctx.objects, [
      `${exportsA}e1/data.json`,
      `${exportsA}e1/images-1.zip`,
      `${mediaA}${assetA}.jpg`,
      `${mediaA}orphan-upload.jpg`,
      `media/derivatives/v1/${assetA}/320.webp`,
      `media/derivatives/v1/${assetA}/640.webp`,
      ...survivors,
    ]);

    const report = await ctx.run();

    expect(report).toEqual({ failed: 0, purged: 1, swept: 1 });
    expect(seenAtPurge).toEqual([[]]);
    expect([...ctx.objects.keys()].sort()).toEqual([...survivors].sort());
    expect(ctx.client.purgeOrganizationData).toHaveBeenCalledWith(orgA);
    expect(ctx.client.completeOrganizationPurgeSweep).toHaveBeenCalledWith(
      orgA
    );
    expect(
      ctx.client.purgeOrganizationData.mock.invocationCallOrder[0]
    ).toBeLessThan(
      ctx.client.completeOrganizationPurgeSweep.mock.invocationCallOrder[0] ?? 0
    );
  });

  it("writes down that the storage is touched before the first object is removed", async () => {
    const ctx = fixture();
    seed(ctx.objects, [`${exportsA}e1/data.json`]);

    await ctx.run();

    // once before the exports, then before the images and before the sweep of their prefix (no asset here)
    expect(
      ctx.client.markOrganizationPurgeStorageTouched
    ).toHaveBeenCalledTimes(3);
    expect(ctx.client.markOrganizationPurgeStorageTouched).toHaveBeenCalledWith(
      orgA
    );
    expect(
      ctx.client.markOrganizationPurgeStorageTouched.mock.invocationCallOrder[0]
    ).toBeLessThan(ctx.bucket.list.mock.invocationCallOrder[0] ?? 0);
    expect(
      ctx.client.markOrganizationPurgeStorageTouched.mock.invocationCallOrder[0]
    ).toBeLessThan(ctx.bucket.delete.mock.invocationCallOrder[0] ?? 0);
  });

  it("leaves the storage alone when the run no longer holds the purge", async () => {
    quiet();
    const ctx = fixture({
      markTouched: () => Promise.reject(new Error("purge_not_claimed")),
    });
    seed(ctx.objects, [`${exportsA}e1/data.json`, `${mediaA}a.jpg`]);

    const report = await ctx.run();

    expect(report).toEqual({ failed: 1, purged: 0, swept: 0 });
    expect(ctx.bucket.delete).not.toHaveBeenCalled();
    expect(ctx.client.listOrganizationPurgeMedia).not.toHaveBeenCalled();
    expect(ctx.client.purgeOrganizationData).not.toHaveBeenCalled();
    expect(ctx.objects.size).toBe(2);
    // the failure is the marker's, not the storage's: nothing was touched
    expect(ctx.client.recordOrganizationPurgeFailure).toHaveBeenCalledWith(
      orgA,
      "purge_mark_storage_failed"
    );
  });

  it("asks again before every removal of images, and stops when a legal hold came in meanwhile", async () => {
    quiet();
    let marks = 0;
    const ctx = fixture({
      markTouched: () => {
        marks += 1;
        // the first mark passes; then the operator places a legal hold
        return marks === 1
          ? Promise.resolve()
          : Promise.reject(new Error("legal_hold_active"));
      },
      media: {
        [orgA]: [{ id: assetA, storageKey: `${mediaA}${assetA}.jpg` }],
      },
    });
    seed(ctx.objects, [`${exportsA}e1/data.json`, `${mediaA}${assetA}.jpg`]);

    const report = await ctx.run();

    expect(report).toEqual({ failed: 1, purged: 0, swept: 0 });
    // the exports went before the hold; no image did, and the rows stay
    expect(ctx.objects.has(`${mediaA}${assetA}.jpg`)).toBe(true);
    expect(ctx.objects.has(`${exportsA}e1/data.json`)).toBe(false);
    expect(ctx.client.purgeOrganizationData).not.toHaveBeenCalled();
    // the refusal is written by its name, so the operator reads why the purge waits
    expect(ctx.client.recordOrganizationPurgeFailure).toHaveBeenCalledWith(
      orgA,
      "legal_hold_active"
    );
  });

  it("stops before the media and the database when the exports cannot be removed", async () => {
    quiet();
    const ctx = fixture();
    seed(ctx.objects, [`${exportsA}e1/data.json`]);
    ctx.bucket.delete.mockImplementation((keys: string | string[]) =>
      [keys].flat().some((key) => key.startsWith("exports/"))
        ? Promise.reject(new Error("r2 down"))
        : Promise.resolve()
    );

    const report = await ctx.run();

    expect(report).toEqual({ failed: 1, purged: 0, swept: 0 });
    expect(ctx.client.listOrganizationPurgeMedia).not.toHaveBeenCalled();
    expect(ctx.client.purgeOrganizationData).not.toHaveBeenCalled();
    expect(ctx.client.completeOrganizationPurgeSweep).not.toHaveBeenCalled();
    expect(ctx.client.recordOrganizationPurgeFailure).toHaveBeenCalledWith(
      orgA,
      "purge_exports_storage_failed"
    );
  });

  it("records a database failure and does not complete the sweep", async () => {
    quiet();
    const ctx = fixture({
      onPurge: () => Promise.reject(new Error("db down")),
    });

    const report = await ctx.run();

    expect(report).toEqual({ failed: 1, purged: 0, swept: 0 });
    expect(ctx.client.recordOrganizationPurgeFailure).toHaveBeenCalledWith(
      orgA,
      "purge_database_failed"
    );
    expect(ctx.client.completeOrganizationPurgeSweep).not.toHaveBeenCalled();
  });

  it("removes an export written late during the second sweep", async () => {
    const { warn } = quiet();
    const ctx = fixture({
      onPurge: () => {
        seed(ctx.objects, [`${exportsA}late/data.json`]);
      },
    });

    const report = await ctx.run();

    expect(report).toEqual({ failed: 0, purged: 1, swept: 1 });
    expect(keysUnder(ctx.objects, exportsA, mediaA)).toEqual([]);
    expect(warn).toHaveBeenCalledWith("organization_purge_sweep_removed", {
      job: "organization_purge",
      objects: 1,
      organizationId: orgA,
      outcome: "partial",
    });
  });

  it("only sweeps and completes when the phase is sweep", async () => {
    const ctx = fixture({ claims: [claim(orgA, "sweep"), null] });
    seed(ctx.objects, [`${exportsA}late/data.json`, `${mediaA}late.jpg`]);

    const report = await ctx.run();

    expect(report).toEqual({ failed: 0, purged: 0, swept: 1 });
    expect(ctx.client.listOrganizationPurgeMedia).not.toHaveBeenCalled();
    expect(ctx.client.purgeOrganizationData).not.toHaveBeenCalled();
    // the purge was already past the point of no return: the sweep marks nothing
    expect(
      ctx.client.markOrganizationPurgeStorageTouched
    ).not.toHaveBeenCalled();
    expect(ctx.client.completeOrganizationPurgeSweep).toHaveBeenCalledWith(
      orgA
    );
    expect(ctx.objects.size).toBe(0);
  });

  it("takes the next purge of the run after one fails", async () => {
    quiet();
    const ctx = fixture({
      claims: [claim(orgA), claim(orgB), null],
      onPurge: (id) =>
        id === orgA ? Promise.reject(new Error("x")) : undefined,
    });

    const report = await ctx.run();

    expect(report).toEqual({ failed: 1, purged: 1, swept: 1 });
    expect(ctx.client.completeOrganizationPurgeSweep).toHaveBeenCalledTimes(1);
    expect(ctx.client.completeOrganizationPurgeSweep).toHaveBeenCalledWith(
      orgB
    );
  });

  it("takes at most three purges per run", async () => {
    const ctx = fixture({
      claims: [
        claim("org_1"),
        claim("org_2"),
        claim("org_3"),
        claim("org_4"),
        null,
      ],
    });

    const report = await ctx.run();

    expect(report).toEqual({ failed: 0, purged: 3, swept: 3 });
    expect(ctx.client.claimOrganizationPurge).toHaveBeenCalledTimes(3);
  });

  it("does not start another purge after four minutes", async () => {
    let clock = uploaded.getTime();
    const ctx = fixture({
      claims: [claim("org_1"), claim("org_2"), null],
      now: () => new Date(clock),
      onPurge: () => {
        clock += 4 * 60_000 + 1;
      },
    });

    const report = await ctx.run();

    expect(report).toEqual({ failed: 0, purged: 1, swept: 1 });
    expect(ctx.client.claimOrganizationPurge).toHaveBeenCalledTimes(1);
  });

  it("still starts another purge at exactly four minutes", async () => {
    let clock = uploaded.getTime();
    const ctx = fixture({
      claims: [claim("org_1"), claim("org_2"), null],
      now: () => new Date(clock),
      onPurge: () => {
        clock += 4 * 60_000;
      },
    });

    const report = await ctx.run();

    expect(report.purged).toBe(2);
  });

  it("survives a failure that cannot be recorded", async () => {
    const { error } = quiet();
    const ctx = fixture({
      claims: [claim(orgA), claim(orgB), null],
      onPurge: (id) =>
        id === orgA ? Promise.reject(new Error("x")) : undefined,
      recordFailure: () => Promise.reject(new Error("db down")),
    });

    const report = await ctx.run();

    expect(report).toEqual({ failed: 1, purged: 1, swept: 1 });
    expect(error).toHaveBeenCalledWith(
      "organization_purge_failure_not_recorded",
      { job: "organization_purge", organizationId: orgA, outcome: "failure" }
    );
  });

  it("does not log the message of the error", async () => {
    const { error, warn } = quiet();
    const ctx = fixture({
      onPurge: () => Promise.reject(new Error("segredo-xyz")),
      recordFailure: () => Promise.reject(new Error("segredo-xyz")),
    });

    await ctx.run();

    expect(error).toHaveBeenCalledWith(
      "organization_purge_step_failed",
      expect.objectContaining({
        attempt: 1,
        job: "organization_purge",
        organizationId: orgA,
        outcome: "failure",
        reason: "purge_database_failed",
        operation: "organization_purge.database",
      })
    );
    expect(
      JSON.stringify([...error.mock.calls, ...warn.mock.calls])
    ).not.toContain("segredo-xyz");
  });

  it("reports a purge that fails for the third attempt as stalled, besides the failed step", async () => {
    const { error, warn } = quiet();
    const ctx = fixture({
      claims: [claim(orgA, "purge", 3), null],
      onPurge: () => Promise.reject(new Error("segredo-xyz")),
    });

    await ctx.run();

    expect(error).toHaveBeenCalledWith("organization_purge_stalled", {
      attempt: 3,
      job: "organization_purge",
      operation: "organization_purge.database",
      organizationId: orgA,
      outcome: "failure",
      phase: "purge",
      reason: "purge_database_failed",
    });
    expect(error).toHaveBeenCalledWith(
      "organization_purge_step_failed",
      expect.objectContaining({ attempt: 3 })
    );
    expect(
      JSON.stringify([...error.mock.calls, ...warn.mock.calls])
    ).not.toContain("segredo-xyz");
  });

  it("does not report as stalled a purge on its second attempt, one that succeeds on its third, or one held on purpose", async () => {
    for (const { attempt, onPurge } of [
      { attempt: 2, onPurge: () => Promise.reject(new Error("boom")) },
      { attempt: 3, onPurge: () => Promise.resolve() },
      {
        attempt: 5,
        onPurge: () => Promise.reject(new Error("legal_hold_active")),
      },
      {
        attempt: 5,
        onPurge: () => Promise.reject(new Error("tenant_access_active")),
      },
    ]) {
      const { error, warn } = quiet();
      const ctx = fixture({
        claims: [claim(orgA, "purge", attempt), null],
        onPurge,
      });

      // biome-ignore lint/performance/noAwaitInLoops: one case at a time, each with its own fixture
      await ctx.run();

      expect(
        [...error.mock.calls, ...warn.mock.calls].map(([event]) => event)
      ).not.toContain("organization_purge_stalled");
      vi.restoreAllMocks();
    }
  });

  it("logs a purge held by a legal hold as a refusal, with its code", async () => {
    const { error, warn } = quiet();
    const ctx = fixture({
      onPurge: () => Promise.reject(new Error("legal_hold_active")),
    });

    await ctx.run();

    expect(warn).toHaveBeenCalledWith("organization_purge_step_failed", {
      attempt: 1,
      job: "organization_purge",
      organizationId: orgA,
      outcome: "rejected",
      reason: "legal_hold_active",
      operation: "organization_purge.database",
    });
    expect(error).not.toHaveBeenCalled();
  });

  it("logs a purge held when it runs by a temporary access, a live renewal or a notice not delivered as a refusal, with its code", async () => {
    for (const code of [
      "tenant_access_active",
      "renewal_alive",
      "closure_notice_not_delivered",
    ]) {
      const { error, warn } = quiet();
      const ctx = fixture({
        onPurge: () => Promise.reject(new Error(code)),
      });

      // biome-ignore lint/performance/noAwaitInLoops: one code at a time, each with its own fixture
      await ctx.run();

      expect(warn).toHaveBeenCalledWith("organization_purge_step_failed", {
        attempt: 1,
        job: "organization_purge",
        organizationId: orgA,
        outcome: "rejected",
        reason: code,
        operation: "organization_purge.database",
      });
      expect(ctx.client.recordOrganizationPurgeFailure).toHaveBeenCalledWith(
        orgA,
        code
      );
      expect(error).not.toHaveBeenCalled();
      vi.restoreAllMocks();
    }
  });

  it("stops before the database when a listed master is outside the organization's prefix", async () => {
    const ctx = fixture({
      media: {
        [orgA]: [{ id: assetA, storageKey: `media/v2/${orgB}/${assetA}.jpg` }],
      },
    });
    seed(ctx.objects, [`media/v2/${orgB}/${assetA}.jpg`]);

    const report = await ctx.run();

    expect(report).toEqual({ failed: 1, purged: 0, swept: 0 });
    expect(ctx.objects.has(`media/v2/${orgB}/${assetA}.jpg`)).toBe(true);
    expect(ctx.client.purgeOrganizationData).not.toHaveBeenCalled();
    expect(ctx.client.recordOrganizationPurgeFailure).toHaveBeenCalledWith(
      orgA,
      "purge_media_storage_failed"
    );
  });

  it("removes the images' keys in batches, a few calls for thousands of images", async () => {
    const assets = Array.from({ length: 700 }, (_, index) => ({
      id: `0199c2d0-0000-7000-8000-${index.toString(16).padStart(12, "0")}`,
      storageKey: `${mediaA}${index}.webp`,
    }));
    const ctx = fixture({ media: { [orgA]: assets } });

    await ctx.run();

    // 2100 keys (master and two derivatives each) go in three calls of at most 1000
    const batches = ctx.bucket.delete.mock.calls
      .map(([keys]) => keys)
      .filter(
        (keys): keys is string[] => Array.isArray(keys) && keys.length > 0
      );
    expect(batches.map((keys) => keys.length)).toEqual([1000, 1000, 100]);
    expect(ctx.client.purgeOrganizationData).toHaveBeenCalledWith(orgA);
  });
});
