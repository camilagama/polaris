// @vitest-environment happy-dom
import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StoredPeriodSummary } from "../lib/period-summary-cache";
import { KpiCards } from "./home-kpi-cards";
import type { HomeFigures } from "./use-home";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const TODAY = "2026-10-23";

function daily(from: string, to: string, net: string) {
  const out: Record<string, string | number>[] = [];
  for (
    let moment = Date.parse(`${from}T00:00:00Z`);
    moment <= Date.parse(`${to}T00:00:00Z`);
    moment += 86_400_000
  ) {
    out.push({
      costs: "5.00",
      date: new Date(moment).toISOString().slice(0, 10),
      netSales: net,
      operatingExpenses: "0.00",
      operatingResult: "5.00",
      salesCount: 1,
    });
  }
  return out;
}

function figures(today = TODAY): HomeFigures {
  return {
    before: {
      cards: { netSales: "300.00", operatingResult: "150.00", salesCount: 30 },
      daily: daily("2026-09-01", "2026-09-30", "10.00"),
      period: { from: "2026-09-01", to: "2026-09-30" },
      quality: { itemLines: 30, itemLinesWithUnknownCost: 0 },
    } as unknown as StoredPeriodSummary,
    month: {
      cards: {
        marginPercent: "70.00",
        netSales: "460.00",
        operatingResult: "345.00",
        salesCount: 23,
        ticket: "20.00",
      },
      daily: daily("2026-10-01", today, "20.00"),
      generatedAt: "2026-10-23T15:00:00.000Z",
      period: { from: "2026-10-01", to: "2026-10-31" },
      quality: {
        itemLines: 23,
        itemLinesWithUnknownCost: 0,
        level: "complete",
      },
    } as unknown as StoredPeriodSummary,
    today,
  };
}

function todayCard(host: HTMLElement) {
  const section = host.querySelector<HTMLElement>('[data-kpi="sales"]');
  const title = section?.querySelector<HTMLElement>("#home-today");
  const range = section?.querySelector<HTMLInputElement>('input[type="range"]');
  if (!(title && range)) {
    throw new Error("the Vendas hoje tile has no title or day control");
  }
  return { range, title };
}

/** What a screen reader would say for a change of the title: its text, when the title was already a live region before the change (a region that becomes live in the same commit as its text stays mute). */
function watchAnnouncements(title: HTMLElement) {
  const said: string[] = [];
  const isLive = () => title.getAttribute("aria-live") === "polite";
  let liveBefore = isLive();
  let textBefore = title.textContent;
  const observer = new MutationObserver(() => {
    const text = title.textContent;
    if (liveBefore && text !== textBefore) {
      said.push(text ?? "");
    }
    liveBefore = isLive();
    textBefore = text;
  });
  observer.observe(title, {
    attributes: true,
    characterData: true,
    childList: true,
    subtree: true,
  });
  return {
    said,
    stop: () => observer.disconnect(),
  };
}

const flush = () => act(async () => undefined);

afterEach(() => {
  vi.useRealTimers();
});

describe("Vendas hoje anda pelos dias", () => {
  it("com o controle de dias em foco, a data só aparece no aria-valuetext e o título não a anuncia", async () => {
    const { container, unmount } = render(<KpiCards figures={figures()} />);
    const { range, title } = todayCard(container);
    act(() => range.focus());
    const watch = watchAnnouncements(title);
    fireEvent.change(range, {
      target: { value: String(Number(range.value) - 1) },
    });
    await flush();
    expect(range.getAttribute("aria-valuetext")).toContain("22/10");
    expect(title.textContent).toBe("Vendas em 22/10");
    expect(title.getAttribute("aria-live")).toBeNull();
    expect(watch.said).toEqual([]);
    watch.stop();
    unmount();
  });

  it("sem o controle em foco, a mudança do título continua anunciada (o caminho do ponteiro no gráfico usa o mesmo título vivo)", async () => {
    const { container, unmount } = render(<KpiCards figures={figures()} />);
    const { range, title } = todayCard(container);
    const watch = watchAnnouncements(title);
    fireEvent.change(range, {
      target: { value: String(Number(range.value) - 1) },
    });
    await flush();
    expect(title.getAttribute("aria-live")).toBe("polite");
    expect(watch.said).toContain("Vendas em 22/10");
    watch.stop();
    unmount();
  });

  it("ao sair do controle, o título volta a ser região viva", async () => {
    const { container, unmount } = render(<KpiCards figures={figures()} />);
    const { range, title } = todayCard(container);
    act(() => range.focus());
    expect(title.getAttribute("aria-live")).toBeNull();
    act(() => range.blur());
    await flush();
    expect(title.getAttribute("aria-live")).toBe("polite");
    unmount();
  });

  it("ao sair do controle, a região volta a ser viva antes de o texto voltar a Vendas hoje, e a volta é anunciada", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { container, unmount } = render(<KpiCards figures={figures()} />);
    const { range, title } = todayCard(container);
    act(() => range.focus());
    fireEvent.change(range, {
      target: { value: String(Number(range.value) - 1) },
    });
    expect(title.textContent).toBe("Vendas em 22/10");
    const watch = watchAnnouncements(title);
    act(() => range.blur());
    await flush();
    expect(title.getAttribute("aria-live")).toBe("polite");
    expect(title.textContent).toBe("Vendas em 22/10");
    expect(watch.said).toEqual([]);
    await act(() => vi.advanceTimersByTimeAsync(100));
    expect(title.getAttribute("aria-live")).toBe("polite");
    expect(title.textContent).toBe("Vendas hoje");
    expect(watch.said).toContain("Vendas hoje");
    watch.stop();
    unmount();
  });

  it("voltar ao controle antes de o texto voltar cancela a volta e mantém o dia lido", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { container, unmount } = render(<KpiCards figures={figures()} />);
    const { range, title } = todayCard(container);
    act(() => range.focus());
    fireEvent.change(range, {
      target: { value: String(Number(range.value) - 1) },
    });
    act(() => range.blur());
    act(() => range.focus());
    await act(() => vi.advanceTimersByTimeAsync(500));
    expect(title.textContent).toBe("Vendas em 22/10");
    expect(title.getAttribute("aria-live")).toBeNull();
    unmount();
  });
});
