import { describe, expect, it } from "vitest";
import { ThumbnailCache } from "./thumbnail-cache";
import { ThumbnailLoader } from "./thumbnail-queue";
import type {
  ThumbnailBatchResult,
  ThumbnailTransport,
} from "./thumbnail-transport";

/**
 * The queue of thumbnail requests, with the network, the clock and the connection simulated: what is asked, when,
 * and what is never asked.
 */
const settle = async () => {
  for (let round = 0; round < 6; round += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: each round lets the promises of the previous one run
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
};

class FakeClock {
  now = 0;
  private timers: { at: number; callback: () => void; id: number }[] = [];
  private next = 0;

  schedule = (callback: () => void, delayMs: number) => {
    this.next += 1;
    const id = this.next;
    this.timers.push({ at: this.now + delayMs, callback, id });
    return () => {
      this.timers = this.timers.filter((timer) => timer.id !== id);
    };
  };

  pending(): number {
    return this.timers.length;
  }

  async advance(ms: number): Promise<void> {
    const until = this.now + ms;
    for (;;) {
      const [due] = this.timers
        .filter((timer) => timer.at <= until)
        .sort((a, b) => a.at - b.at);
      if (!due) {
        break;
      }
      this.timers = this.timers.filter((timer) => timer.id !== due.id);
      this.now = due.at;
      due.callback();
      // biome-ignore lint/performance/noAwaitInLoops: a timer may schedule the next one
      await settle();
    }
    this.now = until;
  }
}

class FakeConnection {
  online = true;
  private readonly listeners = new Set<() => void>();
  isOnline = () => this.online;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  set(online: boolean) {
    this.online = online;
    for (const listener of this.listeners) {
      listener();
    }
  }
}

const BLOB_URL = /^blob:/;

const bytes = (id: string) => new Blob([`webp:${id}`], { type: "image/webp" });

function served(missing: ReadonlySet<string> = new Set()): ThumbnailTransport {
  return ({ ids }) =>
    Promise.resolve({
      items: new Map(ids.map((id) => [id, missing.has(id) ? null : bytes(id)])),
      kind: "ok",
    });
}

function setup(
  options: {
    answer?: ThumbnailTransport;
    cache?: ThumbnailCache;
    online?: boolean;
  } = {}
) {
  const clock = new FakeClock();
  const connection = new FakeConnection();
  connection.online = options.online ?? true;
  const calls: string[][] = [];
  const answer = options.answer ?? served();
  let urls = 0;
  const cache =
    options.cache ??
    new ThumbnailCache({
      createUrl: () => {
        urls += 1;
        return `blob:thumb-${urls}`;
      },
      disk: null,
      now: () => clock.now,
      revokeUrl: () => undefined,
    });
  const transport: ThumbnailTransport = (input) => {
    calls.push([...input.ids]);
    return answer(input);
  };
  const loader = new ThumbnailLoader({
    cache,
    isOnline: connection.isOnline,
    organizationId: "org-1",
    random: () => 0.5,
    schedule: clock.schedule,
    subscribeOnline: connection.subscribe,
    transport,
  });
  return { cache, calls, clock, connection, loader };
}

const assetIds = (count: number, prefix = "a") =>
  Array.from({ length: count }, (_, index) => `${prefix}${index}`);

describe("ThumbnailLoader", () => {
  it("rolar 1.248 linhas de cima a baixo faz no máximo 52 pedidos, de até 24 ids, sem repetir id", async () => {
    const { calls, loader } = setup();
    const list = assetIds(1248);
    loader.setSequence(list);
    const shown = new Map<string, () => void>();
    const windowSize = 9;
    for (let top = 0; top + windowSize <= list.length; top += 3) {
      const onScreen = new Set(list.slice(top, top + windowSize));
      for (const [id, hide] of shown) {
        if (!onScreen.has(id)) {
          hide();
          shown.delete(id);
        }
      }
      for (const id of onScreen) {
        if (!shown.has(id)) {
          shown.set(id, loader.show(id));
        }
      }
      // biome-ignore lint/performance/noAwaitInLoops: one step of the scroll after the other
      await settle();
    }
    expect(calls.length).toBeLessThanOrEqual(52);
    expect(Math.max(...calls.map((batch) => batch.length))).toBeLessThanOrEqual(
      24
    );
    const asked = calls.flat();
    expect(new Set(asked).size).toBe(asked.length);
    expect(loader.url("a1247")).not.toBeNull();
  });

  it("com o pedido ainda em voo enquanto a lista rola, nunca há dois lotes ao mesmo tempo e o teto se mantém", async () => {
    const pending: (() => void)[] = [];
    let inFlight = 0;
    let most = 0;
    const answer: ThumbnailTransport = (input) => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      return new Promise<ThumbnailBatchResult>((resolve) => {
        pending.push(() => {
          inFlight -= 1;
          resolve({
            items: new Map(input.ids.map((id) => [id, bytes(id)])),
            kind: "ok",
          });
        });
      });
    };
    const { calls, loader } = setup({ answer });
    const list = assetIds(1248);
    loader.setSequence(list);
    for (let top = 0; top + 9 <= list.length; top += 2) {
      const hides = list.slice(top, top + 9).map((id) => loader.show(id));
      // biome-ignore lint/performance/noAwaitInLoops: one step of the scroll after the other
      await settle();
      if (top % 10 === 0) {
        pending.shift()?.();
        await settle();
      }
      for (const hide of hides) {
        hide();
      }
    }
    expect(most).toBe(1);
    expect(calls.length).toBeLessThanOrEqual(52);
  });

  it("sem linha na tela nada é pedido, mesmo com a lista inteira conhecida (sem pré-carga)", async () => {
    const { calls, clock, loader } = setup();
    loader.setSequence(assetIds(1248));
    await settle();
    await clock.advance(120_000);
    expect(calls).toEqual([]);
  });

  it("um id já no cache não é pedido de novo, nem por outra linha nem depois de sair e voltar à tela", async () => {
    const { calls, loader } = setup();
    const hide = loader.show("a1");
    await settle();
    expect(calls).toEqual([["a1"]]);
    hide();
    loader.show("a1");
    loader.show("a1");
    await settle();
    expect(calls).toHaveLength(1);
    expect(loader.url("a1")).toMatch(BLOB_URL);
  });

  it("o lote é completado com as próximas linhas que faltam, e não com as que já estão no cache", async () => {
    const { calls, loader } = setup();
    const list = assetIds(60);
    loader.setSequence(list);
    const first = loader.show("a3");
    await settle();
    expect(calls[0]).toEqual(list.slice(3, 27));
    first();
    loader.show("a2");
    loader.show("a26");
    await settle();
    expect(calls[1]).toEqual(["a2", ...list.slice(27, 50)]);
    expect(calls[1]).toHaveLength(24);
  });

  it("id sem miniatura (missing) fica no marcador e não volta a ser pedido", async () => {
    const { calls, clock, connection, loader } = setup({
      answer: served(new Set(["a1"])),
    });
    loader.show("a1");
    await settle();
    expect(loader.url("a1")).toBeNull();
    connection.set(false);
    connection.set(true);
    await clock.advance(600_000);
    loader.show("a1");
    await settle();
    expect(calls).toEqual([["a1"]]);
  });

  it("offline nada é pedido; ao voltar a conexão, as linhas na tela pedem uma vez", async () => {
    const { calls, clock, connection, loader } = setup({ online: false });
    loader.show("a1");
    loader.show("a2");
    await settle();
    await clock.advance(600_000);
    expect(calls).toEqual([]);
    connection.set(true);
    await settle();
    expect(calls).toEqual([["a1", "a2"]]);
    connection.set(true);
    await clock.advance(600_000);
    expect(calls).toHaveLength(1);
  });

  it("falha de rede devolve os ids à fila com espera crescente e para depois de 3 tentativas, sem laço", async () => {
    const { calls, clock, loader } = setup({
      answer: () => Promise.resolve({ kind: "failed" }),
    });
    loader.show("a1");
    await settle();
    expect(calls).toHaveLength(1);
    await clock.advance(999);
    expect(calls).toHaveLength(1);
    await clock.advance(1001);
    expect(calls).toHaveLength(2);
    await clock.advance(3999);
    expect(calls).toHaveLength(2);
    await clock.advance(1);
    expect(calls).toHaveLength(3);
    await clock.advance(3_600_000);
    expect(calls).toHaveLength(3);
    expect(clock.pending()).toBe(0);
    expect(loader.url("a1")).toBeNull();
  });

  it("depois de desistir, a volta da conexão pede uma vez de novo", async () => {
    const network: { fail: boolean } = { fail: true };
    const { calls, clock, connection, loader } = setup({
      answer: (input) =>
        network.fail ? Promise.resolve({ kind: "failed" }) : served()(input),
    });
    loader.show("a1");
    await settle();
    await clock.advance(3_600_000);
    expect(calls).toHaveLength(3);
    network.fail = false;
    connection.set(false);
    connection.set(true);
    await settle();
    expect(calls).toHaveLength(4);
    expect(loader.url("a1")).toMatch(BLOB_URL);
  });

  it("tempo esgotado cancela o pedido e conta como falha", async () => {
    const signals: AbortSignal[] = [];
    const { calls, clock, loader } = setup({
      answer: (input) => {
        signals.push(input.signal);
        return new Promise((resolve) => {
          input.signal.addEventListener("abort", () =>
            resolve({ kind: "failed" })
          );
        });
      },
    });
    loader.show("a1");
    await settle();
    await clock.advance(15_000);
    const [signal] = signals;
    expect(signal?.aborted).toBe(true);
    expect((signal?.reason as DOMException | undefined)?.name).toBe(
      "TimeoutError"
    );
    await clock.advance(2000);
    expect(calls).toHaveLength(2);
    expect(loader.url("a1")).toBeNull();
  });

  it("recusa (401, 403) para de pedir para este carregador e deixa o marcador", async () => {
    const { calls, clock, connection, loader } = setup({
      answer: () => Promise.resolve({ kind: "refused" }),
    });
    loader.show("a1");
    await settle();
    loader.show("a2");
    connection.set(false);
    connection.set(true);
    await clock.advance(3_600_000);
    expect(calls).toEqual([["a1"]]);
    expect(loader.url("a2")).toBeNull();
  });

  it("um transporte que lança não derruba nada: conta como falha", async () => {
    const { calls, clock, loader } = setup({
      answer: () => Promise.reject(new Error("boom")),
    });
    loader.show("a1");
    await settle();
    await clock.advance(2000);
    expect(calls).toHaveLength(2);
  });

  it("avisa quem mostra a linha quando a miniatura chega", async () => {
    const { loader } = setup();
    let heard = 0;
    loader.subscribe("a1", () => {
      heard += 1;
    });
    loader.show("a1");
    await settle();
    expect(heard).toBe(1);
  });

  it("depois de descartado, nada mais é pedido nem agendado", async () => {
    const { calls, clock, connection, loader } = setup({ online: false });
    loader.show("a1");
    loader.dispose();
    connection.set(true);
    await clock.advance(600_000);
    expect(calls).toEqual([]);
  });
});
