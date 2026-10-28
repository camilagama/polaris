import { describe, expect, it } from "vitest";
import {
  isWritePath,
  subscribeWrites,
  trackWrite,
  writesInFlight,
} from "./writes-in-flight";

describe("as escritas a caminho do servidor (seguram a troca de build)", () => {
  it("uma leitura nunca conta; uma escrita, um envio em lote e um procedimento desconhecido contam", () => {
    expect(isWritePath(["sale", "list"])).toBe(false);
    expect(isWritePath(["sync", "pull"])).toBe(false);
    expect(isWritePath(["sale", "confirm"])).toBe(true);
    expect(isWritePath(["product", "importBatch"])).toBe(true);
    expect(isWritePath(["novo", "procedimento"])).toBe(true);
  });

  it("conta a escrita enquanto ela não responde, e desconta na resposta e no erro", async () => {
    let heard = 0;
    const stop = subscribeWrites(() => {
      heard += 1;
    });
    let answer: (value: string) => void = () => undefined;
    const call = trackWrite(
      ["sale", "confirm"],
      () =>
        new Promise<string>((resolve) => {
          answer = resolve;
        })
    );
    expect(writesInFlight()).toBe(1);
    const read = trackWrite(["sale", "list"], () => Promise.resolve("lista"));
    expect(writesInFlight()).toBe(1);
    await read;
    answer("ok");
    await expect(call).resolves.toBe("ok");
    expect(writesInFlight()).toBe(0);

    await expect(
      trackWrite(["sale", "confirm"], () => Promise.reject(new Error("rede")))
    ).rejects.toThrow("rede");
    expect(writesInFlight()).toBe(0);
    stop();
    expect(heard).toBe(4);
  });
});
