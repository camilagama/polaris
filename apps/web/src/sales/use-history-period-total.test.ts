import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PeriodTotalRead } from "./sale-history-model";
import { useHistoryPeriodTotal } from "./use-history-period-total";

interface Slot {
  cleanup?: (() => void) | undefined;
  deps?: readonly unknown[] | undefined;
  value?: unknown;
}

const runtime = {
  cursor: 0,
  pendingEffects: [] as (() => void)[],
  rerender: () => undefined as unknown,
  slots: [] as Slot[],
};

function nextSlot(): Slot {
  const slot = runtime.slots[runtime.cursor] ?? {};
  runtime.slots[runtime.cursor] = slot;
  runtime.cursor += 1;
  return slot;
}

vi.mock("react", () => ({
  useEffect: (
    effect: () => (() => void) | undefined,
    deps: readonly unknown[]
  ) => {
    const slot = nextSlot();
    const same =
      slot.deps !== undefined &&
      slot.deps.length === deps.length &&
      slot.deps.every((value, at) => Object.is(value, deps[at]));
    if (!same) {
      runtime.pendingEffects.push(() => {
        slot.cleanup?.();
        slot.cleanup = effect();
      });
      slot.deps = deps;
    }
  },
  useState: <T>(initial: T) => {
    const slot = nextSlot();
    if (!("value" in slot)) {
      slot.value = initial;
    }
    return [
      slot.value as T,
      (next: T) => {
        slot.value = next;
        runtime.rerender();
      },
    ];
  },
}));

const periodSummary = vi.fn();
vi.mock("../lib/orpc", () => ({
  orpcClient: {
    report: { periodSummary: (...call: unknown[]) => periodSummary(...call) },
  },
}));
vi.mock("../lib/read-with-retry", () => ({
  readWithRetry: <T>(
    read: (signal: AbortSignal) => Promise<T>,
    options: { isCurrent?: () => boolean }
  ) =>
    read(new AbortController().signal).then((value) => {
      if (options.isCurrent?.() === false) {
        throw new Error("read_left_behind");
      }
      return value;
    }),
}));

const ORGANIZATION = "0199c2d0-0000-7000-8000-00000000a001";
const OCTOBER = { from: "2026-10-01", to: "2026-10-14" };
const NOVEMBER = { from: "2026-11-01", to: "2026-11-10" };

const summary = (netSales: string, salesCount: number) => ({
  cards: { netSales, salesCount },
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, reject, resolve };
}

function render(
  period: { from: string; to: string } | null,
  reloadVersion = 0
): PeriodTotalRead {
  runtime.cursor = 0;
  const read = useHistoryPeriodTotal(ORGANIZATION, period, reloadVersion);
  const effects = runtime.pendingEffects.splice(0);
  for (const effect of effects) {
    effect();
  }
  return read;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

let latest: PeriodTotalRead = { status: "idle" };
let args: { period: typeof OCTOBER | null; version: number } = {
  period: null,
  version: 0,
};

function show(period: typeof OCTOBER | null, version = 0) {
  args = { period, version };
  latest = render(period, version);
  return latest;
}

beforeEach(() => {
  runtime.slots = [];
  runtime.pendingEffects = [];
  runtime.rerender = () => {
    latest = render(args.period, args.version);
  };
  periodSummary.mockReset();
  latest = { status: "idle" };
  args = { period: null, version: 0 };
});

describe("useHistoryPeriodTotal", () => {
  it("sem período não chama o resumo e fica ocioso", async () => {
    expect(show(null)).toEqual({ status: "idle" });
    await settle();
    expect(periodSummary).not.toHaveBeenCalled();
  });

  it("lê o resumo do Resultado, sem topProducts, e entrega netSales e salesCount", async () => {
    periodSummary.mockResolvedValue(summary("1234.50", 7));
    expect(show(OCTOBER)).toEqual({ status: "loading" });
    await settle();
    expect(periodSummary).toHaveBeenCalledTimes(1);
    expect(periodSummary.mock.calls[0]?.[0]).toEqual({
      from: "2026-10-01",
      organizationId: ORGANIZATION,
      to: "2026-10-14",
    });
    expect(latest).toEqual({
      netSales: "1234.50",
      salesCount: 7,
      status: "ready",
    });
  });

  it("mudar o período durante a leitura descarta a resposta antiga", async () => {
    const first = deferred<ReturnType<typeof summary>>();
    const second = deferred<ReturnType<typeof summary>>();
    periodSummary
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    show(OCTOBER);
    show(NOVEMBER);
    second.resolve(summary("20.00", 2));
    await settle();
    first.resolve(summary("999.00", 99));
    await settle();
    expect(latest).toEqual({
      netSales: "20.00",
      salesCount: 2,
      status: "ready",
    });
  });

  it("uma resposta antiga que chega primeiro nunca aparece sob o período novo", async () => {
    const first = deferred<ReturnType<typeof summary>>();
    const second = deferred<ReturnType<typeof summary>>();
    periodSummary
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    show(OCTOBER);
    show(NOVEMBER);
    first.resolve(summary("999.00", 99));
    await settle();
    expect(latest).toEqual({ status: "loading" });
    second.resolve(summary("20.00", 2));
    await settle();
    expect(latest).toEqual({
      netSales: "20.00",
      salesCount: 2,
      status: "ready",
    });
  });

  it("recarregar a lista (reloadVersion) lê o total de novo, mostrando lendo enquanto isso", async () => {
    periodSummary.mockResolvedValueOnce(summary("10.00", 1));
    show(OCTOBER, 0);
    await settle();
    periodSummary.mockResolvedValueOnce(summary("12.00", 2));
    expect(show(OCTOBER, 1)).toEqual({ status: "loading" });
    await settle();
    expect(periodSummary).toHaveBeenCalledTimes(2);
    expect(latest).toEqual({
      netSales: "12.00",
      salesCount: 2,
      status: "ready",
    });
  });

  it("a mesma leitura não se repete quando nada mudou", async () => {
    periodSummary.mockResolvedValue(summary("10.00", 1));
    show(OCTOBER);
    await settle();
    show(OCTOBER);
    await settle();
    expect(periodSummary).toHaveBeenCalledTimes(1);
  });

  it("falha, inclusive a recusa de report:read, é failed e nunca um número", async () => {
    periodSummary.mockRejectedValue(
      Object.assign(new Error("forbidden"), { code: "FORBIDDEN" })
    );
    show(OCTOBER);
    await settle();
    expect(latest).toEqual({ status: "failed" });
  });

  it("resposta que não é um resumo vira failed", async () => {
    periodSummary.mockResolvedValue({ unexpected: true });
    show(OCTOBER);
    await settle();
    expect(latest).toEqual({ status: "failed" });
  });

  it("sair do período (filtro novo, sem conexão) volta a ocioso sem nova chamada", async () => {
    periodSummary.mockResolvedValue(summary("10.00", 1));
    show(OCTOBER);
    await settle();
    expect(show(null)).toEqual({ status: "idle" });
    await settle();
    expect(periodSummary).toHaveBeenCalledTimes(1);
  });

  it("voltar ao mesmo período depois de sair dele lê de novo, sem mostrar a resposta antiga", async () => {
    periodSummary.mockResolvedValueOnce(summary("10.00", 1));
    show(OCTOBER);
    await settle();
    show(null);
    periodSummary.mockResolvedValueOnce(summary("11.00", 2));
    expect(show(OCTOBER)).toEqual({ status: "loading" });
    await settle();
    expect(periodSummary).toHaveBeenCalledTimes(2);
    expect(latest).toEqual({
      netSales: "11.00",
      salesCount: 2,
      status: "ready",
    });
  });
});
