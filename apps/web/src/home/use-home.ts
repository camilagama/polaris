import type { GoalReadModel } from "@polaris/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  browserConnection,
  useConnectionReturn,
  workerAnswers,
} from "../lib/browser-connection";
import { isNoAnswer } from "../lib/connection";
import { browserStorage } from "../lib/current-organization-model";
import { calendarDayInTimezone } from "../lib/dates";
import { orpcClient } from "../lib/orpc";
import {
  clearOrganizationResultCopies,
  isPeriodSummary,
  type StoredPeriodSummary,
  writePeriodSummaryCache,
} from "../lib/period-summary-cache";
import { readWithRetry } from "../lib/read-with-retry";
import { isLegalAcceptanceRefusal, rpcErrorCode } from "../lib/rpc-error";
import { isSigningOut } from "../lib/sign-out";
import { OFFLINE_RUNTIME_ENABLED } from "../offline/runtime/enabled";
import { isSessionOver } from "../offline/runtime/session-ended";
import {
  type FirstStepsFacts,
  rememberFirstSteps,
} from "../app-shell/first-steps";
import { type HomeCopy, writeHomeCopy } from "./home-copy";
import {
  type BalancesPage,
  homePeriods,
  homeReads,
  msUntilNextMidnight,
  noSaleCounted,
  pickGoal,
  shouldRefreshOnReturn,
  storeToday,
} from "./home-model";
import {
  type DailySeries,
  isDailySeries,
  rhythmPeriod,
} from "./home-rhythm-model";
import {
  rememberPreviousWindow,
  reusablePreviousWindow,
} from "./previous-window-copy";
import { todaysRhythmCopy, writeRhythmCopy } from "./rhythm-copy";

/**
 * The reads of the Início: A and B (the figures), G (the goals) and S (no stock) in
 * parallel; C (no cost) and the checklist reads (V, P, E) only when A asks for them. Each block has its own state, so
 * one that fails never takes the others with it (§ 5.2), and "Nova venda" depends on none of them.
 *
 * They are read again when the tab comes back (at most once every 30 s), when the page comes back from the browser's
 * history (a sale confirmed on `/sales` is then in the figures) and at the next midnight of the store, taken from the
 * server's clock; when the month of the server is not the one asked for, the figures are read again for it (§ 5.1).
 * A 401 is the shell's to say ("Entrar de novo"): the blocks say nothing more, and the copies of the results go away.
 *
 * Without a connection nothing is read (§ 7): the page shows the device's copy, which every read that worked keeps
 * (only with the offline runtime, for a role that reads the results, and never once the session is ending). A read
 * with no answer asks the probe: when the Worker is not there either, it is the lack of a connection, not an error of
 * the block (§ 7.1); everything is read again when the connection comes back, keeping what is on the screen.
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
  /** The server refused this person the figures or the goals: the copy of the store is gone and never stands in. */
  copyRefused: boolean;
  figures: Block<HomeFigures>;
  goals: Block<GoalReadModel[]>;
  /** The light daily series of the map (`report.dailySales`), read once the figures said what today is. */
  rhythm: Block<DailySeries>;
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
  copyRefused: false,
  figures: { status: "loading" },
  goals: { status: "loading" },
  rhythm: { status: "loading" },
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

/** A read with no answer at all, and the probe does not find the Worker either: no connection (§ 7.1). */
async function noConnection(error: unknown): Promise<boolean> {
  return isNoAnswer(error) && !(await workerAnswers());
}

/** A refusal of the server that is about this person and this store (not the missing acceptance, said apart). */
function refusesCopy(error: unknown): boolean {
  return (
    rpcErrorCode(error) === "FORBIDDEN" && !isLegalAcceptanceRefusal(error)
  );
}

/** Keeps the copy only with the runtime on, for a role that reads the results, and never while the session ends. */
function keepCopy(
  readsReport: boolean,
  keep: (storage: ReturnType<typeof browserStorage>) => void
) {
  if (
    OFFLINE_RUNTIME_ENABLED &&
    readsReport &&
    !isSigningOut() &&
    !isSessionOver()
  ) {
    keep(browserStorage());
  }
}

/**
 * Keeps the series just read: in the page's memory, with the runtime off too (the daily cache, `rhythm-copy.ts`), and
 * on the device with it on; nothing once the store refused this person its results, the session ended or "Sair" began.
 */
function keepRhythm(
  organizationId: string,
  series: DailySeries,
  today: string,
  copyRefused: { current: boolean }
) {
  if (copyRefused.current || isSessionOver()) {
    return;
  }
  writeRhythmCopy(
    OFFLINE_RUNTIME_ENABLED ? browserStorage() : null,
    organizationId,
    series,
    today,
    {
      offlineRuntimeEnabled: OFFLINE_RUNTIME_ENABLED,
      signingOut: isSigningOut(),
    }
  );
}

/**
 * The series of the map read on the store's today (the daily cache): from the page's memory, or with the runtime on
 * from the device; nothing once the store refused this person its results.
 */
function rhythmOfToday(
  organizationId: string,
  period: { from: string; to: string },
  today: string,
  copyRefused: { current: boolean }
): DailySeries | null {
  return copyRefused.current
    ? null
    : todaysRhythmCopy(
        OFFLINE_RUNTIME_ENABLED ? browserStorage() : null,
        organizationId,
        period,
        today
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

/** Whether the page still wants the answer of a read (its ticket is the newest): leaving it cancels the read. */
type IsCurrent = () => boolean;

async function readSummary(
  organizationId: string,
  isCurrent: IsCurrent,
  from: string,
  to: string,
  topProducts?: number
): Promise<StoredPeriodSummary> {
  const summary = await readWithRetry(
    (signal) =>
      orpcClient.report.periodSummary(
        {
          from,
          organizationId,
          to,
          ...(topProducts ? { topProducts } : {}),
        },
        { signal }
      ),
    { isCurrent }
  );
  if (!isPeriodSummary(summary) || summary.daily === undefined) {
    // not what the server sends (a captive portal page, a proxy): as if it had not answered
    throw new Error("period_summary_malformed");
  }
  return summary;
}

/**
 * The month (always read) and B: `reused`, the copy of the store's day (`previous-window-copy.ts`), or else read. Only
 * the month's answer proves the session and the capability, so a refusal there leaves nothing of B on the screen.
 */
async function readFigures(
  organizationId: string,
  isCurrent: IsCurrent,
  today: string,
  reused: StoredPeriodSummary | null
): Promise<Omit<HomeFigures, "today">> {
  const { before, month } = homePeriods(today);
  const [monthSummary, beforeSummary] = await Promise.all([
    readSummary(organizationId, isCurrent, month.from, month.to, 3),
    reused ?? readSummary(organizationId, isCurrent, before.from, before.to),
  ]);
  return { before: beforeSummary, month: monthSummary };
}

interface FiguresOfTheDay {
  figures: Omit<HomeFigures, "today">;
  /** B came from the copy: it keeps the stamp of the read it came from, and is not written again. */
  reusedBefore: boolean;
  today: string;
}

/**
 * The figures asked for the device's `guess` of the store's today, then, when the server's answer says the day (or the
 * month) is another, for the server's: a B taken from the copy of the guessed day is not taken for another day (it is
 * read). `reusable` says which copy of B may stand in for a read of a day; `onAnswer` hears the first answer's clock.
 */
async function readFiguresOfTheDay(
  organizationId: string,
  isCurrent: IsCurrent,
  guess: string,
  timezone: string | null,
  reusable: (day: string) => StoredPeriodSummary | null,
  onAnswer: (generatedAt: string) => void
): Promise<FiguresOfTheDay> {
  let reused = reusable(guess);
  let figures = await readFigures(organizationId, isCurrent, guess, reused);
  onAnswer(figures.month.generatedAt);
  const today = storeToday(figures.month.generatedAt, timezone);
  if (today.slice(0, 7) !== guess.slice(0, 7)) {
    // the device's month is not the server's (a wrong clock, the turn of the month): read the server's
    reused = reusable(today);
    figures = await readFigures(organizationId, isCurrent, today, reused);
  } else if (reused !== null && reusable(today) === null) {
    // the device's day is not the server's: the copy of the guessed day is not of today, so B is read
    reused = null;
    const { before } = homePeriods(today);
    figures = {
      ...figures,
      before: await readSummary(
        organizationId,
        isCurrent,
        before.from,
        before.to
      ),
    };
  }
  return { figures, reusedBefore: reused !== null, today };
}

/** Keeps B in the page's memory; nothing once the store refused this person its results, the session ended or "Sair" began. */
function keepPreviousWindow(
  organizationId: string,
  summary: StoredPeriodSummary,
  copyRefused: { current: boolean }
) {
  if (!(copyRefused.current || isSessionOver() || isSigningOut())) {
    rememberPreviousWindow(organizationId, summary);
  }
}

/**
 * Tells the foot of the menu the steps the Início read (`when` the read is still the current one); never while the
 * session ends, which drops them.
 */
function tellFirstSteps(
  organizationId: string,
  facts: FirstStepsFacts | null,
  when: boolean
): void {
  if (when && !(isSessionOver() || isSigningOut())) {
    rememberFirstSteps(organizationId, facts);
  }
}

/**
 * Whether the store ever sold (V, cancelled sales included) and, when it did not, what it has: a product (P, archived
 * ones included) and a variant with stock (E). Null when the store sold: then there is no checklist (AC-23).
 */
async function readChecklist(
  organizationId: string,
  isCurrent: IsCurrent,
  readsStock: boolean
): Promise<HomeChecklist | "sold" | null> {
  const sold = await readWithRetry(
    (signal) => orpcClient.sale.list({ limit: 1, organizationId }, { signal }),
    { isCurrent }
  );
  if (sold.sales.length > 0) {
    return "sold";
  }
  if (!readsStock) {
    return null;
  }
  const [product] = (
    await readWithRetry(
      (signal) =>
        orpcClient.inventory.listBalances(
          { limit: 1, organizationId, productStatus: "all" },
          { signal }
        ),
      { isCurrent }
    )
  ).entries;
  if (product === undefined) {
    return { firstProductId: null, hasStock: false };
  }
  const stocked = await readWithRetry(
    (signal) =>
      orpcClient.inventory.listBalances(
        { limit: 1, organizationId, stock: "with_stock" },
        { signal }
      ),
    { isCurrent }
  );
  return {
    firstProductId: product.productId,
    hasStock: stocked.entries.length > 0,
  };
}

/** S, and C only when the month sold an item without a known cost (§ 2.4). */
async function readStock(
  organizationId: string,
  isCurrent: IsCurrent,
  withUnknownCost: Promise<boolean>
): Promise<{ unknownCost: BalancesPage | null; withoutStock: BalancesPage }> {
  const page = (list: { entries: unknown[]; nextCursor: string | null }) => ({
    count: list.entries.length,
    more: list.nextCursor !== null,
  });
  const withoutStock = readWithRetry(
    (signal) =>
      orpcClient.inventory.listBalances(
        {
          limit: PAGE,
          organizationId,
          productStatus: "active",
          stock: "without_stock",
        },
        { signal }
      ),
    { isCurrent }
  );
  // awaited below, after C: a failure of S meanwhile is not an unhandled rejection
  withoutStock.catch(() => undefined);
  const unknownCost = (await withUnknownCost)
    ? await readWithRetry(
        (signal) =>
          orpcClient.inventory.listBalances(
            {
              cost: "unknown",
              limit: PAGE,
              organizationId,
              productStatus: "active",
            },
            { signal }
          ),
        { isCurrent }
      )
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
  // once the server refused the figures or the goals here, nothing of this page keeps a copy again
  const copyRefused = useRef(false);

  /** Sets a block, if the answer is of the newest read; a refusal of the session goes to the shell instead. */
  const settle = useCallback(
    <K extends "checklist" | "figures" | "goals" | "rhythm" | "stock">(
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
      if (
        "error" in outcome &&
        (key === "figures" || key === "goals" || key === "rhythm") &&
        refusesCopy(outcome.error)
      ) {
        // what the server refuses now, the device does not show from its copy (ADR 0056)
        copyRefused.current = true;
        clearOrganizationResultCopies(browserStorage(), organizationId);
        setState((now) => ({ ...now, copyRefused: true }));
      }
      const block = "block" in outcome ? outcome.block : failed(outcome.error);
      // a refresh that fails leaves the figures read before on the screen: they are still the last confirmed ones
      setState((now) =>
        "error" in outcome && keep && now[key].status === "ready"
          ? now
          : { ...now, [key]: block }
      );
    },
    [organizationId]
  );

  const loadFigures = useCallback(
    async (
      ticket: number,
      keep: boolean,
      force: boolean
    ): Promise<HomeFigures | null> => {
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
        const isCurrent = () => ticket === sequence.current.numbers;
        // B comes from the copy of the store's day, unless the gesture asks for the server ("Atualizar", "Tentar
        // novamente") or the refusal of this store was already seen here
        const { figures, reusedBefore, today } = await readFiguresOfTheDay(
          organizationId,
          isCurrent,
          guess,
          timezone,
          (day) =>
            force || copyRefused.current
              ? null
              : reusablePreviousWindow(
                  OFFLINE_RUNTIME_ENABLED ? browserStorage() : null,
                  organizationId,
                  homePeriods(day).before,
                  day,
                  timezone
                ),
          (generatedAt) => {
            skew.current = Date.parse(generatedAt) - Date.now();
          }
        );
        const ready = { ...figures, today };
        if (ticket === sequence.current.numbers) {
          keepPreviousWindow(organizationId, ready.before, copyRefused);
          keepCopy(reads.report && !copyRefused.current, (storage) => {
            writePeriodSummaryCache(
              storage,
              organizationId,
              today.slice(0, 7),
              ready.month,
              {
                offlineRuntimeEnabled: OFFLINE_RUNTIME_ENABLED,
                signingOut: isSigningOut(),
              }
            );
            // a B taken from the copy is not written again: it keeps the stamp of the read it came from
            const change: Partial<HomeCopy> = reusedBefore
              ? {}
              : { before: ready.before };
            if (!noSaleCounted(ready.month, ready.before)) {
              change.hadSale = true;
            }
            writeHomeCopy(storage, organizationId, change);
          });
          setMidnightAt(
            Date.now() +
              msUntilNextMidnight(Date.now() + skew.current, timezone)
          );
        }
        settle(ticket, "figures", { block: { data: ready, status: "ready" } });
        return ready;
      } catch (error) {
        // a read the page left behind (cancelled) says nothing; no connection: the page shows the copy (§ 7.4), and
        // the read is made again when the connection is back
        if (
          ticket === sequence.current.numbers &&
          !(await noConnection(error))
        ) {
          settle(ticket, "figures", { error }, keep);
        }
        return null;
      }
    },
    [organizationId, reads.report, settle, timezone]
  );

  const loadChecklist = useCallback(
    async (ticket: number, figures: HomeFigures | null) => {
      const current = () => ticket === sequence.current.numbers;
      const unasked = figures === null || !reads.sales;
      if (unasked || !noSaleCounted(figures.month, figures.before)) {
        // the figures counted a sale: the foot of the menu drops its steps too
        tellFirstSteps(organizationId, null, !unasked && current());
        settle(ticket, "checklist", { block: { data: null, status: "ready" } });
        return;
      }
      try {
        const read = await readChecklist(
          organizationId,
          current,
          reads.inventory
        );
        const data = read === "sold" ? null : read;
        tellFirstSteps(organizationId, data, current());
        if (read === "sold" && current()) {
          keepCopy(reads.report && !copyRefused.current, (storage) =>
            writeHomeCopy(storage, organizationId, { hadSale: true })
          );
        }
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
    [organizationId, reads.inventory, reads.report, reads.sales, settle]
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
        const { goals } = await readWithRetry(
          (signal) =>
            orpcClient.goal.list({ organizationId, status: "all" }, { signal }),
          { isCurrent: () => ticket === sequence.current.goals }
        );
        if (ticket === sequence.current.goals) {
          // the goal the card shows, as it shows it now, and when (§ 7.3)
          const at = new Date(Date.now() + skew.current);
          const today = calendarDayInTimezone(at, timezone);
          keepCopy(reads.report && !copyRefused.current, (storage) =>
            writeHomeCopy(storage, organizationId, {
              goal: {
                at: at.toISOString(),
                view: pickGoal(goals, today, timezone),
              },
            })
          );
        }
        settle(ticket, "goals", { block: { data: goals, status: "ready" } });
      } catch (error) {
        if (ticket === sequence.current.goals && !(await noConnection(error))) {
          settle(ticket, "goals", { error }, keep);
        }
      }
    },
    [organizationId, reads.goals, reads.report, settle, timezone]
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
          () => ticket === sequence.current.numbers,
          figures.then(
            (read) =>
              reads.unknownCost &&
              (read?.month.quality.itemLinesWithUnknownCost ?? 0) > 0
          )
        );
        settle(ticket, "stock", { block: { data, status: "ready" } });
      } catch (error) {
        if (
          ticket === sequence.current.numbers &&
          !(await noConnection(error))
        ) {
          settle(ticket, "stock", { error }, keep);
        }
      }
    },
    [organizationId, reads.inventory, reads.unknownCost, settle]
  );

  // the figures of the last read: "Tentar novamente" of the map reads the series of their today again
  const lastFigures = useRef<HomeFigures | null>(null);

  /**
   * The series of the map, from the first Sunday of the 26 weeks to the eve of the month (the month is the figures').
   * Without the figures it is not read: the map is drawn only beside them. The copy is written only after the answer,
   * with the guard asked then: a read still in flight when "Sair" starts writes nothing. A copy read on the store's
   * today is the series without asking again (one read a day per device, CPU-1e); only `force`, the gesture of
   * "Tentar novamente", reads past it. It is served only with `figures` read from the server in this load, which asks
   * the same capability as `dailySales` (`report:read`): a person who lost it gets the refusal there, and the refusal
   * clears the series first.
   */
  const loadRhythm = useCallback(
    async (
      ticket: number,
      figures: HomeFigures | null,
      keep: boolean,
      force = false
    ) => {
      if (!reads.report) {
        settle(ticket, "rhythm", { block: { status: "hidden" } });
        return;
      }
      if (figures === null) {
        return;
      }
      lastFigures.current = figures;
      const period = rhythmPeriod(figures.today);
      const kept = force
        ? null
        : rhythmOfToday(organizationId, period, figures.today, copyRefused);
      if (kept) {
        settle(ticket, "rhythm", { block: { data: kept, status: "ready" } });
        return;
      }
      if (!keep) {
        settle(ticket, "rhythm", { block: { status: "loading" } });
      }
      try {
        const series = await readWithRetry(() =>
          orpcClient.report.dailySales({ organizationId, ...period })
        );
        if (!isDailySeries(series, period)) {
          // not what the server sends (a captive portal page, a proxy): as if it had not answered
          throw new Error("daily_sales_malformed");
        }
        if (ticket === sequence.current.numbers) {
          keepRhythm(organizationId, series, figures.today, copyRefused);
        }
        settle(ticket, "rhythm", { block: { data: series, status: "ready" } });
      } catch (error) {
        if (!(await noConnection(error))) {
          settle(ticket, "rhythm", { error }, keep);
        }
      }
    },
    [organizationId, reads.report, settle]
  );

  /** The figures, then the checklist and the map that depend on them; the stock waits for them only to decide on C. */
  const loadNumbers = useCallback(
    (ticket: number, keep: boolean, force: boolean) => {
      const figures = loadFigures(ticket, keep, force);
      const checklist = figures.then((read) => loadChecklist(ticket, read));
      const rhythm = figures.then((read) => loadRhythm(ticket, read, keep));
      return { checklist, figures, rhythm };
    },
    [loadChecklist, loadFigures, loadRhythm]
  );

  /** The figures and what hangs on them (the checklist, and the stock, which waits for them only to decide on C). */
  const loadNumbersAndStock = useCallback(
    (keep: boolean, force: boolean) => {
      sequence.current.numbers += 1;
      const ticket = sequence.current.numbers;
      const { checklist, figures, rhythm } = loadNumbers(ticket, keep, force);
      checklist.catch(() => undefined);
      rhythm.catch(() => undefined);
      loadStock(ticket, figures, keep).catch(() => undefined);
      return figures;
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

  /**
   * Reads every block; `keep` leaves what is on screen while the new answer comes (a refresh, not an opening) and
   * `force` reads B from the server instead of taking the copy of the store's day. Returns the read of the figures
   * (null without a connection, when nothing is read).
   */
  const loadAll = useCallback(
    (keep: boolean, force = false) => {
      // no read without a connection: the copy is on the screen, and the return of the connection reads
      if (!browserConnection.isOnline()) {
        return null;
      }
      lastReadAt.current = Date.now();
      setState((now) => ({ ...now, sessionRefused: false }));
      const figures = loadNumbersAndStock(keep, force);
      loadGoalsAgain(keep);
      return figures;
    },
    [loadGoalsAgain, loadNumbersAndStock]
  );
  /** A refresh, unless the session already ended here: its notice is on the screen, and every read would be a 401. */
  const refresh = useCallback(() => {
    if (!isSessionOver()) {
      loadAll(true);
    }
  }, [loadAll]);

  const [reloading, setReloading] = useState(false);
  /** "Atualizar": every block is read again, and B and the month both come from the server, never from the copy. */
  const reload = useCallback(() => {
    if (isSessionOver()) {
      return;
    }
    const read = loadAll(true, true);
    if (read) {
      setReloading(true);
      read.finally(() => setReloading(false)).catch(() => undefined);
    }
  }, [loadAll]);

  // the connection is back: everything is read again, keeping on the screen what is there (the tab of the chart, the
  // scroll) until the answers come
  const online = useConnectionReturn(refresh);

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
  const retryFigures = useCallback(() => {
    loadNumbersAndStock(false, true).catch(() => undefined);
  }, [loadNumbersAndStock]);
  const retryGoals = useCallback(() => loadGoalsAgain(false), [loadGoalsAgain]);
  // "Tentar novamente" of the map: only its series, for the today of the figures on the screen
  const retryRhythm = useCallback(() => {
    loadRhythm(
      sequence.current.numbers,
      lastFigures.current,
      false,
      true
    ).catch(() => undefined);
  }, [loadRhythm]);
  /** The server's clock as the device estimates it from the last answer (the device's own before any). */
  const serverNow = useCallback(() => Date.now() + skew.current, []);
  return {
    online,
    reads,
    reload,
    reloading,
    retryFigures,
    retryGoals,
    retryRhythm,
    serverNow,
    state,
  };
}
