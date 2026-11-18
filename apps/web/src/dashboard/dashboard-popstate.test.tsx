// @vitest-environment happy-dom
import { act, cleanup, render, screen } from "@testing-library/react";
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
  useComparisonDays: () => null,
  useComparisonSales: () => null,
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
 * The period is read from the address once, when the screen mounts (`useState` initializer); the layout effect only
 * writes it back. Another step of the history on the same route (a `popstate`) therefore leaves the period on
 * screen as it was while the address names the other one.
 */
describe("Resultado: o período do endereço e o popstate", () => {
  it("monta lendo o período do endereço e o endereço guarda o atalho", () => {
    render(<DashboardPage />);
    expect(lastRequested()).toEqual({ from: "2026-01-01", to: "2026-10-14" });
    expect(searchParams().get("periodo")).toBe("este-ano");
    expect(periodButton()).toBe("Período: 01/01 a 14/10, editar");
  });

  it("popstate para outro período da mesma rota não relê o período: a tela segue no que abriu e o endereço fica no do passo", () => {
    render(<DashboardPage />);
    const opened = lastRequested();

    goTo("?screen=dashboard&periodo=30-dias");

    expect(lastRequested()).toEqual(opened);
    expect(requested.every((period) => sameAs(period, opened))).toBe(true);
    expect(periodButton()).toBe("Período: 01/01 a 14/10, editar");
    expect(searchParams().get("periodo")).toBe("30-dias");
  });
});

function sameAs(a: Period, b: Period | undefined) {
  return a.from === b?.from && a.to === b?.to;
}
