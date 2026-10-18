import type { ClaimedOrganizationPurge } from "@polaris/db/privacy-maintenance";
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
  phase: "purge" | "sweep" = "purge"
): ClaimedOrganizationPurge {
  return { attempt: 1, organizationId, phase };
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
    onPurge?: (organizationId: string) => Promise<void> | void;
    recordFailure?: () => Promise<void>;
  } = {}
) {
  const objects = new Map<string, Uint8Array>();
  const claims = [...(input.claims ?? [claim(orgA), null])];
  const bucket = {
    delete: vi.fn((key: string) => {
      objects.delete(key);
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

  it("stops before the media and the database when the exports cannot be removed", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const ctx = fixture();
    seed(ctx.objects, [`${exportsA}e1/data.json`]);
    ctx.bucket.delete.mockImplementation((key: string) =>
      key.startsWith("exports/")
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
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
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
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const ctx = fixture({
      onPurge: () => {
        seed(ctx.objects, [`${exportsA}late/data.json`]);
      },
    });

    const report = await ctx.run();

    expect(report).toEqual({ failed: 0, purged: 1, swept: 1 });
    expect(keysUnder(ctx.objects, exportsA, mediaA)).toEqual([]);
    expect(warn).toHaveBeenCalledWith("organization_purge_sweep_removed", {
      objects: 1,
    });
  });

  it("only sweeps and completes when the phase is sweep", async () => {
    const ctx = fixture({ claims: [claim(orgA, "sweep"), null] });
    seed(ctx.objects, [`${exportsA}late/data.json`, `${mediaA}late.jpg`]);

    const report = await ctx.run();

    expect(report).toEqual({ failed: 0, purged: 0, swept: 1 });
    expect(ctx.client.listOrganizationPurgeMedia).not.toHaveBeenCalled();
    expect(ctx.client.purgeOrganizationData).not.toHaveBeenCalled();
    expect(ctx.client.completeOrganizationPurgeSweep).toHaveBeenCalledWith(
      orgA
    );
    expect(ctx.objects.size).toBe(0);
  });

  it("takes the next purge of the run after one fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
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
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const ctx = fixture({
      claims: [claim(orgA), claim(orgB), null],
      onPurge: (id) =>
        id === orgA ? Promise.reject(new Error("x")) : undefined,
      recordFailure: () => Promise.reject(new Error("db down")),
    });

    const report = await ctx.run();

    expect(report).toEqual({ failed: 1, purged: 1, swept: 1 });
    expect(warn).toHaveBeenCalledWith(
      "organization_purge_failure_not_recorded",
      {
        organizationId: orgA,
      }
    );
  });

  it("does not log the message of the error", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const ctx = fixture({
      onPurge: () => Promise.reject(new Error("segredo-xyz")),
      recordFailure: () => Promise.reject(new Error("segredo-xyz")),
    });

    await ctx.run();

    expect(warn).toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toContain("segredo-xyz");
  });
});
