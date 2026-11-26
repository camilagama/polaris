import type { SaleListEntryReadModel } from "@polaris/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  canLoadMore,
  historyView,
  loadMoreView,
  SALES_PAGE_SIZE,
  type SalePage,
} from "./sale-history-model";
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
    useMemo: <T>(make: () => T) => make(),
    useEffect: (effect: () => (() => void) | undefined) => {
      runtime.effect = effect;
    },
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

  it("antes da 1ª resposta, o estado é o inicial: carregando e sem vendas", async () => {
    const first = deferred<SalePage>();
    saleList.mockReturnValueOnce(first.promise);
    const { render, runEffect } = mount();

    expect(render().state.list).toBe("loading");
    expect(render().state.sales).toEqual([]);
    runEffect();
    expect(saleList).toHaveBeenCalledTimes(1);
    expect(render().state.list).toBe("loading");
    expect(render().state.sales).toEqual([]);

    first.resolve(page(false, "a"));
    await first.promise;
    expect(render().state.list).toBe("ready");
    expect(idsOf(render)).toEqual(["a"]);
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
    expect(idsOf(render)).toEqual(["a", "b"]);

    newFirst.resolve(page(false, "x"));
    await newFirst.promise;
    expect(idsOf(render)).toEqual(["x"]);
    expect(render().state.moreError).toBeNull();
    expect(render().state.list).toBe("ready");
  });

  it("trocar o filtro com a 1ª página nova em voo esconde o Carregar mais e não pede a 2ª página com o deslocamento da lista antiga", async () => {
    const newFirst = deferred<SalePage>();
    saleList
      .mockResolvedValueOnce(page(true, "a", "b"))
      .mockReturnValueOnce(newFirst.promise);
    const { render, runEffect } = mount();

    runEffect();
    await vi.waitFor(() => expect(idsOf(render)).toEqual(["a", "b"]));
    expect(canLoadMore(render().state, render().listKey)).toBe(true);
    render().setFilters({ status: "cancelled" });
    render();
    expect(loadMoreView(render().state, render().listKey).visible).toBe(false);
    runEffect();
    expect(saleList).toHaveBeenCalledTimes(2);

    const { listKey, loadMore, state } = render();
    expect(idsOf(render)).toEqual(["a", "b"]);
    expect(loadMoreView(state, listKey)).toMatchObject({
      refreshing: true,
      visible: false,
    });
    expect(canLoadMore(state, listKey)).toBe(false);
    loadMore();
    expect(saleList).toHaveBeenCalledTimes(2);

    newFirst.resolve(page(true, "x"));
    await newFirst.promise;
    const loaded = render();
    expect(idsOf(render)).toEqual(["x"]);
    expect(loadMoreView(loaded.state, loaded.listKey).visible).toBe(true);
    saleList.mockResolvedValueOnce(page(false, "y"));
    loaded.loadMore();
    expect(saleList).toHaveBeenLastCalledWith(
      expect.objectContaining({ offset: 1, status: "cancelled" })
    );
  });

  it("a 1ª página do filtro novo falhar tira a lista antiga e mostra o erro da lista, sem Carregar mais", async () => {
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
    render().setFilters({ status: "cancelled" });
    render();
    runEffect();
    expect(saleList).toHaveBeenCalledTimes(3);

    newFirst.reject(new Error("sem rede"));
    await vi.waitFor(() => expect(render().state.list).toBe("error"));
    const { listKey, loadMore, state } = render();
    expect(state.sales).toEqual([]);
    expect(state.loadingMore).toBe(false);
    expect(historyView(state).kind).toBe("error");
    expect(loadMoreView(state, listKey).visible).toBe(false);
    expect(canLoadMore(state, listKey)).toBe(false);
    loadMore();
    expect(saleList).toHaveBeenCalledTimes(3);
  });

  it("a releitura com o mesmo filtro falhar mantém a lista com o aviso, sem Carregar mais, até uma 1ª página dar certo", async () => {
    const again = deferred<SalePage>();
    saleList
      .mockResolvedValueOnce(page(true, "a", "b"))
      .mockReturnValueOnce(again.promise)
      .mockResolvedValueOnce(page(true, "c"));
    const { render, runEffect } = mount();

    runEffect();
    await vi.waitFor(() => expect(idsOf(render)).toEqual(["a", "b"]));
    render().reload();
    render();
    runEffect();
    expect(loadMoreView(render().state, render().listKey)).toMatchObject({
      refreshing: true,
      visible: false,
    });

    again.reject(new Error("sem rede"));
    await vi.waitFor(() => expect(render().state.refresh).toBe("failed"));
    const failed = render();
    expect(idsOf(render)).toEqual(["a", "b"]);
    expect(failed.state.list).toBe("ready");
    expect(loadMoreView(failed.state, failed.listKey)).toMatchObject({
      refreshFailed: true,
      visible: false,
    });
    expect(canLoadMore(failed.state, failed.listKey)).toBe(false);
    failed.loadMore();
    expect(saleList).toHaveBeenCalledTimes(2);

    failed.reload();
    render();
    runEffect();
    await vi.waitFor(() => expect(idsOf(render)).toEqual(["c"]));
    const healed = render();
    expect(loadMoreView(healed.state, healed.listKey)).toMatchObject({
      refreshFailed: false,
      visible: true,
    });
  });
});
