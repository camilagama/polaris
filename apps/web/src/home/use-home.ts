import type { GoalReadModel } from "@polaris/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { calendarDayInTimezone } from "../lib/dates";
import { orpcClient } from "../lib/orpc";
import { isSessionOver } from "../offline/runtime/session-ended";
import {
  isPeriodSummary,
  type StoredPeriodSummary,
} from "../lib/period-summary-cache";
import { isLegalAcceptanceRefusal, rpcErrorCode } from "../lib/rpc-error";
import {
  type BalancesPage,
  homePeriods,
  homeReads,
  msUntilNextMidnight,
  noSaleCounted,
  shouldRefreshOnReturn,
  storeToday,
} from "./home-model";

/**
 * The reads of the Início (desenho t269 v2, § 2.4 and § 5): A and B (the figures), G (the goals) and S (no stock) in
 * parallel; C (no cost) and the checklist reads (V, P, E) only when A asks for them. Each block has its own state, so
 * one that fails never takes the others with it (§ 5.2), and "Nova venda" depends on none of them.
 *
 * They are read again when the tab comes back (at most once every 30 s), when the page comes back from the browser's
 * history (a sale confirmed on `/sales` is then in the figures) and at the next midnight of the store, taken from the
 * server's clock; when the month of the server is not the one asked for, the figures are read again for it (§ 5.1).
 * A 401 is the shell's to say ("Entrar de novo"): the blocks say nothing more, and the copies of the results go away.
 */

/** A block's state: still reading, read, failed (and whether trying again can help) or not shown at all. */
export type Block<T> =
  | { data: T; status: "ready" }
  | { retryable: boolean; status: "error" }
  | { status: "hidden" }
  | { status: "loading" };

export interface HomeFigures {
  before: StoredPeriodSummary;
  month: StoredPeriodSummary;
  /** The store's today, from the server's clock of A. */
  today: string;
}

/** The checklist of a store that never sold, or null when the store sold (or it is not known). */
export interface HomeChecklist {
  firstProductId: string | null;
  hasStock: boolean;
}

export interface HomeState {
  checklist: Block<HomeChecklist | null>;
  figures: Block<HomeFigures>;
  goals: Block<GoalReadModel[]>;
  /** The server refused the session or waits for the legal acceptance: the shell says so, the blocks say nothing. */
  sessionRefused: boolean;
  /** S and C together: the lines of the stock in "Precisa de atenção". */
  stock: Block<{
    unknownCost: BalancesPage | null;
    withoutStock: BalancesPage;
  }>;
}

const LOADING: HomeState = {
  checklist: { status: "loading" },
  figures: { status: "loading" },
  goals: { status: "loading" },
  sessionRefused: false,
  stock: { status: "loading" },
};

const PAGE = 100;

/** A refusal of the session, or the missing acceptance: never an error of a block (§ 5.2 (d)). */
function refusesSession(error: unknown): boolean {
  return (
    rpcErrorCode(error) === "UNAUTHORIZED" || isLegalAcceptanceRefusal(error)
  );
}

/** Trying again only helps when the server did not answer or was out; a refusal stays a refusal. */
function failed(error: unknown): { retryable: boolean; status: "error" } {
  const code = rpcErrorCode(error);
  return {
    retryable: code !== "FORBIDDEN" && code !== "BAD_REQUEST",
    status: "error",
  };
}

async function readSummary(
  organizationId: string,
  from: string,
  to: string,
  topProducts?: number
): Promise<StoredPeriodSummary> {
  const summary = await orpcClient.report.periodSummary({
    from,
    organizationId,
    to,
    ...(topProducts ? { topProducts } : {}),
  });
  if (!isPeriodSummary(summary) || summary.daily === undefined) {
    // not what the server sends (a captive portal page, a proxy): as if it had not answered
    throw new Error("period_summary_malformed");
  }
  return summary;
}

async function readFigures(
  organizationId: string,
  today: string
): Promise<Omit<HomeFigures, "today">> {
  const { before, month } = homePeriods(today);
  const [monthSummary, beforeSummary] = await Promise.all([
    readSummary(organizationId, month.from, month.to, 3),
    readSummary(organizationId, before.from, before.to),
  ]);
  return { before: beforeSummary, month: monthSummary };
}

/**
 * Whether the store ever sold (V, cancelled sales included) and, when it did not, what it has: a product (P, archived
 * ones included) and a variant with stock (E). Null when the store sold: then there is no checklist (AC-23).
 */
async function readChecklist(
  organizationId: string,
  readsStock: boolean
): Promise<HomeChecklist | null> {
  const sold = await orpcClient.sale.list({ limit: 1, organizationId });
  if (sold.sales.length > 0 || !readsStock) {
    return null;
  }
  const [product] = (
    await orpcClient.inventory.listBalances({
      limit: 1,
      organizationId,
      productStatus: "all",
    })
  ).entries;
  if (product === undefined) {
    return { firstProductId: null, hasStock: false };
  }
  const stocked = await orpcClient.inventory.listBalances({
    limit: 1,
    organizationId,
    stock: "with_stock",
  });
  return {
    firstProductId: product.productId,
    hasStock: stocked.entries.length > 0,
  };
}

/** S, and C only when the month sold an item without a known cost (§ 2.4). */
async function readStock(
  organizationId: string,
  withUnknownCost: Promise<boolean>
): Promise<{ unknownCost: BalancesPage | null; withoutStock: BalancesPage }> {
  const page = (list: { entries: unknown[]; nextCursor: string | null }) => ({
    count: list.entries.length,
    more: list.nextCursor !== null,
  });
  const withoutStock = orpcClient.inventory.listBalances({
    limit: PAGE,
    organizationId,
    productStatus: "active",
    stock: "without_stock",
  });
  // awaited below, after C: a failure of S meanwhile is not an unhandled rejection
  withoutStock.catch(() => undefined);
  const unknownCost = (await withUnknownCost)
    ? await orpcClient.inventory.listBalances({
        cost: "unknown",
        limit: PAGE,
        organizationId,
        productStatus: "active",
      })
    : null;
  return {
    unknownCost: unknownCost && page(unknownCost),
    withoutStock: page(await withoutStock),
  };
}

export function useHome(
  organizationId: string,
  role: string,
  timezone: string
) {
  const reads = useMemo(() => homeReads(role), [role]);
  const [state, setState] = useState<HomeState>(LOADING);
  // one ticket for the figures and what hangs on them (checklist, stock), one for the goals: a retry of one block
  // makes the answers of that block still on the way stale, never the other's
  const sequence = useRef({ goals: 0, numbers: 0 });
  const lastReadAt = useRef(0);
  // the server's clock minus the device's, from the last answer: the turn of the day follows the server
  const skew = useRef(0);
  const [midnightAt, setMidnightAt] = useState(0);

  /** Sets a block, if the answer is of the newest read; a refusal of the session goes to the shell instead. */
  const settle = useCallback(
    <K extends "checklist" | "figures" | "goals" | "stock">(
      ticket: number,
      key: K,
      outcome: { block: HomeState[K] } | { error: unknown },
      keep = false
    ) => {
      if (ticket !== sequence.current[key === "goals" ? "goals" : "numbers"]) {
        return;
      }
      // the copies go with the 401 in `orpc.ts` (`endSessionHere`); the missing acceptance keeps them
      if ("error" in outcome && refusesSession(outcome.error)) {
        setState((now) => ({ ...now, sessionRefused: true }));
        return;
      }
      const block = "block" in outcome ? outcome.block : failed(outcome.error);
      // a refresh that fails leaves the figures read before on the screen: they are still the last confirmed ones
      setState((now) =>
        "error" in outcome && keep && now[key].status === "ready"
          ? now
          : { ...now, [key]: block }
      );
    },
    []
  );

  const loadFigures = useCallback(
    async (ticket: number, keep: boolean): Promise<HomeFigures | null> => {
      if (!reads.report) {
        settle(ticket, "figures", { block: { status: "hidden" } });
        return null;
      }
      if (!keep) {
        settle(ticket, "figures", { block: { status: "loading" } });
      }
      try {
        const guess = calendarDayInTimezone(
          new Date(Date.now() + skew.current),
          timezone
        );
        let figures = await readFigures(organizationId, guess);
        skew.current = Date.parse(figures.month.generatedAt) - Date.now();
        const today = storeToday(figures.month.generatedAt, timezone);
        // the device's month is not the server's (a wrong clock, the turn of the month): read the server's
        if (today.slice(0, 7) !== guess.slice(0, 7)) {
          figures = await readFigures(organizationId, today);
        }
        const ready = { ...figures, today };
        if (ticket === sequence.current.numbers) {
          setMidnightAt(
            Date.now() +
              msUntilNextMidnight(Date.now() + skew.current, timezone)
          );
        }
        settle(ticket, "figures", { block: { data: ready, status: "ready" } });
        return ready;
      } catch (error) {
        settle(ticket, "figures", { error }, keep);
        return null;
      }
    },
    [organizationId, reads.report, settle, timezone]
  );

  const loadChecklist = useCallback(
    async (ticket: number, figures: HomeFigures | null) => {
      if (
        figures === null ||
        !reads.sales ||
        !noSaleCounted(figures.month, figures.before)
      ) {
        settle(ticket, "checklist", { block: { data: null, status: "ready" } });
        return;
      }
      try {
        const data = await readChecklist(organizationId, reads.inventory);
        settle(ticket, "checklist", { block: { data, status: "ready" } });
      } catch (error) {
        // not knowing whether the store sold, the figures stand with their empty states
        settle(
          ticket,
          "checklist",
          refusesSession(error)
            ? { error }
            : { block: { data: null, status: "ready" } }
        );
      }
    },
    [organizationId, reads.inventory, reads.sales, settle]
  );

  const loadGoals = useCallback(
    async (ticket: number, keep: boolean) => {
      if (!reads.goals) {
        settle(ticket, "goals", { block: { status: "hidden" } });
        return;
      }
      if (!keep) {
        settle(ticket, "goals", { block: { status: "loading" } });
      }
      try {
        // every status: reading settles the goals, and a goal that just settled leaves the active ones (§ 5.3)
        const { goals } = await orpcClient.goal.list({
          organizationId,
          status: "all",
        });
        settle(ticket, "goals", { block: { data: goals, status: "ready" } });
      } catch (error) {
        settle(ticket, "goals", { error }, keep);
      }
    },
    [organizationId, reads.goals, settle]
  );

  const loadStock = useCallback(
    async (
      ticket: number,
      figures: Promise<HomeFigures | null>,
      keep: boolean
    ) => {
      if (!reads.inventory) {
        settle(ticket, "stock", { block: { status: "hidden" } });
        return;
      }
      try {
        const data = await readStock(
          organizationId,
          figures.then(
            (read) =>
              reads.unknownCost &&
              (read?.month.quality.itemLinesWithUnknownCost ?? 0) > 0
          )
        );
        settle(ticket, "stock", { block: { data, status: "ready" } });
      } catch (error) {
        settle(ticket, "stock", { error }, keep);
      }
    },
    [organizationId, reads.inventory, reads.unknownCost, settle]
  );

  /** The figures, then the checklist that depends on them; the stock waits for them only to decide on C. */
  const loadNumbers = useCallback(
    (ticket: number, keep: boolean) => {
      const figures = loadFigures(ticket, keep);
      const checklist = figures.then((read) => loadChecklist(ticket, read));
      return { checklist, figures };
    },
    [loadChecklist, loadFigures]
  );

  /** The figures and what hangs on them (the checklist, and the stock, which waits for them only to decide on C). */
  const loadNumbersAndStock = useCallback(
    (keep: boolean) => {
      sequence.current.numbers += 1;
      const ticket = sequence.current.numbers;
      const { checklist, figures } = loadNumbers(ticket, keep);
      checklist.catch(() => undefined);
      loadStock(ticket, figures, keep).catch(() => undefined);
    },
    [loadNumbers, loadStock]
  );
  const loadGoalsAgain = useCallback(
    (keep: boolean) => {
      sequence.current.goals += 1;
      loadGoals(sequence.current.goals, keep).catch(() => undefined);
    },
    [loadGoals]
  );

  /** Reads every block; `keep` leaves what is on screen while the new answer comes (a refresh, not an opening). */
  const loadAll = useCallback(
    (keep: boolean) => {
      lastReadAt.current = Date.now();
      setState((now) => ({ ...now, sessionRefused: false }));
      loadNumbersAndStock(keep);
      loadGoalsAgain(keep);
    },
    [loadGoalsAgain, loadNumbersAndStock]
  );
  /** A refresh, unless the session already ended here: its notice is on the screen, and every read would be a 401. */
  const refresh = useCallback(() => {
    if (!isSessionOver()) {
      loadAll(true);
    }
  }, [loadAll]);

  useEffect(() => {
    const tickets = sequence.current;
    loadAll(false);
    return () => {
      tickets.goals += 1;
      tickets.numbers += 1;
    };
  }, [loadAll]);

  // the tab comes back, or the page comes back from the history of the browser (after a sale on /sales)
  useEffect(() => {
    const again = () => {
      if (
        document.visibilityState === "visible" &&
        shouldRefreshOnReturn(lastReadAt.current, Date.now())
      ) {
        refresh();
      }
    };
    const restored = (event: PageTransitionEvent) => {
      if (event.persisted) {
        refresh();
      }
    };
    document.addEventListener("visibilitychange", again);
    window.addEventListener("focus", again);
    window.addEventListener("pageshow", restored);
    return () => {
      document.removeEventListener("visibilitychange", again);
      window.removeEventListener("focus", again);
      window.removeEventListener("pageshow", restored);
    };
  }, [refresh]);

  // the next midnight of the store: the day (and, on the 1st, the month) of every block changes
  useEffect(() => {
    if (midnightAt === 0) {
      return;
    }
    const timer = window.setTimeout(
      refresh,
      Math.max(0, midnightAt - Date.now())
    );
    return () => window.clearTimeout(timer);
  }, [refresh, midnightAt]);

  // "Tentar novamente" of the figures reads the stock again too: the line of the unknown cost waits for them
  const retryFigures = useCallback(
    () => loadNumbersAndStock(false),
    [loadNumbersAndStock]
  );
  const retryGoals = useCallback(() => loadGoalsAgain(false), [loadGoalsAgain]);
  return { reads, retryFigures, retryGoals, state };
}
