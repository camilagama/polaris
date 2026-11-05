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
