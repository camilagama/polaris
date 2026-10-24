import type { GoalReadModel } from "@polaris/contracts";
import { describe, expect, it } from "vitest";
import type { PreferenceStorage } from "../lib/current-organization-model";
import {
  HOME_COPY_KEY_PREFIX,
  type StoredPeriodSummary,
  writePeriodSummaryCache,
} from "../lib/period-summary-cache";
import {
  copiedFigures,
  type HomeCopy,
  offlineHome,
  readHomeCopy,
  writeHomeCopy,
} from "./home-copy";
import type { GoalView } from "./home-model";

const ORG = "0199c2d0-0000-7000-8000-00000000a001";
const ZONE = "America/Sao_Paulo";
const ALLOWED = { offlineRuntimeEnabled: true, signingOut: false };
const KEY = `${HOME_COPY_KEY_PREFIX}${ORG}`;
const DAY = 86_400_000;

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

/** Every date from `from` to `to`, both included. */
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

/** A summary of `from`..`to` read at `generatedAt`; `daily` can be left out, as in a copy written before the series. */
function summary(
  from: string,
  to: string,
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
          daily: datesOf(from, to).map((date) => ({
            date,
            netSales: "0.00",
            salesCount: 0,
          })),
        }
      : {}),
    generatedAt,
    period: { from, to },
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

// October 2026 read on 15/10 at noon of the store, and the September before it
const READ_A = "2026-10-15T15:00:00.000Z";
const READ_B = "2026-10-15T14:00:00.000Z";
const october = (generatedAt = READ_A, withDaily = true) =>
  summary("2026-10-01", "2026-10-31", generatedAt, withDaily);
const september = (generatedAt = READ_B, withDaily = true) =>
  summary("2026-09-01", "2026-09-30", generatedAt, withDaily);

function goal(overrides: Partial<GoalReadModel> = {}): GoalReadModel {
  return {
    achievedValue: null,
    createdAt: "2026-10-01T12:00:00.000Z",
    endsOn: "2026-10-31",
    id: "0199c2d0-0000-7000-8000-000000000001",
    kind: "net_sales",
    name: null,
    organizationId: "org",
    paused: false,
    progress: {
      percent: "40.0",
      periodEnded: false,
      reached: false,
      value: "400.00",
    },
    settledAt: null,
    startsOn: "2026-10-01",
    status: "active",
    target: "1000.00",
    updatedAt: "2026-10-01T12:00:00.000Z",
    version: 1,
    ...overrides,
  };
}

const activeView = (overrides: Partial<GoalReadModel> = {}): GoalView => ({
  goal: goal(overrides),
  kind: "active",
  others: 0,
});

/** What is stored under the key of the Início, as an object. */
const stored = (values: Map<string, string>): HomeCopy =>
  JSON.parse(values.get(KEY) as string);

describe("keeping the Início's copy (writeHomeCopy)", () => {
  it("guarda o que o servidor disse numa organização sem cópia anterior", () => {
    const { storage, values } = memoryStorage();
    writeHomeCopy(storage, ORG, { before: september(), goal: activeView() });

    expect(stored(values)).toEqual({
      before: september(),
      goal: activeView(),
      hadSale: false,
    });
  });

  it("troca o B pelo B novo e mantém a meta e a venda já guardadas", () => {
    const { storage, values } = memoryStorage();
    writeHomeCopy(storage, ORG, {
      before: september(),
      goal: activeView(),
      hadSale: true,
    });
    const newer = september("2026-10-16T14:00:00.000Z");
    writeHomeCopy(storage, ORG, { before: newer });

    expect(stored(values)).toEqual({
      before: newer,
      goal: activeView(),
      hadSale: true,
    });
  });

  it("troca a meta pela meta nova e mantém o B", () => {
    const { storage, values } = memoryStorage();
    writeHomeCopy(storage, ORG, { before: september(), goal: activeView() });
    writeHomeCopy(storage, ORG, { goal: { kind: "none" } });

    expect(stored(values)).toEqual({
      before: september(),
      goal: { kind: "none" },
      hadSale: false,
    });
  });

  it("uma meta null explícita apaga a meta guardada", () => {
    const { storage, values } = memoryStorage();
    writeHomeCopy(storage, ORG, { goal: activeView() });
    writeHomeCopy(storage, ORG, { goal: null });

    expect(stored(values).goal).toBeNull();
  });

  it("uma loja que vendeu continua sendo uma loja que vendeu", () => {
    const { storage, values } = memoryStorage();
    writeHomeCopy(storage, ORG, { hadSale: true });
    writeHomeCopy(storage, ORG, { hadSale: false });
    expect(stored(values).hadSale).toBe(true);

    writeHomeCopy(storage, ORG, { before: september() });
    expect(stored(values).hadSale).toBe(true);
  });

  it("não grava uma cópia fora do formato nem sem armazenamento", () => {
    const { storage, values } = memoryStorage();
    writeHomeCopy(storage, ORG, {
      before: { ...september(), generatedAt: "ontem" },
    });
    expect(values.size).toBe(0);
    expect(() => writeHomeCopy(null, ORG, { hadSale: true })).not.toThrow();
  });

  it("não quebra quando o armazenamento recusa a gravação", () => {
    const refusing: PreferenceStorage = {
      getItem: () => null,
      removeItem: () => undefined,
      setItem: () => {
        throw new Error("quota");
      },
    };
    expect(() => writeHomeCopy(refusing, ORG, { hadSale: true })).not.toThrow();
  });

  it("uma cópia guardada corrompida é refeita a partir do que chegou", () => {
    const { storage, values } = memoryStorage();
    values.set(KEY, "{not json");
    writeHomeCopy(storage, ORG, { hadSale: true });

    expect(stored(values)).toEqual({ before: null, goal: null, hadSale: true });
  });
});

describe("reading the Início's copy back (readHomeCopy)", () => {
  const read = (value: unknown) => {
    const { storage, values } = memoryStorage();
    values.set(KEY, typeof value === "string" ? value : JSON.stringify(value));
    return readHomeCopy(storage, ORG);
  };
  const valid = (): Record<string, unknown> => ({
    before: september(),
    goal: activeView(),
    hadSale: false,
  });

  it("devolve o que foi gravado", () => {
    const { storage } = memoryStorage();
    writeHomeCopy(storage, ORG, {
      before: september(),
      goal: activeView(),
      hadSale: true,
    });

    expect(readHomeCopy(storage, ORG)).toEqual({
      before: september(),
      goal: activeView(),
      hadSale: true,
    });
  });

  it("devolve null sem cópia, sem armazenamento ou de outra organização", () => {
    const { storage } = memoryStorage();
    writeHomeCopy(storage, ORG, { hadSale: true });

    expect(readHomeCopy(null, ORG)).toBeNull();
    expect(readHomeCopy(storage, "0199c2d0-0000-7000-8000-00000000a002")).toBe(
      null
    );
  });

  it("aceita a cópia antiga em que o B não tem a série diária", () => {
    expect(
      read({ ...valid(), before: september(READ_B, false) })
    ).not.toBeNull();
  });

  it("descarta JSON inválido e o que não é um objeto", () => {
    expect(read("{not json")).toBeNull();
    expect(read("[]")).toBeNull();
    expect(read("null")).toBeNull();
  });

  it("descarta a cópia cujo B tem uma série fora de ordem ou faltando um dia", () => {
    const outOfOrder = september();
    const [first, second] = outOfOrder.daily ?? [];
    outOfOrder.daily = [
      second,
      first,
      ...(outOfOrder.daily ?? []).slice(2),
    ] as NonNullable<StoredPeriodSummary["daily"]>;
    expect(read({ ...valid(), before: outOfOrder })).toBeNull();

    const skipping = september();
    skipping.daily = (skipping.daily ?? []).filter(
      (day) => day.date !== "2026-09-10"
    );
    expect(read({ ...valid(), before: skipping })).toBeNull();
  });

  it("descarta a cópia cujo B não é um resumo válido", () => {
    expect(read({ ...valid(), before: { period: september().period } })).toBe(
      null
    );
    expect(read({ ...valid(), before: "september" })).toBeNull();
  });

  it.each([
    ["um alvo que não é texto", { target: 1000 }],
    ["uma data de fim impossível de ler", { endsOn: "31/10/2026" }],
    ["um campo paused que não é booleano", { paused: "no" }],
    ["um tipo de meta desconhecido", { kind: "visits" }],
    ["um status desconhecido", { status: "done" }],
    ["um andamento sem o campo reached", { progress: { periodEnded: false } }],
    ["um settledAt que não é um instante", { settledAt: "ontem" }],
  ])("descarta a cópia cuja meta tem %s", (_label, broken) => {
    expect(
      read({ ...valid(), goal: activeView(broken as Partial<GoalReadModel>) })
    ).toBeNull();
  });

  it("descarta uma meta ativa com outras metas que não é um inteiro", () => {
    expect(
      read({ ...valid(), goal: { ...activeView(), others: 1.5 } })
    ).toBeNull();
    expect(
      read({ ...valid(), goal: { ...activeView(), others: -1 } })
    ).toBeNull();
    expect(read({ ...valid(), goal: { kind: "other" } })).toBeNull();
  });

  it("descarta a cópia em que hadSale não é booleano ou falta", () => {
    expect(read({ ...valid(), hadSale: "true" })).toBeNull();
    expect(read({ ...valid(), hadSale: 1 })).toBeNull();
    const { hadSale: _removed, ...without } = valid();
    expect(read(without)).toBeNull();
  });
});

describe("the figures of the copy (copiedFigures)", () => {
  /** A stored under the key the Resultado also uses, and the Início's copy with this B. */
  function keep(options: {
    a?: StoredPeriodSummary;
    b?: StoredPeriodSummary | null;
    month?: string;
  }) {
    const { storage } = memoryStorage();
    if (options.a) {
      writePeriodSummaryCache(
        storage,
        ORG,
        options.month ?? options.a.period.from.slice(0, 7),
        options.a,
        ALLOWED
      );
    }
    const copy: HomeCopy = {
      before: options.b === undefined ? september() : options.b,
      goal: null,
      hadSale: false,
    };
    return { copy, storage };
  }

  it("junta o A do mês seguinte ao B com o B, no dia da loja da leitura do A", () => {
    const { copy, storage } = keep({ a: october() });
    const figures = copiedFigures(storage, ORG, copy, ZONE);

    expect(figures).toEqual({
      before: september(),
      confirmedAt: READ_B,
      month: october(),
      today: "2026-10-15",
    });
  });

  it("sem B não há números", () => {
    const { copy, storage } = keep({ a: october(), b: null });
    expect(copiedFigures(storage, ORG, copy, ZONE)).toBeNull();
  });

  it("sem o A do mês que segue o B não há números", () => {
    const { copy, storage } = keep({});
    expect(copiedFigures(storage, ORG, copy, ZONE)).toBeNull();
  });

  it("o A de outro mês não serve", () => {
    const november = summary(
      "2026-11-01",
      "2026-11-30",
      "2026-11-05T15:00:00.000Z"
    );
    const { copy, storage } = keep({ a: november });
    expect(copiedFigures(storage, ORG, copy, ZONE)).toBeNull();
  });

  it("um B que não cobre os 30 dias que a leitura de A pede não serve", () => {
    // read on 1 March: B has to start on 31 January, so a B from 1 February would draw a zero for 31/01
    const a = summary("2027-03-01", "2027-03-31", "2027-03-01T15:00:00.000Z");
    const short = summary("2027-02-01", "2027-02-28", READ_B);
    const whole = summary("2027-01-31", "2027-02-28", READ_B);

    expect(
      copiedFigures(keep({ a }).storage, ORG, keep({ a, b: short }).copy, ZONE)
    ).toBeNull();
    const kept = keep({ a, b: whole });
    expect(copiedFigures(kept.storage, ORG, kept.copy, ZONE)).toMatchObject({
      today: "2027-03-01",
    });
  });

  it("um B que começa depois do começo do mês anterior não serve", () => {
    const { copy, storage } = keep({
      a: october(),
      b: summary("2026-09-02", "2026-09-30", READ_B),
    });
    expect(copiedFigures(storage, ORG, copy, ZONE)).toBeNull();
  });

  it("o dia de hoje nunca passa do fim do mês do A", () => {
    // read on 02/11 in the store, but the copy of A is October's: the series ends on 31/10
    const { copy, storage } = keep({ a: october("2026-11-02T15:00:00.000Z") });
    expect(copiedFigures(storage, ORG, copy, ZONE)?.today).toBe("2026-10-31");
  });

  it("o dia da leitura vem do fuso da loja, não do UTC", () => {
    // 01:30 UTC of 16/10 is still 15/10 in São Paulo
    const { copy, storage } = keep({ a: october("2026-10-16T01:30:00.000Z") });
    expect(copiedFigures(storage, ORG, copy, ZONE)?.today).toBe("2026-10-15");
  });

  it("a confirmação é a leitura mais antiga dos dois, qualquer que seja a ordem", () => {
    const olderA = keep({
      a: october("2026-10-15T10:00:00.000Z"),
      b: september("2026-10-15T14:00:00.000Z"),
    });
    expect(
      copiedFigures(olderA.storage, ORG, olderA.copy, ZONE)?.confirmedAt
    ).toBe("2026-10-15T10:00:00.000Z");

    const olderB = keep({
      a: october("2026-10-15T15:00:00.000Z"),
      b: september("2026-10-14T09:00:00.000Z"),
    });
    expect(
      copiedFigures(olderB.storage, ORG, olderB.copy, ZONE)?.confirmedAt
    ).toBe("2026-10-14T09:00:00.000Z");
  });
});

describe("what the Início shows without a connection (offlineHome)", () => {
  const NOW = Date.parse("2026-10-15T18:00:00.000Z");

  function kept(copy: Partial<HomeCopy> = {}) {
    const { storage } = memoryStorage();
    writePeriodSummaryCache(storage, ORG, "2026-10", october(), ALLOWED);
    writeHomeCopy(storage, ORG, {
      before: september(),
      goal: activeView(),
      ...copy,
    });
    return storage;
  }

  it("com a cópia e permissão, mostra as figuras e a meta guardada", () => {
    const home = offlineHome(kept(), ORG, ZONE, NOW, true);

    expect(home.figures).toMatchObject({
      confirmedAt: READ_B,
      stale: false,
      today: "2026-10-15",
      todayShown: true,
    });
    expect(home.figures?.month.period).toEqual({
      from: "2026-10-01",
      to: "2026-10-31",
    });
    expect(home.goal).toEqual({
      ended: false,
      goal: goal(),
      kind: "active",
    });
  });

  it("sem permissão não mostra nada, mesmo com a cópia no aparelho", () => {
    const home = offlineHome(kept(), ORG, ZONE, NOW, false);

    expect(home.figures).toBeNull();
    expect(home.goal).toEqual({ kind: "online-only" });
  });

  it("sem cópia do Início não há figuras e a meta só vem com conexão", () => {
    const { storage } = memoryStorage();
    writePeriodSummaryCache(storage, ORG, "2026-10", october(), ALLOWED);
    const home = offlineHome(storage, ORG, ZONE, NOW, true);

    expect(home.figures).toBeNull();
    expect(home.goal).toEqual({ kind: "online-only" });
  });

  it("sem o A do mês, a meta guardada também fica de fora", () => {
    const { storage } = memoryStorage();
    writeHomeCopy(storage, ORG, { before: september(), goal: activeView() });
    const home = offlineHome(storage, ORG, ZONE, NOW, true);

    expect(home.figures).toBeNull();
    expect(home.goal).toEqual({ kind: "online-only" });
  });

  it("avisa que está desatualizado depois de 24 h da leitura mais antiga", () => {
    const home = offlineHome(
      kept(),
      ORG,
      ZONE,
      Date.parse(READ_B) + 25 * 3_600_000,
      true
    );
    expect(home.figures).toMatchObject({ stale: true, todayShown: false });
  });
});
