import { describe, expect, it } from "vitest";
import type { NamespaceKey } from "./namespace";
import {
  finishSaleRedo,
  pruneSaleRedos,
  readSaleRedos,
  redoneCommandIds,
  SALE_REDO_KEY_PREFIX,
  startSaleRedo,
} from "./sale-redo-storage";

const KEY = "0199c2d0-0000-7000-8000-00000000a001" as NamespaceKey;
const OTHER_KEY = "0199c2d0-0000-7000-8000-00000000a002" as NamespaceKey;
const USER_A_KEY = "2f0c1d9e5a7b4c3d8e6f1a2b3c4d5e6f" as NamespaceKey;
const USER_B_KEY = "9a8b7c6d5e4f30211203f4e5d6c7b8a9" as NamespaceKey;
const A = "0199c2d0-0000-7000-8000-0000000000a1";
const B = "0199c2d0-0000-7000-8000-0000000000b1";
const NEW = "0199c2d0-0000-7000-8000-0000000000c1";

function memory() {
  const map = new Map<string, string>();
  return Object.assign(map, {
    getItem: (key: string) => map.get(key) ?? null,
    removeItem: (key: string) => {
      map.delete(key);
    },
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  });
}

describe("the link between a refused sale and the sale that redoes it", () => {
  it("is open until the draft it started is confirmed, then the refused sale counts as redone", () => {
    const storage = memory();
    startSaleRedo(storage, KEY, A, "2026-11-02T10:00:00.000Z");
    expect(redoneCommandIds(readSaleRedos(storage, KEY), []).size).toBe(0);

    expect(finishSaleRedo(storage, KEY, "2026-11-02T10:00:00.000Z", NEW)).toBe(
      true
    );

    expect(readSaleRedos(storage, KEY)).toEqual([
      {
        redoneCommandId: NEW,
        refusedCommandId: A,
        startedAt: "2026-11-02T10:00:00.000Z",
      },
    ]);
    expect([...redoneCommandIds(readSaleRedos(storage, KEY), [])]).toEqual([A]);
  });

  it("is not finished by a draft that is not the redo, nor with no draft", () => {
    const storage = memory();
    startSaleRedo(storage, KEY, A, "2026-11-02T10:00:00.000Z");
    expect(finishSaleRedo(storage, KEY, "2026-11-02T11:00:00.000Z", NEW)).toBe(
      false
    );
    expect(finishSaleRedo(storage, KEY, null, NEW)).toBe(false);
    expect(redoneCommandIds(readSaleRedos(storage, KEY), []).size).toBe(0);
  });

  it("is finished once: a second confirmation of the same draft start does not take the link over", () => {
    const storage = memory();
    startSaleRedo(storage, KEY, A, "t1");
    expect(finishSaleRedo(storage, KEY, "t1", NEW)).toBe(true);
    expect(finishSaleRedo(storage, KEY, "t1", "other-command")).toBe(false);
    expect(readSaleRedos(storage, KEY)[0]?.redoneCommandId).toBe(NEW);
  });

  it("keeps the open redo of another refused sale (another tab) and replaces only its own", () => {
    const storage = memory();
    startSaleRedo(storage, KEY, A, "t1");
    startSaleRedo(storage, KEY, B, "t2");
    startSaleRedo(storage, KEY, A, "t3");
    expect(
      readSaleRedos(storage, KEY).map((redo) => [
        redo.refusedCommandId,
        redo.startedAt,
      ])
    ).toEqual([
      [B, "t2"],
      [A, "t3"],
    ]);
    expect(finishSaleRedo(storage, KEY, "t2", NEW)).toBe(true);
  });

  it("never opens the redo of a sale already redone", () => {
    const storage = memory();
    startSaleRedo(storage, KEY, A, "t1");
    finishSaleRedo(storage, KEY, "t1", NEW);
    expect(startSaleRedo(storage, KEY, A, "t2")).toBe(false);
    expect(readSaleRedos(storage, KEY)).toHaveLength(1);
  });

  it("does not count as redone a new sale the server refused in its turn", () => {
    const storage = memory();
    startSaleRedo(storage, KEY, A, "t1");
    finishSaleRedo(storage, KEY, "t1", NEW);
    const redos = readSaleRedos(storage, KEY);
    expect([
      ...redoneCommandIds(redos, [{ commandId: NEW, status: "pending" }]),
    ]).toEqual([A]);
    expect([
      ...redoneCommandIds(redos, [{ commandId: NEW, status: "rejected" }]),
    ]).toEqual([]);
  });

  it("forgets what is not in the queue any more, and is per namespace", () => {
    const storage = memory();
    startSaleRedo(storage, KEY, A, "t1");
    finishSaleRedo(storage, KEY, "t1", NEW);
    startSaleRedo(storage, OTHER_KEY, A, "t9");
    pruneSaleRedos(storage, KEY, new Set([B]));
    expect(readSaleRedos(storage, KEY)).toEqual([]);
    expect(storage.has(`${SALE_REDO_KEY_PREFIX}${KEY}`)).toBe(false);
    expect(readSaleRedos(storage, OTHER_KEY)).toHaveLength(1);
  });

  it("keeps the link of one user when another user of the same store prunes with a queue that lacks the command", () => {
    const storage = memory();
    startSaleRedo(storage, USER_A_KEY, A, "t1");
    finishSaleRedo(storage, USER_A_KEY, "t1", NEW);

    pruneSaleRedos(storage, USER_B_KEY, new Set([B]));

    const redos = readSaleRedos(storage, USER_A_KEY);
    expect(redos).toHaveLength(1);
    expect([
      ...redoneCommandIds(redos, [{ commandId: A, status: "rejected" }]),
    ]).toEqual([A]);
    expect(startSaleRedo(storage, USER_A_KEY, A, "t2")).toBe(false);
    expect(readSaleRedos(storage, USER_B_KEY)).toEqual([]);
  });

  it("reads a damaged value as nothing, and works without storage", () => {
    const storage = memory();
    storage.set(`${SALE_REDO_KEY_PREFIX}${KEY}`, "{not json");
    expect(readSaleRedos(storage, KEY)).toEqual([]);
    storage.set(
      `${SALE_REDO_KEY_PREFIX}${KEY}`,
      JSON.stringify([{ refusedCommandId: 1 }, "x"])
    );
    expect(readSaleRedos(storage, KEY)).toEqual([]);
    expect(readSaleRedos(null, KEY)).toEqual([]);
    expect(() => startSaleRedo(null, KEY, A, "t")).not.toThrow();
  });
});
