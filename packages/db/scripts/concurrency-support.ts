import { Client } from "pg";
import { assertAllowedGateUrl } from "./gate-hosts";

/**
 * Support for the race checks of the gates (suite `gates:concurrency`,
 * docs/architecture/concurrency-matrix.md).
 *
 * A bare `Promise.allSettled` of N commands proves little: the commands may run
 * one after another (a fast one finishes before the next one connects) and the
 * check passes without anything ever competing. `raceBehindLock` makes the
 * competition certain and visible:
 *
 *   1. a holder transaction takes the contended lock (a row, or the uncommitted
 *      unique key) before anything starts;
 *   2. every racer is released from one start barrier, so they begin together;
 *   3. the gate waits until the database itself reports that racers are blocked
 *      by the holder, directly or through a racer queued behind it
 *      (`pg_blocking_pids`), and fails if they never are: a race that did not
 *      queue on the lock it was meant to contend for is a failure;
 *   4. the holder rolls back and all racers fight for the lock at once.
 *
 * The observer reads `pg_stat_activity` and `pg_blocking_pids` for backends of
 * other roles, so it needs the owner of the disposable database (a superuser
 * or a member of `pg_read_all_stats`, as the gate owner is). Without it the
 * gate fails early with a message that says so, before any racer starts; it
 * never passes by it.
 *
 * Rounds: `POLARIS_CONCURRENCY_REPEAT` (default 1, `gates:concurrency` sets 3,
 * at most 10) says how many times a gate repeats each race with fresh data.
 * The cap is the smallest organization a gate creates per round: `inventory`
 * keeps one Free organization (50 variants) for all of its rounds.
 */

const MAX_ROUNDS = 10;
const POLL_MS = 10;
const WAIT_LIMIT_MS = 15_000;

export function raceRounds(): number {
  const raw = process.env.POLARIS_CONCURRENCY_REPEAT;
  if (raw === undefined || raw === "") {
    return 1;
  }
  const rounds = Number(raw);
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > MAX_ROUNDS) {
    throw new Error(
      `POLARIS_CONCURRENCY_REPEAT must be an integer from 1 to ${MAX_ROUNDS}.`
    );
  }
  return rounds;
}

/** Runs `body` once per round (POLARIS_CONCURRENCY_REPEAT), one after another, and returns the number of rounds. */
export async function eachRound(
  body: (round: number) => Promise<void>
): Promise<number> {
  const rounds = raceRounds();
  for (let round = 0; round < rounds; round += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: rounds repeat the race one after another on purpose
    await body(round);
  }
  return rounds;
}

export interface Statement {
  params?: unknown[];
  sql: string;
}

export interface RaceOptions<T> {
  /** Direct owner URL of the disposable database (the holder and the observer connect here). */
  adminUrl: string;
  /** Statements the holder runs inside its transaction to take the contended lock. */
  hold: Statement[];
  /** Names the race in the failure message. */
  label: string;
  /** How many racers must be seen blocked on a lock before the holder lets go (default: all). */
  minWaiting?: number;
  racers: Array<() => Promise<T>>;
  /** What the holder does when the racers are blocked: `rollback` (default, the lock only held them) or `commit` (what it wrote stays). */
  release?: "commit" | "rollback";
}

export interface RaceReport<T> {
  results: PromiseSettledResult<T>[];
  /** Largest number of racer backends seen waiting on a lock before the release. */
  waiting: number;
}

const identifier = /^[a-z_][a-z0-9_]*$/;

/** Takes the row lock a racer would take: `SELECT ... FOR UPDATE` of one row (or of the rows of a list) by one column. */
export function lockRow(
  table: string,
  column: string,
  value: string | number | string[]
): Statement {
  if (!(identifier.test(table) && identifier.test(column))) {
    throw new Error("lockRow takes plain table and column names.");
  }
  return {
    params: [value],
    sql: Array.isArray(value)
      ? `SELECT 1 FROM public.${table} WHERE ${column} = ANY($1) FOR UPDATE`
      : `SELECT 1 FROM public.${table} WHERE ${column} = $1 FOR UPDATE`,
  };
}

/** Takes the lock on the product row of a variant: the lock every stock command queues on. */
export function lockProductOfVariant(variantId: string): Statement {
  return {
    params: [variantId],
    sql: "SELECT 1 FROM public.products WHERE id = (SELECT product_id FROM public.product_variants WHERE id = $1) FOR UPDATE",
  };
}

/** Takes a transaction-scoped advisory lock under the same key the code under test uses (`hashtextextended(key, 0)`). */
export function advisoryLock(key: string): Statement {
  return {
    params: [key],
    sql: "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
  };
}

/** Backends blocked by the holder, directly or behind a backend that is (the queue of a lock). */
const blockedByHolderSql = `
  WITH RECURSIVE blocked(pid) AS (
    SELECT activity.pid
    FROM pg_catalog.pg_stat_activity AS activity
    WHERE activity.datname = pg_catalog.current_database()
      AND $1::int = ANY (pg_catalog.pg_blocking_pids(activity.pid))
    UNION
    SELECT activity.pid
    FROM pg_catalog.pg_stat_activity AS activity
    JOIN blocked ON blocked.pid = ANY (pg_catalog.pg_blocking_pids(activity.pid))
    WHERE activity.datname = pg_catalog.current_database()
  )
  SELECT count(*)::int AS waiting FROM blocked`;

const pause = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function raceBehindLock<T>(
  options: RaceOptions<T>
): Promise<RaceReport<T>> {
  const { adminUrl, hold, label, racers } = options;
  assertAllowedGateUrl(adminUrl);
  const minWaiting = options.minWaiting ?? racers.length;
  const holder = new Client({ connectionString: adminUrl });
  const observer = new Client({ connectionString: adminUrl });
  let open = false;
  let running: Promise<PromiseSettledResult<T>[]> | undefined;
  try {
    await Promise.all([holder.connect(), observer.connect()]);
    const pid = (
      await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
    ).rows[0]?.pid;
    if (pid === undefined) {
      throw new Error(`${label}: the holder has no backend pid.`);
    }
    const access = await observer.query<{ allowed: boolean }>(
      `SELECT (role.rolsuper OR pg_catalog.pg_has_role(role.oid, 'pg_read_all_stats', 'USAGE')) AS allowed
         FROM pg_catalog.pg_roles AS role
        WHERE role.rolname = current_user`
    );
    if (access.rows[0]?.allowed !== true) {
      throw new Error(
        `${label}: the owner role cannot observe other roles' backends (it needs superuser or pg_read_all_stats), so no race can be shown to compete.`
      );
    }
    await holder.query("BEGIN");
    open = true;
    for (const statement of hold) {
      // biome-ignore lint/performance/noAwaitInLoops: the holder takes its locks in order
      const taken = await holder.query(statement.sql, statement.params);
      if (taken.command === "SELECT" && taken.rowCount === 0) {
        throw new Error(`${label}: the holder found nothing to lock.`);
      }
    }

    // the start barrier: every racer is created, then all are released together
    let start: () => void = () => undefined;
    const go = new Promise<void>((resolve) => {
      start = resolve;
    });
    const started = Promise.allSettled(
      racers.map(async (racer) => {
        await go;
        return await racer();
      })
    );
    running = started;
    start();
    let finished = false;
    started.then(() => {
      finished = true;
    });

    let waiting = 0;
    const deadline = Date.now() + WAIT_LIMIT_MS;
    // racers that all finish while the holder still holds the lock never competed for it
    while (waiting < minWaiting && !finished && Date.now() < deadline) {
      // biome-ignore lint/performance/noAwaitInLoops: polls until the racers are blocked
      const seen = await observer.query<{ waiting: number }>(
        blockedByHolderSql,
        [pid]
      );
      waiting = Math.max(waiting, seen.rows[0]?.waiting ?? 0);
      if (waiting < minWaiting) {
        await pause(POLL_MS);
      }
    }
    await holder.query(options.release === "commit" ? "COMMIT" : "ROLLBACK");
    open = false;
    const results = await started;
    if (waiting < minWaiting) {
      const [firstFailure] = rejections(results);
      throw new Error(
        `${label}: the race did not compete (${waiting} of the ${minWaiting} expected racers were ever blocked by the holder)${
          firstFailure === undefined
            ? ""
            : `; the first racer failed with: ${String(firstFailure).slice(0, 300)}`
        }.`
      );
    }
    return { results, waiting };
  } finally {
    if (open) {
      await holder.query("ROLLBACK").catch(() => undefined);
    }
    // racers never outlive the call, even when the observer or the holder broke
    if (running) {
      await running;
    }
    await Promise.allSettled([holder.end(), observer.end()]);
  }
}

/** The racers that failed, as the errors they raised. */
export function rejections<T>(results: PromiseSettledResult<T>[]): unknown[] {
  return results
    .filter(
      (result): result is PromiseRejectedResult => result.status === "rejected"
    )
    .map((result) => result.reason);
}

/** The racers that succeeded, as the values they returned. */
export function fulfilled<T>(results: PromiseSettledResult<T>[]): T[] {
  return results
    .filter(
      (result): result is PromiseFulfilledResult<T> =>
        result.status === "fulfilled"
    )
    .map((result) => result.value);
}
