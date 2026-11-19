import type { InventoryBalanceEntryReadModel } from "@polaris/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  canLoadMoreStock,
  type StockPage,
  stockMoreView,
} from "./stock-list-model";
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

  it("trocar o filtro com a 1ª página nova em voo esconde o Carregar mais e não usa o cursor da lista antiga", async () => {
    const newFirst = deferred<StockPage>();
    listBalances
      .mockResolvedValueOnce(page("cursor-1", 1, 2))
      .mockReturnValueOnce(newFirst.promise);
    const { render, runEffect } = mount();

    runEffect();
    await vi.waitFor(() =>
      expect(idsOf(render)).toEqual([variantId(1), variantId(2)])
    );
    expect(canLoadMoreStock(render().state, render().listKey)).toBe(true);
    render().setFilters({ stock: "without_stock" });
    render();
    expect(stockMoreView(render().state, render().listKey).visible).toBe(false);
    runEffect();
    expect(listBalances).toHaveBeenCalledTimes(2);

    const { listKey, loadMore, state } = render();
    expect(idsOf(render)).toEqual([variantId(1), variantId(2)]);
    expect(stockMoreView(state, listKey)).toMatchObject({
      refreshing: true,
      visible: false,
    });
    expect(canLoadMoreStock(state, listKey)).toBe(false);
    loadMore();
    expect(listBalances).toHaveBeenCalledTimes(2);

    newFirst.resolve(page("cursor-9", 9));
    await newFirst.promise;
    const loaded = render();
    expect(idsOf(render)).toEqual([variantId(9)]);
    expect(stockMoreView(loaded.state, loaded.listKey).visible).toBe(true);
    listBalances.mockResolvedValueOnce(page(null, 10));
    loaded.loadMore();
    expect(listBalances).toHaveBeenLastCalledWith(
      expect.objectContaining({ cursor: "cursor-9", stock: "without_stock" })
    );
  });

  it("a 1ª página do filtro novo falhar tira a lista antiga e mostra o erro da lista, sem Carregar mais", async () => {
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
    expect(render().state.loadingMore).toBe(true);
    render().setFilters({ stock: "without_stock" });
    render();
    runEffect();
    expect(listBalances).toHaveBeenCalledTimes(3);

    newFirst.reject(new Error("sem rede"));
    await vi.waitFor(() => expect(render().state.status).toBe("error"));
    const { listKey, loadMore, state } = render();
    expect(state.entries).toEqual([]);
    expect(state.loadingMore).toBe(false);
    expect(stockMoreView(state, listKey).visible).toBe(false);
    expect(canLoadMoreStock(state, listKey)).toBe(false);
    loadMore();
    expect(listBalances).toHaveBeenCalledTimes(3);

    oldSecond.resolve(page(null, 3));
    await oldSecond.promise;
    expect(render().state.entries).toEqual([]);
  });

  it("a releitura com o mesmo filtro falhar mantém a lista com o aviso, sem Carregar mais, até uma 1ª página dar certo", async () => {
    const again = deferred<StockPage>();
    listBalances
      .mockResolvedValueOnce(page("cursor-1", 1, 2))
      .mockReturnValueOnce(again.promise)
      .mockResolvedValueOnce(page("cursor-3", 3));
    const { render, runEffect } = mount();

    runEffect();
    await vi.waitFor(() =>
      expect(idsOf(render)).toEqual([variantId(1), variantId(2)])
    );
    render().reload();
    render();
    runEffect();
    expect(stockMoreView(render().state, render().listKey)).toMatchObject({
      refreshing: true,
      visible: false,
    });

    again.reject(new Error("sem rede"));
    await vi.waitFor(() => expect(render().state.refresh).toBe("failed"));
    const failed = render();
    expect(idsOf(render)).toEqual([variantId(1), variantId(2)]);
    expect(failed.state.status).toBe("ready");
    expect(stockMoreView(failed.state, failed.listKey)).toMatchObject({
      refreshFailed: true,
      visible: false,
    });
    expect(canLoadMoreStock(failed.state, failed.listKey)).toBe(false);
    failed.loadMore();
    expect(listBalances).toHaveBeenCalledTimes(2);

    failed.reload();
    render();
    runEffect();
    await vi.waitFor(() => expect(idsOf(render)).toEqual([variantId(3)]));
    const healed = render();
    expect(stockMoreView(healed.state, healed.listKey)).toMatchObject({
      refreshFailed: false,
      visible: true,
    });
  });
});
