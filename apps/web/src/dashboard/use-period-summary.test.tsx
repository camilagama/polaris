// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearPeriodSummaryCaches,
  DAILY_SALES_COPY_KEY_PREFIX,
  dailySalesMemory,
  HOME_COPY_KEY_PREFIX,
  readPeriodSummaryCache,
  type StoredPeriodSummary,
  TOP_PRODUCTS,
  writePeriodSummaryCache,
} from "../lib/period-summary-cache";
import { markPeriodSummaryStale } from "../lib/period-summary-stale";
import type { Period } from "./result-period";
import { usePeriodSummary } from "./use-period-summary";

const ORG = "0199c2d0-0000-7000-8000-00000000a001";
const OTHER_ORG = "0199c2d0-0000-7000-8000-00000000a002";
const OCTOBER: Period = { from: "2026-10-01", to: "2026-10-03" };
const NOVEMBER: Period = { from: "2026-11-01", to: "2026-11-03" };
const DAY = 86_400_000;

const mocks = vi.hoisted(() => ({
  online: true,
  periodSummary: vi.fn(),
  snapshot: null as { sessionRefused: boolean } | null,
}));

vi.mock("../lib/browser-connection", () => ({
  browserConnection: {
    isOnline: () => mocks.online,
    mayRetryRead: () => false,
  },
  useConnectionOnline: () => mocks.online,
}));
vi.mock("../offline/runtime/enabled", () => ({
  OFFLINE_RUNTIME_ENABLED: true,
}));
vi.mock("../offline/runtime/runtime-context", () => ({
  useRuntimeSnapshot: () => mocks.snapshot,
}));
vi.mock("../lib/orpc", () => ({
  orpcClient: {
    report: {
      periodSummary: (input: unknown, options: unknown) =>
        mocks.periodSummary(input, options),
    },
  },
}));

const monthOf = (period: Period) => period.from.slice(0, 7);

function datesOf({ from, to }: Period): string[] {
  const dates: string[] = [];
  for (
    let time = Date.parse(`${from}T00:00:00.000Z`);
    time <= Date.parse(`${to}T00:00:00.000Z`);
    time += DAY
  ) {
    dates.push(new Date(time).toISOString().slice(0, 10));
  }
  return dates;
}

const NOW_ISO = "2026-10-23T15:00:00.000Z";
const BEFORE_ISO = "2026-10-23T14:00:00.000Z";

function summaryOf(
  period: Period,
  netSales = "130.00",
  generatedAt = NOW_ISO
): StoredPeriodSummary {
  return {
    cards: {
      items: 3,
      marginPercent: null,
      netSales,
      operatingResult: "0.00",
      salesCount: 2,
      ticket: "65.00",
    },
    chain: {
      anticipationFees: "0.00",
      cogs: "0.00",
      commercialSurcharges: "0.00",
      contributionMargin: "0.00",
      discounts: "0.00",
      estimatedOperatingResult: "0.00",
      grossProfit: "0.00",
      grossSales: "0.00",
      linkedExpenses: "0.00",
      netSales: "0.00",
      operatingExpenses: "0.00",
      processingFees: "0.00",
      returns: "0.00",
    },
    daily: datesOf(period).map((date) => ({
      date,
      netSales: "0.00",
      salesCount: 0,
    })),
    generatedAt,
    period,
    quality: {
      anticipationFeesUnknown: 0,
      itemLines: 2,
      itemLinesWithUnknownCost: 0,
      level: "complete",
      linkedExpenses: 0,
      missing: [],
      operatingExpenses: 0,
      processingFeesUnknown: 0,
      salesCount: 2,
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, reject, resolve };
}

const rpcError = (code: string, status = 500) =>
  Object.assign(new Error(code), { code, status });

const noAnswer = () =>
  Object.assign(new Error("sem resposta"), { name: "NoWorkerAnswerError" });

interface Props {
  active?: boolean;
  copyMonth: string | null;
  enabled?: boolean;
  organizationId?: string;
  period: Period;
}

function mount(initialProps: Props) {
  return renderHook(
    ({
      active = true,
      copyMonth,
      enabled = true,
      organizationId = ORG,
      period,
    }: Props) =>
      usePeriodSummary(organizationId, period, copyMonth, active, enabled),
    { initialProps }
  );
}

/** Lets every promise already settled run its continuation, so a negative assertion looks after the hook is done. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  });
}

function keepCopyOf(
  period: Period,
  netSales = "77.00",
  generatedAt = NOW_ISO,
  organizationId = ORG
): void {
  writePeriodSummaryCache(
    window.localStorage,
    organizationId,
    monthOf(period),
    summaryOf(period, netSales, generatedAt),
    { offlineRuntimeEnabled: true, signingOut: false }
  );
}

const copyOf = (period: Period) =>
  readPeriodSummaryCache(window.localStorage, ORG, monthOf(period));

const inputOf = (period: Period, organizationId = ORG) => ({
  from: period.from,
  organizationId,
  to: period.to,
  topProducts: TOP_PRODUCTS,
});

const NO_COPY_ERROR = "Sem conexão e sem números guardados neste aparelho.";
const ONLY_ONLINE_ERROR = "Este período só abre com internet.";
const GENERIC_ERROR = "Não foi possível carregar o resultado. Tente novamente.";

beforeEach(() => {
  mocks.online = true;
  mocks.snapshot = null;
  mocks.periodSummary.mockReset();
  mocks.periodSummary.mockImplementation(({ from, to }: Period) =>
    Promise.resolve(summaryOf({ from, to }))
  );
  clearPeriodSummaryCaches(window.localStorage);
});

afterEach(() => {
  cleanup();
  clearPeriodSummaryCaches(window.localStorage);
});

describe("usePeriodSummary: resposta do servidor", () => {
  it("mostra o que o servidor devolveu, pede os mais vendidos com o signal e guarda a cópia do mês", async () => {
    const { result } = mount({ copyMonth: "2026-10", period: OCTOBER });

    expect(result.current.state.isLoading).toBe(true);
    expect(result.current.state.summary).toBeNull();
    await waitFor(() => expect(result.current.state.isLoading).toBe(false));

    expect(result.current.state).toEqual({
      error: null,
      isLoading: false,
      serverFailed: false,
      source: "server",
      summary: summaryOf(OCTOBER),
    });
    expect(mocks.periodSummary).toHaveBeenCalledTimes(1);
    expect(mocks.periodSummary).toHaveBeenCalledWith(inputOf(OCTOBER), {
      signal: expect.any(AbortSignal),
    });
    expect(copyOf(OCTOBER)).toEqual(summaryOf(OCTOBER));
  });

  it("sem mês de cópia (outro período) não guarda nada", async () => {
    const { result } = mount({ copyMonth: null, period: OCTOBER });

    await waitFor(() => expect(result.current.state.isLoading).toBe(false));

    expect(result.current.state.source).toBe("server");
    expect(copyOf(OCTOBER)).toBeNull();
  });
});

describe("usePeriodSummary: resposta atrasada", () => {
  it("a resposta do período anterior, que chega depois, não troca a do novo nem grava cópia", async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    mocks.periodSummary
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { rerender, result } = mount({
      copyMonth: monthOf(OCTOBER),
      period: OCTOBER,
    });

    rerender({ copyMonth: monthOf(NOVEMBER), period: NOVEMBER });
    await act(async () => {
      second.resolve(summaryOf(NOVEMBER, "222.00"));
      await second.promise;
    });
    await waitFor(() => expect(result.current.state.isLoading).toBe(false));
    expect(result.current.state.summary?.period).toEqual(NOVEMBER);

    await act(async () => {
      first.resolve(summaryOf(OCTOBER, "111.00"));
      await first.promise;
    });
    await settle();

    expect(result.current.state.summary?.period).toEqual(NOVEMBER);
    expect(result.current.state.summary?.cards.netSales).toBe("222.00");
    expect(result.current.state.isLoading).toBe(false);
    expect(copyOf(OCTOBER)).toBeNull();
    expect(copyOf(NOVEMBER)).toEqual(summaryOf(NOVEMBER, "222.00"));
    expect(mocks.periodSummary).toHaveBeenCalledTimes(2);
    expect(mocks.periodSummary.mock.calls.map(([input]) => input)).toEqual([
      inputOf(OCTOBER),
      inputOf(NOVEMBER),
    ]);
  });

  it("a falha atrasada do período anterior também não aparece nem apaga os números do novo", async () => {
    const first = deferred<unknown>();
    mocks.periodSummary.mockReturnValueOnce(first.promise);
    const { rerender, result } = mount({ copyMonth: null, period: OCTOBER });

    rerender({ copyMonth: null, period: NOVEMBER });
    await waitFor(() =>
      expect(result.current.state.summary?.period).toEqual(NOVEMBER)
    );
    await act(async () => {
      first.reject(rpcError("FORBIDDEN", 403));
      await first.promise.catch(() => undefined);
    });
    await settle();

    expect(result.current.state.error).toBeNull();
    expect(result.current.state.summary?.period).toEqual(NOVEMBER);
  });

  it("o pedido do período que saiu da tela é cancelado pelo signal", async () => {
    const signals: AbortSignal[] = [];
    mocks.periodSummary.mockImplementation(
      ({ from, to }: Period, { signal }: { signal: AbortSignal }) => {
        signals.push(signal);
        return from === OCTOBER.from
          ? new Promise((_resolve, reject) => {
              signal.addEventListener("abort", () => reject(signal.reason));
            })
          : Promise.resolve(summaryOf({ from, to }));
      }
    );
    const { rerender, result } = mount({ copyMonth: null, period: OCTOBER });

    rerender({ copyMonth: null, period: NOVEMBER });
    await waitFor(() => expect(result.current.state.isLoading).toBe(false));

    await waitFor(() => expect(signals[0]?.aborted).toBe(true), {
      timeout: 3000,
    });
    expect(signals[1]?.aborted).toBe(false);
  });
});

describe("usePeriodSummary: trocar de período", () => {
  it("mantém os números anteriores, com isLoading, até a resposta do novo", async () => {
    const second = deferred<unknown>();
    const { rerender, result } = mount({ copyMonth: null, period: OCTOBER });
    await waitFor(() => expect(result.current.state.isLoading).toBe(false));
    mocks.periodSummary.mockReturnValueOnce(second.promise);

    rerender({ copyMonth: null, period: NOVEMBER });

    expect(result.current.state.isLoading).toBe(true);
    expect(result.current.state.error).toBeNull();
    expect(result.current.state.summary).toEqual(summaryOf(OCTOBER));
    expect(mocks.periodSummary).toHaveBeenCalledTimes(2);
    expect(mocks.periodSummary).toHaveBeenLastCalledWith(inputOf(NOVEMBER), {
      signal: expect.any(AbortSignal),
    });

    await act(async () => {
      second.resolve(summaryOf(NOVEMBER));
      await second.promise;
    });
    await waitFor(() => expect(result.current.state.isLoading).toBe(false));
    expect(result.current.state.summary).toEqual(summaryOf(NOVEMBER));
  });

  it("se o novo período falha sem cópia, os números do outro período não ficam", async () => {
    const { rerender, result } = mount({ copyMonth: null, period: OCTOBER });
    await waitFor(() => expect(result.current.state.isLoading).toBe(false));
    mocks.periodSummary.mockRejectedValueOnce(rpcError("BAD_REQUEST", 400));

    rerender({ copyMonth: null, period: NOVEMBER });
    await waitFor(() => expect(result.current.state.isLoading).toBe(false));

    expect(result.current.state.summary).toBeNull();
    expect(result.current.state.error).toBe(
      "Não foi possível calcular o resultado deste período. Escolha outro período."
    );
  });
});

describe("usePeriodSummary: falha da leitura", () => {
  it("sem resposta e sem cópia: texto de leitura, sem lançar", async () => {
    mocks.periodSummary.mockRejectedValue(noAnswer());
    const { result } = mount({ copyMonth: "2026-10", period: OCTOBER });

    await waitFor(() => expect(result.current.state.isLoading).toBe(false));

    expect(result.current.state).toEqual({
      error: NO_COPY_ERROR,
      isLoading: false,
      serverFailed: false,
      source: "server",
      summary: null,
    });
    expect(mocks.periodSummary).toHaveBeenCalledTimes(1);
  });

  it("período sem mês de cópia diz que só abre com internet e ignora a cópia guardada", async () => {
    keepCopyOf(OCTOBER);
    mocks.periodSummary.mockRejectedValue(noAnswer());
    const { result } = mount({ copyMonth: null, period: OCTOBER });

    await waitFor(() => expect(result.current.state.isLoading).toBe(false));

    expect(result.current.state.error).toBe(ONLY_ONLINE_ERROR);
    expect(result.current.state.summary).toBeNull();
    expect(result.current.state.source).toBe("server");
  });

  it("sem resposta, com cópia do mês guardada: mostra a cópia como cópia", async () => {
    keepCopyOf(OCTOBER);
    mocks.periodSummary.mockRejectedValue(noAnswer());
    const { result } = mount({ copyMonth: "2026-10", period: OCTOBER });

    await waitFor(() => expect(result.current.state.isLoading).toBe(false));

    expect(result.current.state).toEqual({
      error: null,
      isLoading: false,
      serverFailed: false,
      source: "cache",
      summary: summaryOf(OCTOBER, "77.00"),
    });
  });

  it("servidor que respondeu com falha 5xx, com cópia: mostra a cópia e marca serverFailed", async () => {
    keepCopyOf(OCTOBER);
    mocks.periodSummary.mockRejectedValue(
      rpcError("INTERNAL_SERVER_ERROR", 500)
    );
    const { result } = mount({ copyMonth: "2026-10", period: OCTOBER });

    await waitFor(() => expect(result.current.state.isLoading).toBe(false));

    expect(result.current.state).toEqual({
      error: null,
      isLoading: false,
      serverFailed: true,
      source: "cache",
      summary: summaryOf(OCTOBER, "77.00"),
    });
  });

  it("falha 5xx sem cópia: erro do servidor, sem marcar serverFailed", async () => {
    mocks.periodSummary.mockRejectedValue(rpcError("SERVICE_UNAVAILABLE", 503));
    const { result } = mount({ copyMonth: "2026-10", period: OCTOBER });

    await waitFor(() => expect(result.current.state.isLoading).toBe(false));

    expect(result.current.state).toEqual({
      error: "O resultado está temporariamente indisponível. Tente novamente.",
      isLoading: false,
      serverFailed: false,
      source: "server",
      summary: null,
    });
  });

  it("a cópia de outra loja nunca serve a esta", async () => {
    keepCopyOf(OCTOBER, "77.00", NOW_ISO, OTHER_ORG);
    mocks.periodSummary.mockRejectedValue(noAnswer());
    const { result } = mount({ copyMonth: "2026-10", period: OCTOBER });

    await waitFor(() => expect(result.current.state.isLoading).toBe(false));

    expect(result.current.state.error).toBe(NO_COPY_ERROR);
    expect(result.current.state.summary).toBeNull();
  });

  it("a cópia mais velha que os números já na tela não os substitui: fica o erro e os números do servidor", async () => {
    const { result } = mount({ copyMonth: "2026-10", period: OCTOBER });
    await waitFor(() => expect(result.current.state.isLoading).toBe(false));
    keepCopyOf(OCTOBER, "77.00", BEFORE_ISO);
    mocks.periodSummary.mockRejectedValueOnce(noAnswer());

    act(() => {
      result.current.refresh();
    });
    await waitFor(() => expect(result.current.state.error).toBe(NO_COPY_ERROR));

    expect(result.current.state.source).toBe("server");
    expect(result.current.state.summary).toEqual(summaryOf(OCTOBER));
  });

  it("a cópia igual ou mais nova que os números na tela os substitui", async () => {
    const { result } = mount({ copyMonth: "2026-10", period: OCTOBER });
    await waitFor(() => expect(result.current.state.isLoading).toBe(false));
    keepCopyOf(OCTOBER, "77.00", NOW_ISO);
    mocks.periodSummary.mockRejectedValueOnce(noAnswer());

    act(() => {
      result.current.refresh();
    });
    await waitFor(() => expect(result.current.state.source).toBe("cache"));

    expect(result.current.state.summary).toEqual(summaryOf(OCTOBER, "77.00"));
  });

  it("com a cópia na tela, uma nova falha sem cópia tira os números em vez de os manter", async () => {
    keepCopyOf(OCTOBER);
    mocks.periodSummary.mockRejectedValueOnce(noAnswer());
    const { result } = mount({ copyMonth: "2026-10", period: OCTOBER });
    await waitFor(() => expect(result.current.state.source).toBe("cache"));
    window.localStorage.clear();
    mocks.periodSummary.mockRejectedValueOnce(noAnswer());

    act(() => {
      result.current.refresh();
    });
    await waitFor(() => expect(result.current.state.error).toBe(NO_COPY_ERROR));

    expect(result.current.state.summary).toBeNull();
    expect(result.current.state.source).toBe("cache");
  });

  it("recusa do servidor (FORBIDDEN) não usa a cópia guardada", async () => {
    keepCopyOf(OCTOBER);
    mocks.periodSummary.mockRejectedValue(rpcError("FORBIDDEN", 403));
    const { result } = mount({ copyMonth: "2026-10", period: OCTOBER });

    await waitFor(() => expect(result.current.state.isLoading).toBe(false));

    expect(result.current.state.source).toBe("server");
    expect(result.current.state.summary).toBeNull();
    expect(result.current.state.error).toBe(
      "Sua conta não tem acesso ao resultado desta loja."
    );
    expect(copyOf(OCTOBER)).not.toBeNull();
  });
});

describe("usePeriodSummary: sessão encerrada", () => {
  it("UNAUTHORIZED apaga as cópias do navegador e não mostra nenhuma, mesmo com cópia guardada", async () => {
    keepCopyOf(OCTOBER);
    window.localStorage.setItem(`${HOME_COPY_KEY_PREFIX}${ORG}`, "{}");
    window.localStorage.setItem(`${DAILY_SALES_COPY_KEY_PREFIX}${ORG}`, "{}");
    dailySalesMemory.set(ORG, {});
    mocks.periodSummary.mockRejectedValue(rpcError("UNAUTHORIZED", 401));
    const { result } = mount({ copyMonth: "2026-10", period: OCTOBER });

    await waitFor(() => expect(result.current.state.isLoading).toBe(false));

    expect(result.current.state).toEqual({
      error: "Não foi possível carregar o resultado.",
      isLoading: false,
      serverFailed: false,
      source: "server",
      summary: null,
    });
    expect(copyOf(OCTOBER)).toBeNull();
    expect(
      window.localStorage.getItem(`${HOME_COPY_KEY_PREFIX}${ORG}`)
    ).toBeNull();
    expect(
      window.localStorage.getItem(`${DAILY_SALES_COPY_KEY_PREFIX}${ORG}`)
    ).toBeNull();
    expect(dailySalesMemory.has(ORG)).toBe(false);
    expect(mocks.periodSummary).toHaveBeenCalledTimes(1);
  });

  it("outra falha não apaga as cópias", async () => {
    keepCopyOf(OCTOBER);
    mocks.periodSummary.mockRejectedValue(noAnswer());
    const { result } = mount({ copyMonth: "2026-10", period: OCTOBER });

    await waitFor(() => expect(result.current.state.isLoading).toBe(false));

    expect(copyOf(OCTOBER)).not.toBeNull();
  });

  it("com a sessão recusada pelo aparelho a cópia não serve, e continua guardada", async () => {
    keepCopyOf(OCTOBER);
    mocks.snapshot = { sessionRefused: true };
    mocks.periodSummary.mockRejectedValue(noAnswer());
    const { result } = mount({ copyMonth: "2026-10", period: OCTOBER });

    await waitFor(() => expect(result.current.state.isLoading).toBe(false));

    expect(result.current.state).toEqual({
      error: NO_COPY_ERROR,
      isLoading: false,
      serverFailed: false,
      source: "server",
      summary: null,
    });
    expect(copyOf(OCTOBER)).not.toBeNull();
  });
});

describe("usePeriodSummary: resposta mal formada", () => {
  it.each([
    [
      "uma página HTML",
      "<!doctype html><html><body>Entre no Wi-Fi</body></html>",
    ],
    [
      "um objeto sem cards",
      (() => {
        const { cards: _cards, ...withoutCards } = summaryOf(OCTOBER);
        return withoutCards;
      })(),
    ],
  ])(
    "%s é tratada como sem resposta: erro de leitura, nenhum resumo, nenhuma cópia",
    async (_name, body) => {
      mocks.periodSummary.mockResolvedValue(body);
      const { result } = mount({ copyMonth: "2026-10", period: OCTOBER });

      await waitFor(() => expect(result.current.state.isLoading).toBe(false));

      expect(result.current.state).toEqual({
        error: GENERIC_ERROR,
        isLoading: false,
        serverFailed: false,
        source: "server",
        summary: null,
      });
      expect(copyOf(OCTOBER)).toBeNull();
      expect(mocks.periodSummary).toHaveBeenCalledTimes(1);
    }
  );

  it("com cópia do mês guardada, a cópia serve no lugar da resposta que não era do servidor", async () => {
    keepCopyOf(OCTOBER);
    mocks.periodSummary.mockResolvedValue("<html></html>");
    const { result } = mount({ copyMonth: "2026-10", period: OCTOBER });

    await waitFor(() => expect(result.current.state.isLoading).toBe(false));

    expect(result.current.state.source).toBe("cache");
    expect(result.current.state.summary).toEqual(summaryOf(OCTOBER, "77.00"));
  });

  it("depois de uma resposta boa, uma mal formada não apaga os números do mesmo período", async () => {
    const { result } = mount({ copyMonth: null, period: OCTOBER });
    await waitFor(() => expect(result.current.state.isLoading).toBe(false));
    mocks.periodSummary.mockResolvedValueOnce({ cards: null });

    act(() => {
      result.current.refresh();
    });
    await waitFor(() => expect(result.current.state.error).toBe(GENERIC_ERROR));

    expect(result.current.state.error).toBe(GENERIC_ERROR);
    expect(result.current.state.summary).toEqual(summaryOf(OCTOBER));
  });
});

describe("usePeriodSummary: enabled", () => {
  it("com enabled falso não chama o servidor e liga quando enabled passa a verdadeiro", async () => {
    const { rerender, result } = mount({
      copyMonth: null,
      enabled: false,
      period: OCTOBER,
    });

    await settle();
    expect(mocks.periodSummary).not.toHaveBeenCalled();
    expect(result.current.state.summary).toBeNull();

    act(() => {
      markPeriodSummaryStale();
    });
    await settle();
    expect(mocks.periodSummary).not.toHaveBeenCalled();

    rerender({ copyMonth: null, enabled: true, period: OCTOBER });
    await waitFor(() => expect(result.current.state.isLoading).toBe(false));
    expect(mocks.periodSummary).toHaveBeenCalledTimes(1);
    expect(mocks.periodSummary).toHaveBeenCalledWith(inputOf(OCTOBER), {
      signal: expect.any(AbortSignal),
    });
  });
});

describe("usePeriodSummary: troca de loja", () => {
  it("volta ao estado inicial em vez de manter os números da outra loja", async () => {
    const other = deferred<unknown>();
    const { rerender, result } = mount({ copyMonth: null, period: OCTOBER });
    await waitFor(() => expect(result.current.state.isLoading).toBe(false));
    expect(result.current.state.summary).toEqual(summaryOf(OCTOBER));
    mocks.periodSummary.mockReturnValueOnce(other.promise);

    rerender({ copyMonth: null, organizationId: OTHER_ORG, period: OCTOBER });

    expect(result.current.state).toEqual({
      error: null,
      isLoading: true,
      serverFailed: false,
      source: "server",
      summary: null,
    });
    expect(mocks.periodSummary).toHaveBeenCalledTimes(2);
    expect(mocks.periodSummary).toHaveBeenLastCalledWith(
      inputOf(OCTOBER, OTHER_ORG),
      { signal: expect.any(AbortSignal) }
    );

    await act(async () => {
      other.resolve(summaryOf(OCTOBER, "5.00"));
      await other.promise;
    });
    await waitFor(() => expect(result.current.state.isLoading).toBe(false));
    expect(result.current.state.summary?.cards.netSales).toBe("5.00");
  });
});

describe("usePeriodSummary: releitura depois de uma gravação", () => {
  it("com a tela à frente e com conexão, relê uma vez por gravação e nada sem gravação", async () => {
    const { result } = mount({ copyMonth: null, period: OCTOBER });
    await waitFor(() => expect(result.current.state.isLoading).toBe(false));
    await settle();
    expect(mocks.periodSummary).toHaveBeenCalledTimes(1);

    act(() => {
      markPeriodSummaryStale();
    });
    await waitFor(() => expect(mocks.periodSummary).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.state.isLoading).toBe(false));
    await settle();
    expect(mocks.periodSummary).toHaveBeenCalledTimes(2);

    act(() => {
      markPeriodSummaryStale();
    });
    await waitFor(() => expect(mocks.periodSummary).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(result.current.state.isLoading).toBe(false));
    await settle();

    expect(mocks.periodSummary).toHaveBeenCalledTimes(3);
    expect(mocks.periodSummary.mock.calls.map(([input]) => input)).toEqual([
      inputOf(OCTOBER),
      inputOf(OCTOBER),
      inputOf(OCTOBER),
    ]);
  });

  it("sem conexão espera, e relê uma vez quando ela volta", async () => {
    const { rerender, result } = mount({ copyMonth: null, period: OCTOBER });
    await waitFor(() => expect(result.current.state.isLoading).toBe(false));
    mocks.online = false;
    rerender({ copyMonth: null, period: OCTOBER });

    act(() => {
      markPeriodSummaryStale();
    });
    await settle();
    expect(mocks.periodSummary).toHaveBeenCalledTimes(1);

    mocks.online = true;
    rerender({ copyMonth: null, period: OCTOBER });
    await waitFor(() => expect(mocks.periodSummary).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.state.isLoading).toBe(false));
    mocks.online = false;
    rerender({ copyMonth: null, period: OCTOBER });
    mocks.online = true;
    rerender({ copyMonth: null, period: OCTOBER });
    await settle();

    expect(mocks.periodSummary).toHaveBeenCalledTimes(2);
  });

  it("com a tela atrás (active falso) espera, e relê uma vez quando volta à frente", async () => {
    const { rerender, result } = mount({
      active: false,
      copyMonth: null,
      period: OCTOBER,
    });
    await waitFor(() => expect(result.current.state.isLoading).toBe(false));

    act(() => {
      markPeriodSummaryStale();
    });
    await settle();
    expect(mocks.periodSummary).toHaveBeenCalledTimes(1);

    rerender({ active: true, copyMonth: null, period: OCTOBER });
    await waitFor(() => expect(mocks.periodSummary).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.state.isLoading).toBe(false));
    mocks.online = false;
    rerender({ active: true, copyMonth: null, period: OCTOBER });
    mocks.online = true;
    rerender({ active: true, copyMonth: null, period: OCTOBER });
    await settle();

    expect(mocks.periodSummary).toHaveBeenCalledTimes(2);
  });

  it("a leitura que o período novo já começou leva a gravação: não se pede duas vezes", async () => {
    const { rerender, result } = mount({
      active: false,
      copyMonth: null,
      period: OCTOBER,
    });
    await waitFor(() => expect(result.current.state.isLoading).toBe(false));
    act(() => {
      markPeriodSummaryStale();
    });

    rerender({ active: true, copyMonth: null, period: NOVEMBER });
    await waitFor(() => expect(result.current.state.isLoading).toBe(false));
    await settle();

    expect(mocks.periodSummary).toHaveBeenCalledTimes(2);
    expect(mocks.periodSummary).toHaveBeenLastCalledWith(inputOf(NOVEMBER), {
      signal: expect.any(AbortSignal),
    });
    expect(result.current.state.summary?.period).toEqual(NOVEMBER);
  });

  it("uma leitura que falha gasta a marca: não tenta de novo sozinha", async () => {
    const { rerender, result } = mount({ copyMonth: null, period: OCTOBER });
    await waitFor(() => expect(result.current.state.isLoading).toBe(false));
    mocks.periodSummary.mockRejectedValueOnce(noAnswer());

    act(() => {
      markPeriodSummaryStale();
    });
    await waitFor(() => expect(mocks.periodSummary).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(result.current.state.error).toBe(ONLY_ONLINE_ERROR)
    );
    mocks.online = false;
    rerender({ copyMonth: null, period: OCTOBER });
    mocks.online = true;
    rerender({ copyMonth: null, period: OCTOBER });
    await settle();

    expect(mocks.periodSummary).toHaveBeenCalledTimes(2);
  });

  it("a gravação que chega com a leitura em andamento leva uma releitura, e a resposta da primeira não vale", async () => {
    const first = deferred<unknown>();
    mocks.periodSummary
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(summaryOf(OCTOBER, "222.00"));
    const { result } = mount({ copyMonth: null, period: OCTOBER });

    act(() => {
      markPeriodSummaryStale();
    });
    await waitFor(() => expect(mocks.periodSummary).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.state.isLoading).toBe(false));
    await act(async () => {
      first.resolve(summaryOf(OCTOBER, "111.00"));
      await first.promise;
    });
    await settle();

    expect(result.current.state.summary?.cards.netSales).toBe("222.00");
    expect(mocks.periodSummary).toHaveBeenCalledTimes(2);
  });
});
