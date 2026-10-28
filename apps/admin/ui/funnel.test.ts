import { activationFunnelResponse } from "@polaris/contracts/admin-activation-funnel";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PROBLEM_TEXT } from "./api";
import {
  buttons,
  byId,
  byTag,
  type FakeElement,
  visibleText,
} from "./test-dom";
import { alertOf, type Call, flush, json, mount, OWNER } from "./test-page";
import type { ActivationFunnelResponse } from "./types";

/**
 * The funnel's area (corte admin-tela-v1, AC-7 and AC-8): one read when the area is opened and one per click on
 * "Atualizar", nothing else, not even with the clock moving hours ahead; a 429 shows the server's wait in minutes and
 * is not repeated; every number, share and "não disponível" is the contract's.
 */

const shown = (value: number) => ({ reason: null, value });
const missing = (
  reason: "activation_window_open" | "suppressed" | "week_not_closed"
) => ({ reason, value: null });

/**
 * Two weeks of the contract. The shares do not match the counts on purpose (7 of 10 is said to be 33.3%): the page
 * must show the server's share, never one of its own.
 */
function funnel(weeks = 2): ActivationFunnelResponse {
  const week = (index: number) => ({
    inProgress: index === weeks - 1,
    week: `2026-W${String(41 + index).padStart(2, "0")}`,
    weekStart: new Date(Date.UTC(2026, 9, 5 + 7 * index))
      .toISOString()
      .slice(0, 10),
  });
  return activationFunnelResponse.parse({
    activeStores: Array.from({ length: weeks }, (_x, index) => ({
      ...week(index),
      stores: index === 0 ? shown(31) : missing("week_not_closed"),
    })),
    cohorts: Array.from({ length: weeks }, (_x, index) => ({
      ...week(index),
      activatedIn7Days:
        index === 0 ? shown(6) : missing("activation_window_open"),
      percent: {
        activatedIn7Days:
          index === 0 ? shown(60) : missing("activation_window_open"),
        retentionWeek2: missing("suppressed"),
        retentionWeek3: missing("week_not_closed"),
        retentionWeek5: missing("week_not_closed"),
        withFirstProduct: index === 0 ? shown(33.3) : missing("suppressed"),
        withFirstSale: index === 0 ? shown(50) : missing("suppressed"),
      },
      retention: {
        week2: missing("suppressed"),
        week3: missing("week_not_closed"),
        week5: missing("week_not_closed"),
      },
      stores: index === 0 ? shown(10) : missing("suppressed"),
      timeToFirstSale: {
        after7Days: missing("suppressed"),
        upTo1Day: missing("suppressed"),
        upTo1Hour: missing("suppressed"),
        upTo7Days: missing("suppressed"),
        upTo10Minutes: index === 0 ? shown(5) : missing("suppressed"),
      },
      withFirstProduct: index === 0 ? shown(7) : missing("suppressed"),
      withFirstSale: index === 0 ? shown(5) : missing("suppressed"),
      withoutSale: index === 0 ? shown(5) : missing("suppressed"),
    })),
    internalStoresExcluded: 3,
    minimumStores: 5,
    notCounted: {
      internalStores:
        "Lojas internas (de teste, do dono e do time) ficam fora de todos os números de lojas; internalStoresExcluded diz quantas foram criadas na janela.",
      purgedStores: "Lojas já apagadas não entram em nenhum número.",
      signups:
        "Cadastros contam só contas verificadas que ainda existem, e incluem as contas internas (elas não têm marcador).",
    },
    signups: Array.from({ length: weeks }, (_x, index) => ({
      ...week(index),
      accounts: index === 0 ? shown(12) : missing("suppressed"),
      percentWithStore: index === 0 ? shown(75) : missing("suppressed"),
      withStore: index === 0 ? shown(9) : missing("suppressed"),
    })),
    timezone: "America/Sao_Paulo",
    updatedAt: "2026-10-28T14:00:00.000Z",
    weeks,
  });
}

const MISSING = /^não disponível \(/;

const toggleOf = (root: FakeElement) =>
  buttons(root, "Abrir o funil")[0] ?? buttons(root, "Fechar o funil")[0];
const refreshOf = (root: FakeElement) => buttons(root, "Atualizar")[0];
const funnelCalls = (calls: Call[]) =>
  calls.filter((call) => call.path.startsWith("/api/funnel"));

async function openFunnel(answers: Parameters<typeof mount>[0]) {
  const page = await mount(answers);
  toggleOf(page.root)?.click();
  await flush();
  return page;
}

/** A clock the test moves; `setImmediate` stays real, so the answers still arrive. */
const useClock = () =>
  vi.useFakeTimers({
    now: new Date("2026-10-28T15:00:00.000Z"),
    toFake: [
      "Date",
      "setTimeout",
      "clearTimeout",
      "setInterval",
      "clearInterval",
    ],
  });

afterEach(() => {
  vi.useRealTimers();
});

describe("reading the funnel (AC-7)", () => {
  it("reads nothing until the area is opened, then once, with the default 12 weeks", async () => {
    const page = await mount([json(funnel(12))]);
    expect(funnelCalls(page.calls)).toEqual([]);
    expect(byId(page.root, "funil-corpo").hasAttribute("hidden")).toBe(true);
    toggleOf(page.root)?.click();
    await flush();
    expect(funnelCalls(page.calls).map((call) => call.path)).toEqual([
      "/api/funnel?weeks=12",
    ]);
    expect(funnelCalls(page.calls)[0]?.init).toMatchObject({
      method: "GET",
      redirect: "manual",
    });
    expect(byId(page.root, "funil-corpo").hasAttribute("hidden")).toBe(false);
  });

  it("does not read again when the area is closed and opened, the weeks change or hours go by", async () => {
    useClock();
    const page = await openFunnel([json(funnel(12))]);
    toggleOf(page.root)?.click();
    toggleOf(page.root)?.click();
    const weeks = byId(page.root, "funil-semanas");
    weeks.value = "4";
    weeks.dispatch("change");
    await vi.advanceTimersByTimeAsync(3 * 60 * 60 * 1000);
    await flush();
    expect(funnelCalls(page.calls)).toHaveLength(1);
    expect(visibleText(page.root)).toContain(
      "Mostrando 12 semanas. Use Atualizar para ler 4 semanas."
    );
  });

  it("reads once per click on Atualizar, with the weeks chosen, and a double click asks once", async () => {
    let answer: (response: Response) => void = () => undefined;
    const pending = () =>
      new Promise<Response>((resolve) => {
        answer = resolve;
      });
    const page = await openFunnel([json(funnel(12)), pending]);
    const weeks = byId(page.root, "funil-semanas");
    weeks.value = "26";
    weeks.dispatch("change");
    refreshOf(page.root)?.click();
    refreshOf(page.root)?.click();
    expect(refreshOf(page.root)?.getAttribute("aria-disabled")).toBe("true");
    answer(json(funnel(26)));
    await flush();
    expect(funnelCalls(page.calls).map((call) => call.path)).toEqual([
      "/api/funnel?weeks=12",
      "/api/funnel?weeks=26",
    ]);
    expect(refreshOf(page.root)?.getAttribute("aria-disabled")).toBe("false");
  });

  it.each([
    [125, "3 minutos"],
    [60, "1 minuto"],
    [3600, "60 minutos"],
  ])(
    "says the limit with the server's wait (%i s → %s), focuses it and does not ask again",
    async (seconds, minutes) => {
      useClock();
      const page = await openFunnel([
        new Response(JSON.stringify({ error: "rate_limited" }), {
          headers: {
            "content-type": "application/json",
            "retry-after": String(seconds),
          },
          status: 429,
        }),
      ]);
      const alert = alertOf(page.root);
      expect(alert?.textContent).toBe(
        `Limite de leituras do funil por hora atingido. Tente de novo em ${minutes}.`
      );
      expect(page.document.activeElement).toBe(alert);
      await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000);
      await flush();
      expect(funnelCalls(page.calls)).toHaveLength(1);
    }
  );

  it("says the limit without a number when the server gave no wait", async () => {
    const page = await openFunnel([json({ error: "rate_limited" }, 429)]);
    expect(alertOf(page.root)?.textContent).toBe(
      "Limite de leituras do funil por hora atingido. Tente de novo mais tarde."
    );
  });

  it.each([
    [json({ error: "internal_error" }, 500), PROBLEM_TEXT.failed],
    [json({ error: "unavailable" }, 503), PROBLEM_TEXT.unavailable],
    [json({ error: "forbidden" }, 403), PROBLEM_TEXT.forbidden],
    [new TypeError("Failed to fetch"), PROBLEM_TEXT.network],
  ])(
    "shows a failure in words and does not repeat the read",
    async (answer, text) => {
      const page = await openFunnel([answer]);
      expect(alertOf(page.root)?.textContent).toBe(text);
      expect(funnelCalls(page.calls)).toHaveLength(1);
    }
  );

  it("shows no funnel to an operator without platform:read, and says why (AC-3)", async () => {
    const page = await mount(
      [],
      json({ ...OWNER, capabilities: ["organization:diagnose"] })
    );
    expect(toggleOf(page.root)).toBeUndefined();
    const area = byTag(page.root, "section").find((section) =>
      section.textContent.startsWith("Funil de ativação")
    );
    expect(area?.textContent).toContain(PROBLEM_TEXT.forbidden);
  });
});

describe("what the funnel shows (AC-8)", () => {
  const cells = (root: FakeElement, caption: string) => {
    const found = byTag(root, "table").find(
      (table) => table.querySelector("caption")?.textContent === caption
    );
    return byTag(found as FakeElement, "tr")
      .slice(1)
      .map((row) => byTag(row, "td").map((cell) => cell.textContent));
  };

  it("shows the server's numbers and shares, never its own", async () => {
    const page = await openFunnel([json(funnel())]);
    expect(
      cells(page.root, "Lojas criadas em cada semana e o que fizeram")[0]
    ).toEqual([
      "semana de 05/10/2026",
      "10",
      "7 (33,3%)",
      "5 (50%)",
      "6 (60%)",
      "não disponível (grupo pequeno)",
      "não disponível (semana em andamento)",
      "não disponível (semana em andamento)",
    ]);
    expect(cells(page.root, "Cadastros por semana")[0]).toEqual([
      "semana de 05/10/2026",
      "12",
      "9 (75%)",
    ]);
    expect(cells(page.root, "Lojas ativas por semana")[0]).toEqual([
      "semana de 05/10/2026",
      "31",
    ]);
    expect(visibleText(page.root)).toContain(
      "Funil de 2 semanas, atualizado em 28/10/2026 11:00."
    );
  });

  it("says why each missing number is missing, never 0 nor an empty cell", async () => {
    const page = await openFunnel([json(funnel())]);
    const captions = [
      "Cadastros por semana",
      "Lojas criadas em cada semana e o que fizeram",
      "Tempo até a 1ª venda, por semana de criação da loja",
      "Lojas ativas por semana",
    ];
    const secondWeek = captions.flatMap(
      (caption) => cells(page.root, caption)[1] ?? []
    );
    expect(secondWeek.filter((cell) => cell.startsWith("semana de"))).toEqual(
      new Array(4).fill("semana de 12/10/2026 (em andamento)")
    );
    for (const cell of secondWeek.filter(
      (text) => !text.startsWith("semana")
    )) {
      expect(cell).toMatch(MISSING);
    }
    const all = captions.flatMap((caption) => cells(page.root, caption).flat());
    expect(all).not.toContain("0");
    expect(all).not.toContain("");
  });

  it("says what the numbers leave out, with the count of internal stores of the answer", async () => {
    const page = await openFunnel([json(funnel())]);
    const text = visibleText(page.root);
    expect(text).toContain(
      "Fora de todos os números de lojas: 3 lojas internas criadas na janela (de teste, do dono e do time)."
    );
    expect(text).toContain("Lojas já apagadas não entram em nenhum número.");
    expect(text).toContain(
      "Cadastros contam só contas verificadas que ainda existem, e incluem as contas internas (elas não têm marcador)."
    );
    expect(text).toContain(
      'Grupos com menos de 5 lojas aparecem como "não disponível", nunca como 0.'
    );
  });
});
