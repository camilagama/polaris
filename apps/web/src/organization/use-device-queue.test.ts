import { describe, expect, it } from "vitest";
import type { LogoutWorkspace } from "../offline/logout-guard";
import { readClosedQueueOnDisk, readQueueOnDisk } from "./use-device-queue";

const STORE = "0199c2d0-0000-7000-8000-00000000a001";

function workspace(
  label: string,
  counts: { pending: number; rejected: number; sending: number },
  released: string[]
): LogoutWorkspace {
  return {
    label,
    outbox: {
      snapshot: () =>
        Promise.resolve({ ...counts, blockedBy: null, commands: [] }),
    } as unknown as LogoutWorkspace["outbox"],
    purge: () => Promise.reject(new Error("never purged here")),
    release: () => {
      released.push(label);
    },
    trySync: () => Promise.reject(new Error("never sent here")),
  };
}

const yes = () => Promise.resolve(true);
const no = () => Promise.resolve(false);

describe("the queue of the store read from the disk (AC-3)", () => {
  it("counts only the store's own workspace, and releases every one it opened", async () => {
    const released: string[] = [];
    const state = await readQueueOnDisk(
      [
        workspace(STORE, { pending: 1, rejected: 1, sending: 0 }, released),
        workspace(
          `${STORE}2 (outra loja)`,
          { pending: 5, rejected: 0, sending: 0 },
          released
        ),
      ],
      STORE,
      yes
    );
    expect(state).toEqual({
      counts: { pending: 1, rejected: 1, sending: 0 },
      kind: "counted",
    });
    expect(released).toHaveLength(2);
  });

  it("with no workspace and a queue on the disk, says it could not read it, never that it is empty", async () => {
    expect(await readQueueOnDisk([], STORE, yes)).toEqual({
      kind: "unreadable",
    });
  });

  it("with no workspace and no queue on the disk at all, holds nothing", async () => {
    expect(await readQueueOnDisk([], STORE, no)).toEqual({
      counts: { pending: 0, rejected: 0, sending: 0 },
      kind: "counted",
    });
  });
});

describe("o tipo de cada operação da fila lida (AC-7)", () => {
  it("conta vendas, cadastros e o resto só da loja pedida", async () => {
    const commands = (types: string[]) =>
      types.map((type) => ({ type })) as unknown[];
    const ws = (label: string, types: string[]): LogoutWorkspace => ({
      ...workspace(
        label,
        { pending: types.length, rejected: 0, sending: 0 },
        []
      ),
      outbox: {
        snapshot: () =>
          Promise.resolve({
            blockedBy: null,
            commands: commands(types),
            pending: types.length,
            rejected: 0,
            sending: 0,
          }),
      } as unknown as LogoutWorkspace["outbox"],
    });
    const state = await readClosedQueueOnDisk(
      [
        ws(STORE, ["sale.confirm", "customer.create", "stock.receive"]),
        ws(`${STORE}2 (outra loja)`, ["sale.confirm", "sale.confirm"]),
      ],
      STORE,
      yes
    );
    expect(state).toEqual({
      counts: { pending: 3, rejected: 0, sending: 0 },
      kind: "counted",
      kinds: { others: 1, registers: 1, sales: 1 },
    });
  });
});
