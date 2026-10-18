import { describe, expect, it, vi } from "vitest";
import { deleteObjectsUnderPrefix } from "./storage-prefix";

const uploaded = new Date("2026-10-17T12:00:00.000Z");

/** In-memory bucket whose list returns `pageSize` objects per call, with a cursor, like R2. */
function fakeBucket(keys: string[], pageSize = 1000) {
  const objects = new Set(keys);
  const list = vi.fn((options: { cursor?: string; prefix: string }) => {
    const matching = [...objects]
      .filter(
        (key) =>
          key.startsWith(options.prefix) &&
          (options.cursor === undefined || key > options.cursor)
      )
      .sort();
    const page = matching.slice(0, pageSize);
    const truncated = matching.length > pageSize;
    return Promise.resolve({
      objects: page.map((key) => ({ key, uploaded })),
      truncated,
      ...(truncated ? { cursor: page.at(-1) } : {}),
    });
  });
  const remove = vi.fn((key: string) => {
    objects.delete(key);
    return Promise.resolve();
  });
  return { bucket: { delete: remove, list } as never, list, objects, remove };
}

describe("deleteObjectsUnderPrefix", () => {
  it("removes only the objects under the prefix", async () => {
    const { bucket, objects } = fakeBucket([
      "exports/v1/org_1/a/data.json",
      "exports/v1/org_1/b/data.json",
      "exports/v1/org_10/a/data.json",
      "exports/v1/org_2/a/data.json",
      "media/v2/org_1/x.jpg",
    ]);

    const removed = await deleteObjectsUnderPrefix(bucket, "exports/v1/org_1/");

    expect(removed).toBe(2);
    expect([...objects].sort()).toEqual([
      "exports/v1/org_10/a/data.json",
      "exports/v1/org_2/a/data.json",
      "media/v2/org_1/x.jpg",
    ]);
  });

  it("follows the cursor across pages and counts every removed object", async () => {
    const keys = Array.from(
      { length: 5 },
      (_, index) => `exports/v1/org_1/file-${index}`
    );
    const { bucket, list, objects } = fakeBucket(keys, 2);

    const removed = await deleteObjectsUnderPrefix(bucket, "exports/v1/org_1/");

    expect(removed).toBe(5);
    expect(objects.size).toBe(0);
    expect(list.mock.calls.map(([options]) => options.cursor)).toEqual([
      undefined,
      "exports/v1/org_1/file-1",
      "exports/v1/org_1/file-3",
    ]);
  });

  it("returns zero when run again after everything is gone", async () => {
    const { bucket, remove } = fakeBucket(["exports/v1/org_1/a"]);

    expect(await deleteObjectsUnderPrefix(bucket, "exports/v1/org_1/")).toBe(1);
    remove.mockClear();

    expect(await deleteObjectsUnderPrefix(bucket, "exports/v1/org_1/")).toBe(0);
    expect(remove).not.toHaveBeenCalled();
  });
});
