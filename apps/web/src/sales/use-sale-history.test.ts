import type { SaleListEntryReadModel } from "@polaris/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SALES_PAGE_SIZE, type SalePage } from "./sale-history-model";
import { useSaleHistory } from "./use-sale-history";

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
    useRef: <T>(initial: T) => slot(() => ({ current: initial })),
    useState: <T>(initial: T) => {
      const box = slot(() => ({ value: initial }));
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

const saleList = vi.fn();
vi.mock("../lib/orpc", () => ({
  orpcClient: { sale: { list: (input: unknown) => saleList(input) } },
}));
vi.mock("../lib/read-with-retry", () => ({
  readWithRetry: <T>(read: () => Promise<T>) => read(),
}));

function sale(id: string): SaleListEntryReadModel {
  return { id } as unknown as SaleListEntryReadModel;
}

function page(hasMore: boolean, ...ids: string[]): SalePage {
  return { hasMore, sales: ids.map(sale) };
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
    return useSaleHistory("org");
  };
  const runEffect = () => {
    runtime.cleanup?.();
    runtime.cleanup = runtime.effect?.();
  };
  render();
  return { render, runEffect };
}

function idsOf(render: ReturnType<typeof mount>["render"]): string[] {
  return render().state.sales.map((entry) => entry.id);
}

describe("useSaleHistory: Carregar mais", () => {
  beforeEach(() => {
    runtime.slots = [];
    runtime.cleanup = undefined;
    runtime.effect = undefined;
    saleList.mockReset();
  });

  it("sem troca de filtro, a 2ª página é anexada à lista", async () => {
    const second = deferred<SalePage>();
    saleList
      .mockResolvedValueOnce(page(true, "a", "b"))
      .mockReturnValueOnce(second.promise);
    const { render, runEffect } = mount();

    runEffect();
    await vi.waitFor(() => expect(idsOf(render)).toEqual(["a", "b"]));
    render().loadMore();
    expect(saleList).toHaveBeenLastCalledWith(
      expect.objectContaining({ limit: SALES_PAGE_SIZE, offset: 2 })
    );
    expect(render().state.loadingMore).toBe(true);
    second.resolve(page(false, "c"));
    await second.promise;

    expect(idsOf(render)).toEqual(["a", "b", "c"]);
    expect(render().state.loadingMore).toBe(false);
    expect(render().state.hasMore).toBe(false);
  });

  it("trocar o filtro antes de a resposta chegar descarta a 2ª página do filtro antigo", async () => {
    const oldSecond = deferred<SalePage>();
    const newFirst = deferred<SalePage>();
    saleList
      .mockResolvedValueOnce(page(true, "a", "b"))
      .mockReturnValueOnce(oldSecond.promise)
      .mockReturnValueOnce(newFirst.promise);
    const { render, runEffect } = mount();

    runEffect();
    await vi.waitFor(() => expect(idsOf(render)).toEqual(["a", "b"]));
    render().loadMore();
    expect(saleList).toHaveBeenCalledTimes(2);
    render().setFilters({ status: "cancelled" });
    render();
    runEffect();
    expect(saleList).toHaveBeenCalledTimes(3);
    expect(saleList).toHaveBeenLastCalledWith(
      expect.objectContaining({ offset: 0, status: "cancelled" })
    );

    oldSecond.resolve(page(false, "old-c"));
    await oldSecond.promise;
    expect(idsOf(render)).toEqual(["a", "b"]);
    expect(render().state.hasMore).toBe(true);

    newFirst.resolve(page(false, "x"));
    await newFirst.promise;
    expect(idsOf(render)).toEqual(["x"]);
    expect(render().state.hasMore).toBe(false);
    expect(render().state.loadingMore).toBe(false);
  });

  it("trocar o filtro antes de a 2ª página falhar não mostra o erro dela na lista nova", async () => {
    const oldSecond = deferred<SalePage>();
    const newFirst = deferred<SalePage>();
    saleList
      .mockResolvedValueOnce(page(true, "a", "b"))
      .mockReturnValueOnce(oldSecond.promise)
      .mockReturnValueOnce(newFirst.promise);
    const { render, runEffect } = mount();

    runEffect();
    await vi.waitFor(() => expect(idsOf(render)).toEqual(["a", "b"]));
    render().loadMore();
    expect(saleList).toHaveBeenCalledTimes(2);
    render().setFilters({ status: "cancelled" });
    render();
    runEffect();
    expect(saleList).toHaveBeenCalledTimes(3);

    oldSecond.reject(new Error("sem rede"));
    await oldSecond.promise.catch(() => undefined);
    expect(render().state.moreError).toBeNull();
    expect(render().state.loadingMore).toBe(true);
  });
});
