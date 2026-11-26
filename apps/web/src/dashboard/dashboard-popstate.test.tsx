// @vitest-environment happy-dom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardPage } from "./dashboard-page";
import type { Period } from "./result-period";

const NOW = new Date("2026-10-14T15:00:00.000Z");
const requested: Period[] = [];

vi.mock("../lib/current-organization", () => ({
  useCurrentOrganization: () => ({
    organization: { role: "owner", timezone: "America/Sao_Paulo" },
    organizationId: "org-a",
  }),
}));
vi.mock("../lib/browser-connection", () => ({
  useConnectionOnline: () => true,
}));
vi.mock("../offline/runtime/runtime-context", () => ({
  useRuntimeSnapshot: () => ({ status: "unavailable" }),
}));
vi.mock("./use-goals", () => ({
  useGoals: () => ({
    reload: () => undefined,
    state: { error: null, goals: [], isLoading: true },
  }),
}));
vi.mock("./use-period-summary", () => ({
  useComparisonReads: () => ({ comparison: null, salesComparison: null }),
  usePeriodSummary: (_organization: string, period: Period) => {
    requested.push(period);
    return {
      refresh: () => undefined,
      state: {
        error: null,
        isLoading: true,
        serverFailed: false,
        source: "server",
        summary: null,
      },
    };
  },
}));

const lastRequested = () => requested.at(-1);
const PERIOD_BUTTON = /^Período: /;
const THIRTY_DAYS = /30 dias/;
const periodButton = () =>
  screen
    .getByRole("button", { name: PERIOD_BUTTON })
    .getAttribute("aria-label");
const searchParams = () => new URLSearchParams(window.location.search);

function goTo(search: string) {
  window.history.pushState(null, "", `/${search}`);
  act(() => {
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  requested.length = 0;
  window.history.replaceState(null, "", "/?screen=dashboard&periodo=este-ano");
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/**
 * The period is read from the address when the screen mounts and again at every step of the history to another address
 * of the same route; each change of period is one read of the figures, whoever asked for it.
 */
describe("Resultado: o período do endereço e o popstate", () => {
  it("monta lendo o período do endereço e o endereço guarda o atalho, com uma só leitura", () => {
    render(<DashboardPage />);
    expect(lastRequested()).toEqual({ from: "2026-01-01", to: "2026-10-14" });
    expect(searchParams().get("periodo")).toBe("este-ano");
    expect(periodButton()).toBe("Período: 01/01 a 14/10, editar");
    expect(reads()).toEqual([{ from: "2026-01-01", to: "2026-10-14" }]);
  });

  it("popstate para outro período da mesma rota relê o período: tela e números seguem o endereço", () => {
    render(<DashboardPage />);

    goTo("?screen=dashboard&periodo=30-dias");

    const last30 = { from: "2026-09-15", to: "2026-10-14" };
    expect(lastRequested()).toEqual(last30);
    expect(reads()).toEqual([{ from: "2026-01-01", to: "2026-10-14" }, last30]);
    expect(periodButton()).toBe("Período: 15/09 a 14/10, editar");
    expect(searchParams().get("periodo")).toBe("30-dias");
  });

  it("popstate para um endereço sem período volta ao padrão do Resultado", () => {
    render(<DashboardPage />);

    goTo("?screen=dashboard");

    expect(lastRequested()).toEqual({ from: "2026-10-01", to: "2026-10-31" });
    expect(searchParams().get("periodo")).toBeNull();
  });

  it("popstate para um intervalo do endereço lê esse intervalo como Período", () => {
    render(<DashboardPage />);

    goTo("?screen=dashboard&de=2026-09-01&ate=2026-09-10");

    expect(lastRequested()).toEqual({ from: "2026-09-01", to: "2026-09-10" });
    expect(periodButton()).toBe("Período: 01/09 a 10/09, editar");
    expect(searchParams().get("de")).toBe("2026-09-01");
  });

  it("o período que o Histórico deixa no estado da entrada vale sobre o endereço sem período", () => {
    window.history.replaceState(
      { resultPeriod: { from: "2026-09-01", to: "2026-09-10" } },
      "",
      "/?screen=dashboard"
    );

    render(<DashboardPage />);

    expect(reads()).toEqual([{ from: "2026-09-01", to: "2026-09-10" }]);
    expect(searchParams().get("de")).toBe("2026-09-01");
    expect(searchParams().get("ate")).toBe("2026-09-10");
  });

  it("popstate que não muda o período não relê nada", () => {
    render(<DashboardPage />);

    goTo("?screen=dashboard&periodo=este-ano");
    goTo("?screen=dashboard&periodo=este-ano&aba=resultado");

    expect(reads()).toEqual([{ from: "2026-01-01", to: "2026-10-14" }]);
    expect(periodButton()).toBe("Período: 01/01 a 14/10, editar");
  });

  it("escolher o período no seletor lê uma vez e o endereço que a escolha escreveu não relê de novo", async () => {
    render(<DashboardPage />);

    fireEvent.click(screen.getByRole("button", { name: PERIOD_BUTTON }));
    fireEvent.click(await screen.findByRole("button", { name: THIRTY_DAYS }));

    const last30 = { from: "2026-09-15", to: "2026-10-14" };
    expect(reads()).toEqual([{ from: "2026-01-01", to: "2026-10-14" }, last30]);
    expect(searchParams().get("periodo")).toBe("30-dias");
  });
});

function reads() {
  return requested.filter(
    (period, index) => index === 0 || !sameAs(period, requested[index - 1])
  );
}

function sameAs(a: Period, b: Period | undefined) {
  return a.from === b?.from && a.to === b?.to;
}
