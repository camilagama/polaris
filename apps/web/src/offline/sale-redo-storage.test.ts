import { describe, expect, it } from "vitest";
import {
  finishSaleRedo,
  pruneSaleRedos,
  readSaleRedos,
  redoneCommandIds,
  SALE_REDO_KEY_PREFIX,
  startSaleRedo,
} from "./sale-redo-storage";

const ORG = "0199c2d0-0000-7000-8000-00000000a001";
const OTHER = "0199c2d0-0000-7000-8000-00000000a002";
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
    startSaleRedo(storage, ORG, A, "2026-11-02T10:00:00.000Z");
    expect(redoneCommandIds(readSaleRedos(storage, ORG), []).size).toBe(0);

    expect(finishSaleRedo(storage, ORG, "2026-11-02T10:00:00.000Z", NEW)).toBe(
      true
    );

    expect(readSaleRedos(storage, ORG)).toEqual([
      {
        redoneCommandId: NEW,
        refusedCommandId: A,
        startedAt: "2026-11-02T10:00:00.000Z",
      },
    ]);
    expect([...redoneCommandIds(readSaleRedos(storage, ORG), [])]).toEqual([A]);
  });

  it("is not finished by a draft that is not the redo, nor with no draft", () => {
    const storage = memory();
    startSaleRedo(storage, ORG, A, "2026-11-02T10:00:00.000Z");
    expect(finishSaleRedo(storage, ORG, "2026-11-02T11:00:00.000Z", NEW)).toBe(
      false
    );
    expect(finishSaleRedo(storage, ORG, null, NEW)).toBe(false);
    expect(redoneCommandIds(readSaleRedos(storage, ORG), []).size).toBe(0);
  });

  it("is finished once: a second confirmation of the same draft start does not take the link over", () => {
    const storage = memory();
    startSaleRedo(storage, ORG, A, "t1");
    expect(finishSaleRedo(storage, ORG, "t1", NEW)).toBe(true);
    expect(finishSaleRedo(storage, ORG, "t1", "other-command")).toBe(false);
    expect(readSaleRedos(storage, ORG)[0]?.redoneCommandId).toBe(NEW);
  });

  it("keeps the open redo of another refused sale (another tab) and replaces only its own", () => {
    const storage = memory();
    startSaleRedo(storage, ORG, A, "t1");
    startSaleRedo(storage, ORG, B, "t2");
    startSaleRedo(storage, ORG, A, "t3");
    expect(
      readSaleRedos(storage, ORG).map((redo) => [
        redo.refusedCommandId,
        redo.startedAt,
      ])
    ).toEqual([
      [B, "t2"],
      [A, "t3"],
    ]);
    expect(finishSaleRedo(storage, ORG, "t2", NEW)).toBe(true);
  });

  it("never opens the redo of a sale already redone", () => {
    const storage = memory();
    startSaleRedo(storage, ORG, A, "t1");
    finishSaleRedo(storage, ORG, "t1", NEW);
    expect(startSaleRedo(storage, ORG, A, "t2")).toBe(false);
    expect(readSaleRedos(storage, ORG)).toHaveLength(1);
  });

  it("does not count as redone a new sale the server refused in its turn", () => {
    const storage = memory();
    startSaleRedo(storage, ORG, A, "t1");
    finishSaleRedo(storage, ORG, "t1", NEW);
    const redos = readSaleRedos(storage, ORG);
    expect([
      ...redoneCommandIds(redos, [{ commandId: NEW, status: "pending" }]),
    ]).toEqual([A]);
    expect([
      ...redoneCommandIds(redos, [{ commandId: NEW, status: "rejected" }]),
    ]).toEqual([]);
  });

  it("forgets what is not in the queue any more, and is per store", () => {
    const storage = memory();
    startSaleRedo(storage, ORG, A, "t1");
    finishSaleRedo(storage, ORG, "t1", NEW);
    startSaleRedo(storage, OTHER, A, "t9");
    pruneSaleRedos(storage, ORG, new Set([B]));
    expect(readSaleRedos(storage, ORG)).toEqual([]);
    expect(storage.has(`${SALE_REDO_KEY_PREFIX}${ORG}`)).toBe(false);
    expect(readSaleRedos(storage, OTHER)).toHaveLength(1);
  });

  it("reads a damaged value as nothing, and works without storage", () => {
    const storage = memory();
    storage.set(`${SALE_REDO_KEY_PREFIX}${ORG}`, "{not json");
    expect(readSaleRedos(storage, ORG)).toEqual([]);
    storage.set(
      `${SALE_REDO_KEY_PREFIX}${ORG}`,
      JSON.stringify([{ refusedCommandId: 1 }, "x"])
    );
    expect(readSaleRedos(storage, ORG)).toEqual([]);
    expect(readSaleRedos(null, ORG)).toEqual([]);
    expect(() => startSaleRedo(null, ORG, A, "t")).not.toThrow();
  });
});
