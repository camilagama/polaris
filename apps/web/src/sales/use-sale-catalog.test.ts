import type { InventoryBalanceEntryReadModel } from "@polaris/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSaleCatalog } from "./use-sale-catalog";

interface Runtime {
  index: number;
  slots: unknown[];
}

const runtime: Runtime = { index: 0, slots: [] };

vi.mock("react", () => {
  function slot<T>(make: () => T): [T, number] {
    const at = runtime.index;
    runtime.index += 1;
    if (!(at in runtime.slots)) {
      runtime.slots[at] = make();
    }
    return [runtime.slots[at] as T, at];
  }
  return {
    useCallback: <T>(fn: T) => fn,
    useEffect: () => undefined,
    useRef: <T>(initial: T) => slot(() => ({ current: initial }))[0],
    useState: <T>(initial: T) => {
      const [box] = slot(() => ({ value: initial }));
      const set = (next: T | ((previous: T) => T)) => {
        box.value =
          typeof next === "function"
            ? (next as (previous: T) => T)(box.value)
            : next;
      };
      return [box.value, set];
    },
  };
});

const listBalances = vi.fn();
vi.mock("../lib/orpc", () => ({
  orpcClient: {
    inventory: { listBalances: (input: unknown) => listBalances(input) },
    paymentProfile: { list: () => Promise.resolve({ profiles: [] }) },
  },
}));
vi.mock("../lib/read-with-retry", () => ({
  readWithRetry: <T>(read: () => Promise<T>) => read(),
}));
vi.mock("../lib/media-thumbs-flag", () => ({
  useMediaThumbsEnabled: () => true,
}));
vi.mock("../lib/current-organization-model", () => ({
  browserStorage: () => null,
}));
vi.mock("../lib/payment-profile-cache", () => ({
  readPaymentProfileCache: () => [],
  writePaymentProfileCache: () => undefined,
}));
vi.mock("../lib/sign-out", () => ({ isSigningOut: () => false }));

const variantId = "22222222-2222-4222-8222-222222222222";

function entry(coverAssetId?: string): InventoryBalanceEntryReadModel {
  return {
    movingAverageCost: null,
    quantity: 3,
    variantId,
    version: 1,
    ...(coverAssetId === undefined ? {} : { coverAssetId }),
  } as unknown as InventoryBalanceEntryReadModel;
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function mount() {
  const render = () => {
    runtime.index = 0;
    return useSaleCatalog("org", () => undefined);
  };
  render();
  return render;
}

function coverOf(render: ReturnType<typeof mount>): string | undefined {
  const balance = render().stock[variantId];
  return balance?.status === "ready"
    ? (balance.value.coverAssetId ?? undefined)
    : undefined;
}

describe("useSaleCatalog: respostas fora de ordem", () => {
  beforeEach(() => {
    runtime.slots = [];
    listBalances.mockReset();
  });

  it("a releitura pela chave vence um refresh sem capa que chega depois dela", async () => {
    const refreshAnswer = deferred<{ entries: unknown[] }>();
    const readAnswer = deferred<{ entries: unknown[] }>();
    listBalances
      .mockReturnValueOnce(refreshAnswer.promise)
      .mockReturnValueOnce(readAnswer.promise);
    const render = mount();
    const { readLines, refresh } = render();

    refresh([variantId]);
    const read = readLines([variantId]);
    readAnswer.resolve({ entries: [entry("asset-1")] });
    await read;
    refreshAnswer.resolve({ entries: [entry()] });
    await refreshAnswer.promise;
    await Promise.resolve();

    expect(coverOf(render)).toBe("asset-1");
  });

  it("um refresh que começa depois da releitura continua valendo", async () => {
    listBalances
      .mockResolvedValueOnce({ entries: [entry("asset-1")] })
      .mockResolvedValueOnce({ entries: [entry("asset-2")] });
    const render = mount();
    const { readLines, refresh } = render();

    await readLines([variantId]);
    refresh([variantId]);
    await vi.waitFor(() => expect(coverOf(render)).toBe("asset-2"));
  });

  it("uma releitura que falha não deixa em carregando a linha que o refresh descartado marcou", async () => {
    const refreshAnswer = deferred<{ entries: unknown[] }>();
    listBalances
      .mockReturnValueOnce(refreshAnswer.promise)
      .mockRejectedValueOnce(new Error("sem rede"));
    const render = mount();
    const { readLines, refresh } = render();

    refresh([variantId]);
    expect(render().stock[variantId]?.status).toBe("loading");
    expect(await readLines([variantId])).toBeNull();
    refreshAnswer.resolve({ entries: [entry()] });
    await refreshAnswer.promise;
    await Promise.resolve();

    expect(render().stock[variantId]?.status).toBe("error");
  });
});

describe("useSaleCatalog: releitura em blocos de 100", () => {
  beforeEach(() => {
    runtime.slots = [];
    listBalances.mockReset();
  });

  const ids = Array.from(
    { length: 101 },
    (_, index) => `33333333-3333-4333-8333-${String(index).padStart(12, "0")}`
  );

  function entryOf(id: string): InventoryBalanceEntryReadModel {
    return {
      movingAverageCost: null,
      quantity: 3,
      variantId: id,
      version: 1,
    } as unknown as InventoryBalanceEntryReadModel;
  }

  it("o bloco que falha marca erro só nas linhas dele; as do bloco que respondeu ficam prontas", async () => {
    const never = new Promise<never>(() => undefined);
    listBalances
      .mockReturnValueOnce(never)
      .mockReturnValueOnce(never)
      .mockImplementation((input: { variantIds: string[] }) =>
        input.variantIds.length === 100
          ? Promise.resolve({ entries: input.variantIds.map(entryOf) })
          : Promise.reject(new Error("sem rede"))
      );
    const render = mount();
    const { readLines, refresh } = render();

    refresh(ids);
    expect(render().stock[ids[0] as string]?.status).toBe("loading");
    expect(render().stock[ids[100] as string]?.status).toBe("loading");

    expect(await readLines(ids)).toBeNull();

    const { stock } = render();
    expect(stock[ids[0] as string]?.status).toBe("ready");
    expect(stock[ids[99] as string]?.status).toBe("ready");
    expect(stock[ids[100] as string]?.status).toBe("error");
  });

  it("com todos os blocos respondendo devolve as entradas de todos", async () => {
    listBalances.mockImplementation((input: { variantIds: string[] }) =>
      Promise.resolve({ entries: input.variantIds.map(entryOf) })
    );
    const render = mount();
    const { readLines } = render();

    const entries = await readLines(ids);

    expect(entries).toHaveLength(101);
    expect(render().stock[ids[100] as string]?.status).toBe("ready");
  });
});

describe("useSaleCatalog: preço de tabela de cada leitura", () => {
  const otherId = "44444444-4444-4444-8444-444444444444";

  beforeEach(() => {
    runtime.slots = [];
    listBalances.mockReset();
  });

  function priced(
    id: string,
    listPrice: string | null
  ): InventoryBalanceEntryReadModel {
    return {
      listPrice,
      movingAverageCost: null,
      quantity: 3,
      variantId: id,
      version: 1,
    } as unknown as InventoryBalanceEntryReadModel;
  }

  it("a leitura online das linhas guarda o preço de tabela, inclusive o ausente", async () => {
    listBalances.mockResolvedValueOnce({
      entries: [priced(variantId, "19.90"), priced(otherId, null)],
    });
    const render = mount();
    const { listPrices, readLines } = render();

    await readLines([variantId, otherId]);

    expect(listPrices.current.get(variantId)).toBe("19.90");
    expect(listPrices.current.has(otherId)).toBe(true);
    expect(listPrices.current.get(otherId)).toBeNull();
  });

  it("a leitura online guarda o preço do bloco que respondeu mesmo quando outro bloco falha", async () => {
    const ids = Array.from(
      { length: 101 },
      (_, index) => `55555555-5555-4555-8555-${String(index).padStart(12, "0")}`
    );
    listBalances.mockImplementation((input: { variantIds: string[] }) =>
      input.variantIds.length === 100
        ? Promise.resolve({
            entries: input.variantIds.map((id) => priced(id, "7.00")),
          })
        : Promise.reject(new Error("sem rede"))
    );
    const render = mount();
    const { listPrices, readLines } = render();

    expect(await readLines(ids)).toBeNull();

    expect(listPrices.current.get(ids[0] as string)).toBe("7.00");
    expect(listPrices.current.has(ids[100] as string)).toBe(false);
  });

  it("o refresh online guarda o preço de tabela que a releitura trouxe", async () => {
    listBalances.mockResolvedValueOnce({
      entries: [priced(variantId, "25.50")],
    });
    const render = mount();
    const { listPrices, refresh } = render();

    refresh([variantId]);
    await vi.waitFor(() =>
      expect(render().stock[variantId]?.status).toBe("ready")
    );

    expect(listPrices.current.get(variantId)).toBe("25.50");
  });

  it("o refresh online atualiza o preço de tabela que mudou desde a leitura anterior", async () => {
    listBalances
      .mockResolvedValueOnce({ entries: [priced(variantId, "10.00")] })
      .mockResolvedValueOnce({ entries: [priced(variantId, "12.00")] });
    const render = mount();
    const { listPrices, readLines, refresh } = render();

    await readLines([variantId]);
    expect(listPrices.current.get(variantId)).toBe("10.00");
    refresh([variantId]);
    await vi.waitFor(() =>
      expect(listPrices.current.get(variantId)).toBe("12.00")
    );
  });

  it("o seedStock guarda o preço de tabela das entradas da busca, sem ler o servidor", () => {
    const render = mount();
    const { listPrices, seedStock } = render();

    seedStock([priced(variantId, "42.00"), priced(otherId, null)]);

    expect(listBalances).not.toHaveBeenCalled();
    expect(listPrices.current.get(variantId)).toBe("42.00");
    expect(listPrices.current.get(otherId)).toBeNull();
    expect(render().stock[variantId]?.status).toBe("ready");
  });
});
