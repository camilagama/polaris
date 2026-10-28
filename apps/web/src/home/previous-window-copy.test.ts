import { beforeEach, describe, expect, it } from "vitest";
import type { PreferenceStorage } from "../lib/current-organization-model";
import {
  clearOrganizationResultCopies,
  clearPeriodSummaryCaches,
  HOME_COPY_KEY_PREFIX,
  previousWindowMemory,
  type StoredPeriodSummary,
} from "../lib/period-summary-cache";
import { readHomeCopy, writeHomeCopy } from "./home-copy";
import { homePeriods } from "./home-model";
import {
  invalidatePreviousWindow,
  rememberPreviousWindow,
  reusablePreviousWindow,
} from "./previous-window-copy";

const ORG = "0199c2d0-0000-7000-8000-00000000a001";
const OTHER = "0199c2d0-0000-7000-8000-00000000a002";
const ZONE = "America/Sao_Paulo";
const DAY = 86_400_000;
const KEY = `${HOME_COPY_KEY_PREFIX}${ORG}`;
/** 23/10 at noon of the store (UTC-3), and the same period B of that day. */
const TODAY = "2026-10-23";
const READ_AT = "2026-10-23T15:00:00.000Z";
const PERIOD = homePeriods(TODAY).before;

function memoryStorage() {
  const values = new Map<string, string>();
  const storage: PreferenceStorage & Pick<Storage, "key" | "length"> = {
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
  return { storage, values };
}

function datesOf(from: string, to: string): string[] {
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

function summary(
  period: { from: string; to: string },
  generatedAt: string,
  withDaily = true
): StoredPeriodSummary {
  return {
    cards: {
      items: 3,
      marginPercent: "52.69",
      netSales: "130.00",
      operatingResult: "38.50",
      salesCount: 2,
      ticket: "65.00",
    },
    chain: {
      anticipationFees: "0.00",
      cogs: "60.00",
      commercialSurcharges: "5.00",
      contributionMargin: "68.50",
      discounts: "10.00",
      estimatedOperatingResult: "38.50",
      grossProfit: "70.00",
      grossSales: "150.00",
      linkedExpenses: "2.00",
      netSales: "130.00",
      operatingExpenses: "30.00",
      processingFees: "4.50",
      returns: "10.00",
    },
    ...(withDaily
      ? {
          daily: datesOf(period.from, period.to).map((date) => ({
            date,
            netSales: "0.00",
            salesCount: 0,
          })),
        }
      : {}),
    generatedAt,
    period,
    quality: {
      anticipationFeesUnknown: 0,
      itemLines: 2,
      itemLinesWithUnknownCost: 0,
      level: "complete",
      linkedExpenses: 1,
      missing: [],
      operatingExpenses: 1,
      processingFeesUnknown: 0,
      salesCount: 2,
    },
  };
}

const before = (at = READ_AT) => summary(PERIOD, at);
const reuse = (
  storage: PreferenceStorage | null,
  day = TODAY,
  period = homePeriods(day).before
) => reusablePreviousWindow(storage, ORG, period, day, ZONE);

describe("a janela anterior do Início tirada da cópia do dia", () => {
  beforeEach(() => clearPeriodSummaryCaches(null));

  it("no mesmo dia da loja e no mesmo período, serve a cópia da memória da página", () => {
    rememberPreviousWindow(ORG, before());

    expect(reuse(null)).toEqual(before());
  });

  it("no dia seguinte da loja, não serve", () => {
    rememberPreviousWindow(ORG, before());

    expect(reuse(null, "2026-10-24")).toBeNull();
  });

  it("o dia é o da loja, não o do UTC: 22h de 23/10 em São Paulo já é 24/10 em UTC", () => {
    rememberPreviousWindow(ORG, before("2026-10-24T01:30:00.000Z"));

    expect(reuse(null, "2026-10-23")).not.toBeNull();
    expect(reuse(null, "2026-10-24")).toBeNull();
  });

  it("de outro período, não serve, mesmo no mesmo dia", () => {
    rememberPreviousWindow(ORG, before());

    expect(
      reuse(null, TODAY, { from: PERIOD.from, to: "2026-09-29" })
    ).toBeNull();
    expect(
      reuse(null, TODAY, { from: "2026-08-01", to: PERIOD.to })
    ).toBeNull();
  });

  it("na virada do mês o período muda e a cópia do mês anterior não serve", () => {
    rememberPreviousWindow(ORG, before("2026-10-31T15:00:00.000Z"));

    expect(reuse(null, "2026-11-01")).toBeNull();
  });

  it("nunca serve a cópia de outra loja", () => {
    rememberPreviousWindow(ORG, before());

    expect(reusablePreviousWindow(null, OTHER, PERIOD, TODAY, ZONE)).toBeNull();
  });

  it("não guarda uma cópia sem a série diária (a tela precisa dela)", () => {
    rememberPreviousWindow(ORG, summary(PERIOD, READ_AT, false));

    expect(previousWindowMemory.has(ORG)).toBe(false);
    expect(reuse(null)).toBeNull();
  });

  it("com o runtime ligado, serve a cópia do aparelho quando a memória da página está vazia", () => {
    const { storage } = memoryStorage();
    writeHomeCopy(storage, ORG, { before: before() });

    expect(reuse(storage)).toEqual(before());
    expect(reuse(storage, "2026-10-24")).toBeNull();
  });

  it("uma cópia do aparelho que não é um resumo não serve", () => {
    const { storage, values } = memoryStorage();
    values.set(
      KEY,
      JSON.stringify({ before: { period: PERIOD }, hadSale: true })
    );

    expect(reuse(storage)).toBeNull();
  });

  it("a recusa da loja leva a cópia junto, da memória e do aparelho", () => {
    const { storage } = memoryStorage();
    rememberPreviousWindow(ORG, before());
    writeHomeCopy(storage, ORG, { before: before() });

    clearOrganizationResultCopies(storage, ORG);

    expect(reuse(storage)).toBeNull();
  });

  it("sair leva a cópia de todas as lojas", () => {
    rememberPreviousWindow(ORG, before());
    rememberPreviousWindow(OTHER, before());

    clearPeriodSummaryCaches(null);

    expect(previousWindowMemory.size).toBe(0);
  });
});

describe("a cópia da janela anterior depois de uma devolução ou cancelamento neste aparelho", () => {
  beforeEach(() => clearPeriodSummaryCaches(null));

  it("uma venda de antes do 1º dia do mês corrente tira a cópia da memória na hora", () => {
    rememberPreviousWindow(ORG, before());

    invalidatePreviousWindow(null, ORG, "2026-09-12");

    expect(reuse(null)).toBeNull();
  });

  it("a venda do último dia antes do mês também tira a cópia", () => {
    rememberPreviousWindow(ORG, before());

    invalidatePreviousWindow(null, ORG, PERIOD.to);

    expect(reuse(null)).toBeNull();
  });

  it("uma venda do mês corrente não mexe na cópia: ela está no A, que é sempre lido", () => {
    rememberPreviousWindow(ORG, before());

    invalidatePreviousWindow(null, ORG, "2026-10-01");
    invalidatePreviousWindow(null, ORG, TODAY);

    expect(reuse(null)).toEqual(before());
  });

  it("sem saber a data da venda, tira a cópia por segurança", () => {
    rememberPreviousWindow(ORG, before());

    invalidatePreviousWindow(null, ORG, null);

    expect(reuse(null)).toBeNull();
  });

  it("marca a cópia do aparelho: ela segue valendo sem internet, mas não vale no lugar de uma leitura", () => {
    const { storage } = memoryStorage();
    rememberPreviousWindow(ORG, before());
    writeHomeCopy(storage, ORG, { before: before() });

    invalidatePreviousWindow(storage, ORG, "2026-09-12");

    expect(reuse(storage)).toBeNull();
    const kept = readHomeCopy(storage, ORG);
    expect(kept?.before).toEqual(before());
    expect(kept?.beforeStale).toBe(true);
  });

  it("a marca não volta atrás ao gravar a meta, mas uma leitura nova do servidor a desfaz", () => {
    const { storage } = memoryStorage();
    writeHomeCopy(storage, ORG, { before: before() });
    invalidatePreviousWindow(storage, ORG, "2026-09-12");

    writeHomeCopy(storage, ORG, { hadSale: true });
    expect(reuse(storage)).toBeNull();

    writeHomeCopy(storage, ORG, { before: before() });
    expect(reuse(storage)).toEqual(before());
  });

  it("sem cópia, não cria uma", () => {
    const { storage, values } = memoryStorage();

    invalidatePreviousWindow(storage, ORG, "2026-09-12");

    expect(values.size).toBe(0);
  });

  it("só tira a cópia da loja da venda", () => {
    rememberPreviousWindow(ORG, before());
    rememberPreviousWindow(OTHER, before());

    invalidatePreviousWindow(null, ORG, "2026-09-12");

    expect(reuse(null)).toBeNull();
    expect(reusablePreviousWindow(null, OTHER, PERIOD, TODAY, ZONE)).toEqual(
      before()
    );
  });
});
