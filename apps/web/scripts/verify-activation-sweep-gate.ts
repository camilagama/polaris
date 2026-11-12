// biome-ignore-all lint/performance/noAwaitInLoops: a gate runs its probes strictly one at a time, for a clear failure
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import {
  type ActivationSweepReport,
  type BillingStore,
  createBillingStore,
} from "@polaris/db/billing-store";
import { createDatabase } from "@polaris/db/client";
import { outboxIdempotencyKey } from "@polaris/domain/events/outbox";
import {
  disposableHostPattern,
  gateBranchPattern,
  journalMigrationCount,
  poolerPattern,
  redactedFailure,
  requiredEnvironment,
  temporaryRuntimeUrl,
} from "../../../packages/db/scripts/sales-gate-support";
import { runActivationSweep } from "../src/server/billing/activation-sweep";

/**
 * The hourly sweep of the activation series in the Worker (ADR 0106, D5 and D6; item 7b of the cut of phase 1b) on a
 * real PostgreSQL 18, through the Worker's own `runActivationSweep` and the real billing store on a login of the
 * billing role, with the clock fixed on the day the database is in (10:00 of São Paulo, `ten`):
 *   1. AC-7b.1: with the switch off, before and a day later, no notice and no outbox event is born, and the one write
 *      is clearing the instant (a second sweep off writes nothing);
 *   2. AC-7b.3: the first sweep on records the instant at its clock, and a store created before it is recorded skipped
 *      `series_off`, with no event; on again with no sweep off between keeps the instant (a store created after it is
 *      due), and off for one sweep then on records a new instant (a store created between the two is `series_off`);
 *   3. AC-7b.5: a1 at 23h59 of the store is not recorded and at 24 h is, with its event; 3 days less a minute after
 *      the trigger is due and 3 days after is recorded skipped `expired`; at 12:00 and at 07:59 nothing is recorded,
 *      at 11:59 it is;
 *   4. AC-7b.4 and AC-7b.2: with 58 counted on the day of São Paulo (skipped ones beside them, not counted), three
 *      stores due: a sweep while another transaction holds the lock of the cap records nothing, two sweeps at once
 *      record the two earliest by trigger and no more (60 counted), an expired step is still recorded, an hour later
 *      nothing more, and the next day the third comes first in the order of the triggers (a batch of 1 says
 *      truncated);
 *   5. AC-7b.4: the count of the cap follows the day of the sweep's clock: with 58 recorded one second before
 *      midnight of São Paulo and 5 one second after, a sweep records two of three owed stores and the next morning's
 *      the third.
 * Every owed notice is checked against its event: type `activation.notice`, pending, the body with the notice's ID
 * alone and the key `activation.notice:<id>`. The stores the other gates left may also be recorded by these sweeps;
 * every check reads only the gate's own stores, except the counts that must not move at all and the cap of the day,
 * which counts everyone. A notice is recorded at the database's clock, so after each sweep the gate sets `recorded_at`
 * of what the sweep recorded to the clock of its case: the cap counts the day of that clock, and a gate that crossed
 * midnight of São Paulo would otherwise count another day (the last case proves the count one second either side of midnight with the real sweep). It runs before the gates of the Workers and deletes the activation.notice events written
 * since it started, so the dispatcher of web-worker meets none of them (that consumer does not exist yet). The
 * instant is cleared at the end; the fixtures stay, as in the other gates; the logins are dropped.
 */
const expectedDatabase =
  process.env.POLARIS_GATE_DATABASE ??
  process.env.POLARIS_SALES_GATE_DATABASE ??
  "neondb";

const ZONE = "America/Sao_Paulo";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const CAP = 60;
const CAP_LOCK = "activation_notice_candidates";
const CASE_LABEL = /^AC-7b\.\d(?: and AC-7b\.\d)?/;

const at = (base: Date, offset: number) => new Date(base.getTime() + offset);

interface Store {
  organizationId: string;
  userId: string;
}

interface NoticeRow {
  id: string;
  skipped_reason: string | null;
  step: string;
}

interface EventRow {
  attempts: number;
  event: unknown;
  idempotency_key: string;
  status: string;
}

type SeededOutcome = "owed" | "sent" | "skipped";

/** Notices recorded by hand on one store, a step each (a1, a2, a3), with `recorded_at` at `recordedAt`. */
async function seedNotices(
  pool: Pick<ReturnType<typeof createDatabase>["pool"], "query">,
  store: Store,
  outcomes: readonly SeededOutcome[],
  dueAt: Date,
  recordedAt: Date
) {
  for (const [index, outcome] of outcomes.entries()) {
    await pool.query(
      `INSERT INTO public.activation_notices (organization_id, user_id, step, due_at, recorded_at, sent_at, skipped_reason)
       VALUES ($1, $2, $3, $4, $6, CASE WHEN $5 = 'sent' THEN $4::timestamptz END, CASE WHEN $5 = 'skipped' THEN 'expired' END)`,
      [
        store.organizationId,
        store.userId,
        `a${index + 1}`,
        dueAt,
        outcome,
        recordedAt,
      ]
    );
  }
}

async function run() {
  const branch = requiredEnvironment("POLARIS_SALES_GATE_BRANCH");
  assert.match(branch, gateBranchPattern);
  const adminUrl = requiredEnvironment("POLARIS_SALES_GATE_DATABASE_URL");
  const parsedAdminUrl = new URL(adminUrl);
  assert.match(parsedAdminUrl.hostname, disposableHostPattern);
  assert.doesNotMatch(parsedAdminUrl.hostname, poolerPattern);

  const owner = createDatabase(adminUrl, { maxConnections: 3 });
  const logins: [string, string][] = [];
  const tests: string[] = [];
  const closers: (() => Promise<unknown>)[] = [];

  try {
    const server = await owner.pool.query<{
      database_name: string;
      server_version_num: string;
    }>(
      "SELECT current_database() AS database_name, current_setting('server_version_num') AS server_version_num"
    );
    const [serverRow] = server.rows;
    assert.ok(serverRow);
    assert.equal(serverRow.database_name, expectedDatabase);
    assert.ok(Number(serverRow.server_version_num) >= 180_000);
    const migrations = await owner.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations"
    );
    assert.equal(Number(migrations.rows[0]?.count), journalMigrationCount());
    tests.push(
      "disposable direct connection is PostgreSQL 18 with every migration replayed from scratch"
    );

    const role = `polaris_activation_sweep_gate_${randomUUID().replaceAll("-", "")}`;
    const password = randomBytes(24).toString("hex");
    await owner.pool.query(
      `CREATE ROLE "${role}" WITH LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`
    );
    await owner.pool.query(`GRANT "polaris_billing_runtime" TO "${role}"`);
    logins.push([role, "polaris_billing_runtime"]);
    const billingUrl = temporaryRuntimeUrl(adminUrl, role, password);
    // two stores of the billing role, as two isolates of the Worker would hold
    const first: BillingStore = createBillingStore(billingUrl);
    closers.push(() => first.close());
    const second: BillingStore = createBillingStore(billingUrl);
    closers.push(() => second.close());

    // the clock of every case: 10:00 of São Paulo on the day the database is in, so every store of the gate (at most
    // 5 days back) stays inside the 14 days the owner of the series sees, and what the sweeps record is set to the day
    // of the cap (recordedAt)
    const clock = await owner.pool.query<{ ten: Date }>(
      `SELECT (pg_catalog.date_trunc('day', now() AT TIME ZONE '${ZONE}') + interval '10 hours') AT TIME ZONE '${ZONE}' AS ten`
    );
    const ten = clock.rows[0]?.ten;
    assert.ok(ten instanceof Date);
    const noon = at(ten, 2 * HOUR);
    const started = (
      await owner.pool.query<{ now: Date }>("SELECT now() AS now")
    ).rows[0]?.now;
    assert.ok(started instanceof Date);
    closers.push(() =>
      owner.pool.query(
        "DELETE FROM public.event_outbox WHERE type = 'activation.notice' AND created_at >= $1",
        [started]
      )
    );

    /**
     * Runs `work` and sets `recorded_at` of the notices it recorded to `now`, the clock of the case. The cap of the day
     * is read from the day of the `now` a sweep is given, but a notice is recorded at the database's real clock: if the
     * gate crossed midnight of São Paulo, what a case recorded would fall on another day than the one its cap counts.
     * The notices already there are left as they are, found by their IDs among the rows at or after the real instant
     * the work started (a row pinned earlier to a future instant is among them, and is not touched). It takes every new
     * notice of the database, so two calls at once must share the same `now`.
     */
    const recordedAt = async <T>(
      now: Date,
      work: () => Promise<T>
    ): Promise<T> => {
      const began = (
        await owner.pool.query<{ began: Date }>(
          "SELECT pg_catalog.clock_timestamp() AS began"
        )
      ).rows[0]?.began;
      assert.ok(began instanceof Date);
      const known = await owner.pool.query<{ id: string }>(
        "SELECT id::text AS id FROM public.activation_notices WHERE recorded_at >= $1",
        [began]
      );
      const result = await work();
      await owner.pool.query(
        "UPDATE public.activation_notices SET recorded_at = $1 WHERE recorded_at >= $2 AND id::text <> ALL($3::text[])",
        [now, began, known.rows.map((row) => row.id)]
      );
      return result;
    };
    const sweep = (
      switchOn: boolean,
      now: Date,
      store: BillingStore = first
    ): Promise<ActivationSweepReport> =>
      recordedAt(now, () =>
        runActivationSweep(
          { ACTIVATION_EMAILS_ENABLED: switchOn ? "true" : "false" },
          store,
          now
        )
      );
    const instant = async () => {
      const state = await owner.pool.query<{
        enabled_since: Date | null;
        updated_at: Date;
      }>(
        "SELECT enabled_since, updated_at FROM public.activation_series_state"
      );
      return state.rows[0] ?? null;
    };
    const totals = async () => {
      const result = await owner.pool.query<{
        events: string;
        notices: string;
      }>(
        `SELECT (SELECT count(*) FROM public.activation_notices)::text AS notices,
                (SELECT count(*) FROM public.event_outbox WHERE type = 'activation.notice')::text AS events`
      );
      return {
        events: Number(result.rows[0]?.events),
        notices: Number(result.rows[0]?.notices),
      };
    };
    const countedOn = async (day: Date) =>
      Number(
        (
          await owner.pool.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM public.activation_notices
              WHERE skipped_reason IS NULL
                AND recorded_at >= (pg_catalog.date_trunc('day', $1::timestamptz AT TIME ZONE '${ZONE}') AT TIME ZONE '${ZONE}')
                AND recorded_at < ((pg_catalog.date_trunc('day', $1::timestamptz AT TIME ZONE '${ZONE}') + interval '1 day') AT TIME ZONE '${ZONE}')`,
            [day]
          )
        ).rows[0]?.n
      );
    const countedToday = () => countedOn(ten);
    const newStore = async (
      createdAt: Date,
      status = "active"
    ): Promise<Store> => {
      const userId = randomUUID();
      const organizationId = randomUUID();
      await owner.pool.query(
        'INSERT INTO public."user" (id, name, email, email_verified) VALUES ($1, $2, $3, true)',
        [
          userId,
          "Pessoa do gate da varredura",
          `activation-sweep-${userId}@example.invalid`,
        ]
      );
      await owner.pool.query(
        "INSERT INTO public.organizations (id, name, timezone, status, created_at) VALUES ($1, 'Loja do gate da varredura', $2, $3, $4)",
        [organizationId, ZONE, status, createdAt]
      );
      await owner.pool.query(
        "INSERT INTO public.memberships (organization_id, user_id, role, status, created_at) VALUES ($1, $2, 'owner', 'active', $3)",
        [organizationId, userId, createdAt]
      );
      return { organizationId, userId };
    };
    const noticesOf = async (store: Store) =>
      (
        await owner.pool.query<NoticeRow>(
          "SELECT id, step, skipped_reason FROM public.activation_notices WHERE organization_id = $1 AND user_id = $2 ORDER BY step",
          [store.organizationId, store.userId]
        )
      ).rows;
    const stepsOf = async (store: Store) =>
      (await noticesOf(store)).map(
        (row) => `${row.step}:${row.skipped_reason ?? "owed"}`
      );
    const eventsOf = async (store: Store) =>
      (
        await owner.pool.query<EventRow>(
          "SELECT status, attempts, event, idempotency_key FROM public.event_outbox WHERE organization_id = $1 AND type = 'activation.notice'",
          [store.organizationId]
        )
      ).rows.sort((left, right) =>
        left.idempotency_key < right.idempotency_key ? -1 : 1
      );
    /** Each owed notice of the store has its one event, and a skipped one none. */
    const assertEvents = async (store: Store, label: string) => {
      const notices = await noticesOf(store);
      const owed = notices.filter((row) => row.skipped_reason === null);
      const expected = owed
        .map((row) => ({
          attempts: 0,
          event: { noticeId: row.id },
          idempotency_key: outboxIdempotencyKey("activation.notice", row.id),
          status: "pending",
        }))
        .sort((left, right) =>
          left.idempotency_key < right.idempotency_key ? -1 : 1
        );
      assert.deepEqual(await eventsOf(store), expected, label);
    };
    /**
     * Sweeps on at `now` until a sweep records nothing, and answers the sum: the stores the other gates left may fill
     * more than one batch of 50 ahead of the case's own.
     */
    const settle = async (now: Date): Promise<ActivationSweepReport> => {
      const total = { due: 0, expired: 0, seriesOff: 0, truncated: false };
      for (let round = 0; round < 10; round += 1) {
        const report = await sweep(true, now);
        if (report.due + report.expired + report.seriesOff === 0) {
          return total;
        }
        total.due += report.due;
        total.expired += report.expired;
        total.seriesOff += report.seriesOff;
        total.truncated ||= report.truncated;
      }
      return assert.fail("the sweep did not settle in 10 rounds");
    };

    // 1. AC-7b.1: off is nothing but clearing the instant
    const offStore = await newStore(at(ten, -2 * DAY));
    await owner.pool.query(
      `INSERT INTO public.activation_series_state (enabled_since) VALUES ($1)
       ON CONFLICT (id) DO UPDATE SET enabled_since = EXCLUDED.enabled_since`,
      [at(ten, -5 * DAY)]
    );
    const beforeOff = await totals();
    const offReport = await sweep(false, ten);
    assert.deepEqual(offReport, {
      due: 0,
      expired: 0,
      seriesOff: 0,
      truncated: false,
    });
    const cleared = await instant();
    assert.equal(cleared?.enabled_since, null, "off clears the instant");
    await sweep(false, at(ten, DAY));
    const stillCleared = await instant();
    assert.equal(stillCleared?.enabled_since, null);
    assert.equal(
      stillCleared?.updated_at.getTime(),
      cleared?.updated_at.getTime(),
      "a sweep off with the instant already cleared writes nothing"
    );
    assert.deepEqual(
      await totals(),
      beforeOff,
      "no notice and no event of anyone, today nor a day later"
    );
    assert.deepEqual(await stepsOf(offStore), []);
    tests.push(
      "AC-7b.1: with the switch off, at 10:00 of São Paulo and a day later, with a store whose a1 is owed, no activation notice and no activation.notice event is born anywhere, the instant of the switch is cleared, and a second sweep off with it already cleared does not touch the row (updated_at unchanged)"
    );

    // 2. AC-7b.3: the instant of the switch and its cycle
    const firstOn = await settle(ten);
    assert.equal(
      (await instant())?.enabled_since?.getTime(),
      ten.getTime(),
      "the first sweep on records the instant at its own clock"
    );
    assert.ok(firstOn.seriesOff >= 1);
    assert.equal(firstOn.due, 0, "nothing piled up goes out at the switch");
    assert.deepEqual(await stepsOf(offStore), ["a1:series_off"]);
    assert.deepEqual(await eventsOf(offStore), [], "series_off has no event");

    await sweep(false, ten);
    const earlier = at(ten, -3 * DAY);
    await sweep(true, earlier);
    assert.equal(
      (await instant())?.enabled_since?.getTime(),
      earlier.getTime()
    );
    // switched on before both: the first owes its a1 two days ago, the second only yesterday
    const keptStore = await newStore(at(earlier, HOUR));
    const cycledStore = await newStore(at(ten, -2 * DAY));
    const twoDaysAgo = at(ten, -2 * DAY + HOUR);
    const kept = await settle(twoDaysAgo);
    assert.equal(
      (await instant())?.enabled_since?.getTime(),
      earlier.getTime(),
      "on again with no sweep off between keeps the instant"
    );
    assert.ok(kept.due >= 1);
    assert.deepEqual(await stepsOf(keptStore), ["a1:owed"]);
    await assertEvents(keptStore, "the store created after the kept instant");
    assert.deepEqual(await stepsOf(cycledStore), []);
    await sweep(false, ten);
    await settle(ten);
    assert.equal(
      (await instant())?.enabled_since?.getTime(),
      ten.getTime(),
      "off for one sweep, then on: a new instant"
    );
    assert.deepEqual(await stepsOf(cycledStore), ["a1:series_off"]);
    assert.deepEqual(await eventsOf(cycledStore), []);
    tests.push(
      "AC-7b.3: the first sweep on records the instant at its clock and records nothing owed: a store created before it comes back a1 series_off, recorded skipped with no event; on again with no sweep off between (two deploys inside the hour) keeps the instant, so a store created after it gets its a1 owed with its event; off for one sweep and then on records a new instant, and a store created between the two instants is recorded series_off"
    );

    // 3. AC-7b.5: the trigger, the validity and the hours of the window
    await sweep(false, ten);
    await sweep(true, at(ten, -5 * DAY));
    // what the other gates left owes before the case's stores exist, so the sweep at 10:00 below meets only them
    await settle(ten);
    const almostDay = await newStore(at(ten, -DAY + MINUTE));
    const fullDay = await newStore(at(ten, -DAY));
    const stillValid = await newStore(at(ten, -4 * DAY + MINUTE));
    const lapsed = await newStore(at(ten, -4 * DAY));
    const lateMorning = await newStore(at(ten, -DAY + 2 * HOUR - MINUTE));
    const outside = await totals();
    for (const closed of [noon, at(ten, -2 * HOUR - MINUTE)]) {
      const report = await sweep(true, closed);
      assert.deepEqual(report, {
        due: 0,
        expired: 0,
        seriesOff: 0,
        truncated: false,
      });
    }
    assert.deepEqual(
      await totals(),
      outside,
      "nothing of anyone at 12:00 nor at 07:59"
    );
    await settle(ten);
    assert.deepEqual(await stepsOf(almostDay), [], "23h59: not yet");
    assert.deepEqual(await stepsOf(fullDay), ["a1:owed"], "24 h: owed");
    assert.deepEqual(
      await stepsOf(stillValid),
      ["a1:owed"],
      "3 days less a minute after the trigger"
    );
    assert.deepEqual(
      await stepsOf(lapsed),
      ["a1:expired", "a2:owed"],
      "3 days after the trigger the a1 is expired (and the a2 of the 5th day is owed)"
    );
    assert.deepEqual(await stepsOf(lateMorning), []);
    for (const store of [fullDay, stillValid, lapsed]) {
      await assertEvents(store, "the owed notices of 10:00");
    }
    await settle(at(noon, -MINUTE));
    assert.deepEqual(await stepsOf(lateMorning), ["a1:owed"], "11:59");
    await assertEvents(lateMorning, "the owed notice of 11:59");
    tests.push(
      "AC-7b.5: nothing is recorded for anyone at 12:00 nor at 07:59 of São Paulo; at 10:00 an a1 at 23h59 of its store is not recorded and one at 24 h is, owed with its event; an a1 3 days less a minute past its trigger is owed and one 3 days past it is recorded skipped expired with no event (its a2 of the 5th day owed); an a1 falling due at 11:59 is recorded at 11:59"
    );

    // 4. AC-7b.4 and AC-7b.2: the cap of the day, with two sweeps at once
    await settle(ten);
    const capped = [
      await newStore(at(ten, -2 * DAY + MINUTE)),
      await newStore(at(ten, -2 * DAY + 2 * MINUTE)),
      await newStore(at(ten, -2 * DAY + 3 * MINUTE)),
    ];
    // its a1 is 3 days past the trigger, its a2 owed an hour ago: after the three above in the order of the triggers
    const expiring = await newStore(at(ten, -4 * DAY - HOUR));
    const counted = await countedToday();
    assert.ok(counted <= CAP - 2, `room for the case (${counted} counted)`);
    const toSeed = CAP - 2 - counted;
    // the seeded notices: stores older than the 14 days the owner of the series sees, so never candidates themselves
    const outcomes: SeededOutcome[] = [
      ...Array.from(
        { length: toSeed },
        (_, index): SeededOutcome => (index % 2 === 0 ? "owed" : "sent")
      ),
      "skipped",
      "skipped",
    ];
    for (let index = 0; index < outcomes.length; index += 3) {
      const store = await newStore(at(ten, -20 * DAY));
      await seedNotices(
        owner.pool,
        store,
        outcomes.slice(index, index + 3),
        at(ten, -HOUR),
        ten
      );
    }
    assert.equal(await countedToday(), CAP - 2);

    const holder = await owner.pool.connect();
    try {
      await holder.query("BEGIN");
      const taken = await holder.query<{ taken: boolean }>(
        "SELECT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended($1, 0)) AS taken",
        [CAP_LOCK]
      );
      assert.equal(taken.rows[0]?.taken, true);
      const blocked = await sweep(true, ten);
      assert.deepEqual(blocked, {
        due: 0,
        expired: 0,
        seriesOff: 0,
        truncated: false,
      });
      for (const store of [...capped, expiring]) {
        assert.deepEqual(await stepsOf(store), [], "the lock is held");
      }
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      holder.release();
    }

    const raced = await Promise.all([
      sweep(true, ten, first),
      sweep(true, ten, second),
    ]);
    assert.equal(
      raced.reduce((sum, report) => sum + report.due, 0),
      2,
      "two sweeps at once record two owed notices between them"
    );
    assert.ok(raced.some((report) => report.truncated));
    assert.equal(await countedToday(), CAP, "and the day stops at the cap");
    assert.deepEqual(await stepsOf(capped[0] as Store), ["a1:owed"]);
    assert.deepEqual(await stepsOf(capped[1] as Store), ["a1:owed"]);
    assert.deepEqual(await stepsOf(capped[2] as Store), []);
    assert.deepEqual(
      await stepsOf(expiring),
      ["a1:expired"],
      "an expired step is recorded at the cap, outside it"
    );
    for (const store of capped) {
      await assertEvents(store, "the owed notices at the cap");
    }

    const hourLater = await sweep(true, at(ten, HOUR));
    assert.equal(hourLater.due, 0, "the cap holds for the rest of the day");
    assert.equal(await countedToday(), CAP);
    assert.deepEqual(await stepsOf(capped[2] as Store), []);

    const tomorrow = at(ten, DAY);
    const firstOfTomorrow = await recordedAt(tomorrow, () =>
      first.sweepActivationSeries({
        enabled: true,
        limit: 1,
        now: tomorrow,
      })
    );
    assert.deepEqual(
      firstOfTomorrow,
      { due: 1, expired: 0, seriesOff: 0, truncated: true },
      "the next day a batch of 1 takes one and says more wait"
    );
    assert.deepEqual(
      await stepsOf(capped[2] as Store),
      ["a1:owed"],
      "the earliest trigger left over comes first"
    );
    assert.deepEqual(await stepsOf(expiring), ["a1:expired"]);
    await sweep(true, tomorrow);
    assert.deepEqual(await stepsOf(expiring), ["a1:expired", "a2:owed"]);
    await assertEvents(capped[2] as Store, "the next day");
    await assertEvents(expiring, "the next day");
    tests.push(
      "AC-7b.4 and AC-7b.2: with 58 notices counted on the day of São Paulo (owed and sent; 2 skipped beside them do not count) and three stores owed: a sweep while another transaction holds the lock of the cap records nothing; two sweeps at once, on two stores of the billing role, record two owed notices between them, the two earliest triggers, each with its event, the day stops at 60 counted and one of them says truncated, and an expired a1 is still recorded skipped; an hour later nothing more is recorded; the next day a batch of 1 records the third (the earliest trigger left) and says truncated, and the next sweep the a2 whose trigger came later"
    );

    await sweep(false, tomorrow);
    assert.equal((await instant())?.enabled_since, null);

    // 5. AC-7b.4: the count of the cap follows the day of the sweep's clock, not the hour the gate runs at. Three days
    // ahead, 58 notices are recorded one second before midnight of São Paulo and 5 one second after it: only the 58
    // are the day of the sweep, so two of three owed stores are recorded, and the next morning the third is
    const dayX = at(ten, 3 * DAY);
    const midnight = (
      await owner.pool.query<{ midnight: Date }>(
        `SELECT (pg_catalog.date_trunc('day', $1::timestamptz AT TIME ZONE '${ZONE}') + interval '1 day') AT TIME ZONE '${ZONE}' AS midnight`,
        [dayX]
      )
    ).rows[0]?.midnight;
    assert.ok(midnight instanceof Date);
    const beforeMidnight = at(midnight, -1000);
    const afterMidnight = at(midnight, 1000);
    await sweep(true, at(ten, -5 * DAY));
    await settle(dayX);
    const owedAcross = [
      await newStore(at(dayX, -2 * DAY + MINUTE)),
      await newStore(at(dayX, -2 * DAY + 2 * MINUTE)),
      await newStore(at(dayX, -2 * DAY + 3 * MINUTE)),
    ];
    const countedAcross = await countedOn(dayX);
    assert.ok(
      countedAcross <= CAP - 2,
      `room for the case (${countedAcross} counted)`
    );
    const seededAcross: [SeededOutcome[], Date][] = [
      [
        Array.from({ length: CAP - 2 - countedAcross }, () => "owed"),
        beforeMidnight,
      ],
      [Array.from({ length: 5 }, () => "owed"), afterMidnight],
    ];
    for (const [seededOutcomes, recorded] of seededAcross) {
      for (let index = 0; index < seededOutcomes.length; index += 3) {
        const store = await newStore(at(ten, -20 * DAY));
        await seedNotices(
          owner.pool,
          store,
          seededOutcomes.slice(index, index + 3),
          at(dayX, -HOUR),
          recorded
        );
      }
    }
    assert.equal(await countedOn(beforeMidnight), CAP - 2);
    assert.equal(await countedOn(afterMidnight), 5);
    const acrossReport = await settle(dayX);
    assert.equal(acrossReport.due, 2, "the 5 of the next day are not counted");
    assert.ok(acrossReport.truncated);
    assert.deepEqual(await stepsOf(owedAcross[0] as Store), ["a1:owed"]);
    assert.deepEqual(await stepsOf(owedAcross[1] as Store), ["a1:owed"]);
    assert.deepEqual(await stepsOf(owedAcross[2] as Store), []);
    assert.equal(await countedOn(dayX), CAP);
    assert.equal(await countedOn(afterMidnight), 5);
    const recordedAtDayX = await owner.pool.query<{ recorded_at: Date }>(
      "SELECT recorded_at FROM public.activation_notices WHERE organization_id = ANY($1::text[]) AND skipped_reason IS NULL",
      [owedAcross.slice(0, 2).map((store) => store.organizationId)]
    );
    assert.deepEqual(
      recordedAtDayX.rows.map((row) => row.recorded_at.getTime()),
      [dayX.getTime(), dayX.getTime()],
      "what a sweep records carries the clock of its case"
    );
    await settle(at(dayX, DAY));
    assert.deepEqual(await stepsOf(owedAcross[2] as Store), ["a1:owed"]);
    assert.equal(await countedOn(dayX), CAP, "the day of the cap did not move");
    for (const store of owedAcross) {
      await assertEvents(store, "the notices across midnight");
    }
    tests.push(
      "AC-7b.4: the count of the cap follows the day of the sweep's clock, not the hour the gate runs at: three days ahead, 58 notices recorded one second before midnight of São Paulo and 5 one second after it, a sweep at 10:00 records two of three owed stores (the 5 of the next day are not counted) and the day stays at 60, the sweep of the next morning records the third, and what a sweep records carries the clock of its case"
    );

    // the connection check and the five cases: one that did not run would leave the gate green with less proof
    assert.equal(tests.length, 6, "every case of the gate ran");
    const proven = tests
      .map((test) => test.match(CASE_LABEL)?.[0])
      .filter(Boolean);
    console.log(
      `gate-note: ${tests.length} cases passed (${proven.join(", ")})`
    );
    console.log(
      JSON.stringify(
        {
          branch,
          database: expectedDatabase,
          gate: "activation-sweep",
          status: "passed",
          tests,
        },
        null,
        2
      )
    );
  } finally {
    for (const close of closers.reverse()) {
      await close().catch(() => undefined);
    }
    for (const [login, group] of logins) {
      await owner.pool
        .query(`REVOKE "${group}" FROM "${login}"`)
        .catch(() => undefined);
      await owner.pool
        .query(`DROP ROLE IF EXISTS "${login}"`)
        .catch(() => undefined);
    }
    await owner.pool.end();
  }
}

run().catch((error: unknown) => {
  console.error(
    `Activation sweep PostgreSQL gate failed (${redactedFailure(error)})`
  );
  process.exitCode = 1;
});
