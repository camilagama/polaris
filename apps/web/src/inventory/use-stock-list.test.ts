import type { InventoryBalanceEntryReadModel } from "@polaris/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { canLoadMoreStock, type StockPage } from "./stock-list-model";
import { useStockList } from "./use-stock-list";

interface Runtime {
  cleanup: (() => void) | undefined;
  effect: (() => (() => void) | undefined) | undefined;
  index: number;
  slots: unknown[];
}

const runtime: Runtime = {
  cleanup: undefined,
  effect: undefined,
  index: 0,
  slots: [],
};

vi.mock("react", () => {
  function slot<T>(make: () => T): T {
    const at = runtime.index;
    runtime.index += 1;
    if (!(at in runtime.slots)) {
      runtime.slots[at] = make();
    }
    return runtime.slots[at] as T;
  }
  return {
    createContext: () => ({ Provider: undefined }),
    useCallback: <T>(fn: T) => fn,
    useEffect: (effect: () => (() => void) | undefined) => {
      runtime.effect = effect;
    },
    useMemo: <T>(make: () => T) => make(),
    useRef: <T>(initial: T) => slot(() => ({ current: initial })),
    useState: <T>(initial: T) => {
      const box = slot(() => ({
        value: typeof initial === "function" ? (initial as () => T)() : initial,
      }));
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
  },
}));
vi.mock("../lib/read-with-retry", () => ({
  readWithRetry: <T>(read: () => Promise<T>) => read(),
}));
vi.mock("../lib/media-thumbs-flag", () => ({
  useMediaThumbsEnabled: () => false,
}));
vi.mock("../lib/use-debounced-value", () => ({
  useDebouncedValue: <T>(value: T) => value,
}));
vi.mock("../offline/local-stock-entries", () => ({
  filterLocalStockEntries: vi.fn(),
  localStockEntries: vi.fn(),
  readLocalCatalog: vi.fn(),
}));

function variantId(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

function entry(n: number): InventoryBalanceEntryReadModel {
  return {
    variantId: variantId(n),
  } as unknown as InventoryBalanceEntryReadModel;
}

function page(nextCursor: string | null, ...ns: number[]): StockPage {
  return { entries: ns.map(entry), nextCursor };
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason: unknown) => void = () => undefined;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, reject, resolve };
}

function mount() {
  const render = () => {
    runtime.index = 0;
    return useStockList("org");
  };
  const runEffect = () => {
    runtime.cleanup?.();
    runtime.cleanup = runtime.effect?.();
  };
  render();
  return { render, runEffect };
}

function idsOf(render: ReturnType<typeof mount>["render"]): string[] {
  return render().state.entries.map((item) => item.variantId);
}

describe("useStockList: Carregar mais", () => {
  beforeEach(() => {
    runtime.slots = [];
    runtime.cleanup = undefined;
    runtime.effect = undefined;
    listBalances.mockReset();
  });

  it("a 1ª página nova falhar com a seguinte em voo não deixa o botão preso em Carregando", async () => {
    const oldSecond = deferred<StockPage>();
    const newFirst = deferred<StockPage>();
    listBalances
      .mockResolvedValueOnce(page("cursor-1", 1, 2))
      .mockReturnValueOnce(oldSecond.promise)
      .mockReturnValueOnce(newFirst.promise);
    const { render, runEffect } = mount();

    runEffect();
    await vi.waitFor(() =>
      expect(idsOf(render)).toEqual([variantId(1), variantId(2)])
    );
    render().loadMore();
    expect(listBalances).toHaveBeenCalledTimes(2);
    expect(listBalances).toHaveBeenLastCalledWith(
      expect.objectContaining({ cursor: "cursor-1" })
    );
    expect(render().state.loadingMore).toBe(true);

    render().setFilters({ stock: "without_stock" });
    render();
    runEffect();
    expect(listBalances).toHaveBeenCalledTimes(3);
    expect(listBalances).toHaveBeenLastCalledWith(
      expect.objectContaining({ stock: "without_stock" })
    );
    expect(render().state.loadingMore).toBe(false);

    newFirst.reject(new Error("sem rede"));
    await newFirst.promise.catch(() => undefined);

    const { state } = render();
    expect(state.loadingMore).toBe(false);
    expect(state.moreError).not.toBeNull();
    expect(state.status).toBe("ready");
    expect(state.nextCursor).toBe("cursor-1");
    expect(canLoadMoreStock(state)).toBe(true);

    oldSecond.resolve(page(null, 3));
    await oldSecond.promise;
    expect(idsOf(render)).toEqual([variantId(1), variantId(2)]);
    expect(render().state.loadingMore).toBe(false);
  });
});
