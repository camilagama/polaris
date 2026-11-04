import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertOptions,
  assertQaTarget,
  MAX_SEED_DAYS,
  markQaStoreInternal,
  type QueryClient,
  type SeedOptions,
  saleInstant,
  salePlacement,
} from "./seed-qa-store";

const ORG = "0199c2d0-0000-7000-8000-00000000c001";
const USER = "user-qa";
const STAGING = new URL(
  "postgresql://owner:x@ep-quiet-bird-a1b2c3d4.c-2.sa-east-1.aws.neon.tech/neondb"
);
const LOCAL = new URL("postgresql://owner:x@localhost:5432/polaris_gate");

interface Fake {
  comment?: string | null;
  current?: string | null;
  name?: string;
  owner?: boolean;
  status?: string;
  stored?: string | null;
}

/** A database that answers the three reads of the guard. */
function database(fake: Fake): QueryClient & { writes: number } {
  const state = { writes: 0 };
  return {
    query: (text) => {
      if (text.includes("polaris.environment")) {
        return Promise.resolve({
          rowCount: 1,
          rows: [
            {
              comment: fake.comment ?? null,
              current: fake.current ?? null,
              stored: fake.stored ?? null,
            },
          ],
        });
      }
      if (text.includes("FROM public.organizations")) {
        return Promise.resolve(
          fake.name === undefined
            ? { rowCount: 0, rows: [] }
            : {
                rowCount: 1,
                rows: [{ name: fake.name, status: fake.status ?? "active" }],
              }
        );
      }
      if (text.includes("FROM public.memberships")) {
        return Promise.resolve({
          rowCount: fake.owner === false ? 0 : 1,
          rows: fake.owner === false ? [] : [{}],
        });
      }
      state.writes += 1;
      return Promise.reject(new Error("the guard only reads"));
    },
    get writes() {
      return state.writes;
    },
  };
}

const staging = (overrides: Partial<{ ci: boolean; local: boolean }> = {}) => ({
  ci: false,
  local: false,
  organizationId: ORG,
  userId: USER,
  ...overrides,
});

describe("the QA seed refuses every target but a qa- store of staging or of the local gates", () => {
  it("accepts the staging branch with the exact marker and a qa- store owned by the user", async () => {
    await expect(
      assertQaTarget(
        database({
          comment: "polaris.environment=staging",
          name: "qa-inicio-20",
        }),
        STAGING,
        staging()
      )
    ).resolves.toEqual({
      environment: "staging",
      organizationName: "qa-inicio-20",
    });
  });

  it("accepts the local database of the gates only with --local, CI=true and no marker at all", async () => {
    await expect(
      assertQaTarget(
        database({ name: "qa-medida" }),
        LOCAL,
        staging({ ci: true, local: true })
      )
    ).resolves.toMatchObject({ environment: "local" });
  });

  it.each([
    ["production", { comment: "polaris.environment=production" }, STAGING, {}],
    ["no marker on a Neon host", {}, STAGING, {}],
    [
      "a sloppy staging marker",
      { comment: "Polaris.Environment = staging" },
      STAGING,
      {},
    ],
    [
      "staging contradicted by the stored setting",
      { comment: "polaris.environment=staging", stored: "production" },
      STAGING,
      {},
    ],
    [
      "the staging marker on a host that is not a direct Neon endpoint",
      { comment: "polaris.environment=staging" },
      new URL("postgresql://owner:x@db.example.com/neondb"),
      {},
    ],
    [
      "the pooled Neon endpoint",
      { comment: "polaris.environment=staging" },
      new URL(
        "postgresql://owner:x@ep-quiet-bird-a1b2c3d4-pooler.c-2.sa-east-1.aws.neon.tech/neondb"
      ),
      {},
    ],
    ["--local without CI", {}, LOCAL, { local: true }],
    [
      "--local on a database that carries a marker",
      { comment: "polaris.environment=production" },
      LOCAL,
      { ci: true, local: true },
    ],
    [
      "--local with a sloppy marker (it never reads as no marker)",
      { comment: "polaris.environment = prod" },
      LOCAL,
      { ci: true, local: true },
    ],
    [
      "--local on a host that is not local",
      {},
      new URL("postgresql://owner:x@10.0.0.5:5432/polaris"),
      { ci: true, local: true },
    ],
  ] as const)("refuses %s", async (_label, marker, url, flags) => {
    const fake = database({ ...marker, name: "qa-inicio" });
    await expect(assertQaTarget(fake, url, staging(flags))).rejects.toThrow(
      "seed refused"
    );
    expect(fake.writes).toBe(0);
  });

  it.each([
    ["a store whose name does not start with qa-", { name: "Loja da Ana" }],
    ["a store named QA- in capitals", { name: "QA-loja" }],
    ["a store that does not exist", {}],
    ["a closed store", { name: "qa-fechada", status: "closed" }],
    ["a user who is not the active owner", { name: "qa-inicio", owner: false }],
  ] as const)("refuses %s", async (_label, store) => {
    const fake = database({ comment: "polaris.environment=staging", ...store });
    await expect(assertQaTarget(fake, STAGING, staging())).rejects.toThrow(
      "seed refused"
    );
    expect(fake.writes).toBe(0);
  });
});

describe("the seed options", () => {
  const options = (overrides: Partial<SeedOptions> = {}): SeedOptions => ({
    days: MAX_SEED_DAYS,
    goals: true,
    organizationId: ORG,
    salesPerDay: 20,
    userId: USER,
    variantsWithoutStock: 120,
    ...overrides,
  });

  it("accepts 366 days and no more", () => {
    expect(MAX_SEED_DAYS).toBe(366);
    expect(() => assertOptions(options({ days: 366 }))).not.toThrow();
    expect(() => assertOptions(options({ days: 367 }))).toThrow("seed refused");
  });

  it("accepts the stores of the measure", () => {
    expect(() => assertOptions(options())).not.toThrow();
    expect(() => assertOptions(options({ salesPerDay: 50 }))).not.toThrow();
    expect(() =>
      assertOptions(options({ variantsWithoutStock: 101 }))
    ).not.toThrow();
  });

  it.each([
    ["more than 366 days", { days: MAX_SEED_DAYS + 1 }],
    ["no day", { days: 0 }],
    ["sales per day that are not a number", { salesPerDay: Number.NaN }],
    ["a typo in the sales per day", { salesPerDay: 5000 }],
    ["fractional variants", { variantsWithoutStock: 1.5 }],
  ] as const)("refuses %s before anything is written", (_label, broken) => {
    expect(() => assertOptions(options(broken))).toThrow("seed refused");
  });
});

describe("the QA store is kept out of the activation funnel", () => {
  it("marks the store as internal with no operator, and marking again changes nothing", async () => {
    const statements: { text: string; values?: unknown[] | undefined }[] = [];
    let marked = false;
    const client: QueryClient = {
      query: (text, values) => {
        statements.push({ text, values });
        const inserted = !marked;
        marked = true;
        return Promise.resolve({ rowCount: inserted ? 1 : 0, rows: [] });
      },
    };
    expect(await markQaStoreInternal(client, ORG)).toBe(true);
    expect(await markQaStoreInternal(client, ORG)).toBe(false);
    expect(statements).toHaveLength(2);
    for (const statement of statements) {
      expect(statement.text).toBe(
        "INSERT INTO public.platform_internal_organizations (organization_id) VALUES ($1) ON CONFLICT (organization_id) DO NOTHING"
      );
      expect(statement.values).toEqual([ORG]);
    }
  });
});

describe("an old sale is confirmed inside the owner's window and moved back to its day", () => {
  const TODAY = "2026-11-04";
  const ZONE = "America/Sao_Paulo";
  const dayOf = (instant: string) =>
    new Intl.DateTimeFormat("en-CA", { timeZone: ZONE }).format(
      new Date(instant)
    );
  const shift = (date: string, days: number) =>
    new Date(Date.parse(`${date}T00:00:00.000Z`) - days * 86_400_000)
      .toISOString()
      .slice(0, 10);

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([0, 1, 29, 30, 31, 59, 60, 61, 200, 365])(
    "places the sale of %i days ago on its day, in occurred_on and in occurred_at",
    (back) => {
      vi.useFakeTimers({
        now: new Date(`${TODAY}T14:00:00.000Z`),
        toFake: ["Date"],
      });
      const { confirmOn, moveBack } = salePlacement(TODAY, back);
      const confirmedAt = saleInstant(confirmOn, TODAY, 5);
      const movedAt = new Date(
        Date.parse(confirmedAt) - moveBack * 86_400_000
      ).toISOString();
      const target = shift(TODAY, back);
      expect(shift(confirmOn, moveBack)).toBe(target);
      expect(dayOf(movedAt)).toBe(target);
    }
  );

  it("keeps today's sales on the planned day when the run crosses the midnight of the store", () => {
    vi.useFakeTimers({
      now: new Date("2026-11-05T03:30:00.000Z"),
      toFake: ["Date"],
    });
    for (const back of [0, 30, 360]) {
      const { confirmOn, moveBack } = salePlacement(TODAY, back);
      const movedAt = new Date(
        Date.parse(saleInstant(confirmOn, TODAY, 399)) - moveBack * 86_400_000
      ).toISOString();
      expect(dayOf(movedAt)).toBe(shift(TODAY, back));
    }
  });

  it("keeps the confirmation inside the 30 days of the owner and moves nothing that is recent", () => {
    for (let back = 0; back < MAX_SEED_DAYS; back += 1) {
      const { confirmOn, moveBack } = salePlacement(TODAY, back);
      const confirmedBack = back - moveBack;
      expect(confirmedBack).toBeGreaterThanOrEqual(0);
      expect(confirmedBack).toBeLessThan(30);
      expect(shift(TODAY, confirmedBack)).toBe(confirmOn);
      expect(moveBack === 0).toBe(back < 30);
    }
  });

  it("uses at most 13 different moves for the 366 days", () => {
    const moves = new Set(
      Array.from(
        { length: MAX_SEED_DAYS },
        (_, back) => salePlacement(TODAY, back).moveBack
      )
    );
    expect(moves.size).toBe(13);
  });
});
