import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createDatabase } from "../src/client";
import { requestDataExport } from "../src/data-export-repository";
import { createOutboxClient, type ProcessingKey } from "../src/outbox-dispatch";
import { createPrivacyMaintenanceClient } from "../src/privacy-maintenance";
import {
  createTenantFixture,
  disposableHostPattern,
  expectSqlState,
  gateBranchPattern,
  journalMigrationCount,
  poolerPattern,
  redactedFailure,
  requiredEnvironment,
  runtimeRole,
  type TenantFixture,
  temporaryRuntimeUrl,
  withTenantAs,
} from "./sales-gate-support";

/**
 * The outbox dispatcher and sweeper on a real PostgreSQL 18 (plan PR110, ADR 0084): the outbox role
 * reaches the events and the processing record only through its functions; a run claims the due events
 * of every organization (and, the sweep, those whose claim ran out), two runs never claim the same
 * event, the mark comes only with the claim's attempts (the fence) and a failed send gives the event back
 * with a delay; an event past the attempts cap is not claimed. The consumer's durable record takes a key
 * once per attempt, refuses an event the outbox does not hold (or holds under another key, organization
 * or type, or has not sent that many times) and expires. On the export side, the consumer takes one
 * export by ID and organization, a failed run waits before it is taken again, and the privacy role sends
 * an export event back to pending only while its export is still owed and may be taken.
 */
const expectedDatabase =
  process.env.POLARIS_GATE_DATABASE ??
  process.env.POLARIS_SALES_GATE_DATABASE ??
  "neondb";

const OUTBOX_FUNCTIONS = [
  "public.claim_outbox_events(integer,integer)",
  "public.mark_outbox_events_dispatched(uuid[],integer[])",
  "public.release_outbox_events(uuid[],integer[],integer[])",
  "public.claim_queue_processing(text,text,text,uuid,integer,integer)",
  "public.complete_queue_processing(text,text,uuid,integer)",
  "public.release_queue_processing(text,text,uuid)",
  "public.expire_queue_processing(integer,integer)",
];
const OTHER_ROLES = [
  "polaris_pr11_runtime",
  "polaris_billing_runtime",
  "polaris_catalog_runtime",
  "polaris_admin_runtime",
  "polaris_privacy_runtime",
];
const LEASE = 960;

async function run() {
  const branch = requiredEnvironment("POLARIS_SALES_GATE_BRANCH");
  assert.match(branch, gateBranchPattern);
  const adminUrl = requiredEnvironment("POLARIS_SALES_GATE_DATABASE_URL");
  const parsedAdminUrl = new URL(adminUrl);
  assert.match(parsedAdminUrl.hostname, disposableHostPattern);
  assert.doesNotMatch(parsedAdminUrl.hostname, poolerPattern);

  const owner = createDatabase(adminUrl, { maxConnections: 2 });
  const logins: [string, string][] = [];
  const tests: string[] = [];
  const closers: (() => Promise<unknown>)[] = [];

  try {
    const server = await owner.pool.query<{
      database_name: string;
      server_version: string;
      server_version_num: string;
    }>(
      "SELECT current_database() AS database_name, current_setting('server_version') AS server_version, current_setting('server_version_num') AS server_version_num"
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
      "disposable direct Neon connection is PostgreSQL 18 with every migration replayed from scratch"
    );

    // other gates share the database: their events and exports must not reach this gate's claims
    await owner.pool.query(
      "UPDATE public.event_outbox SET status = 'dispatched', locked_until = NULL, dispatched_at = now() WHERE status = 'pending'"
    );
    await owner.pool.query(
      "UPDATE public.data_exports SET status = 'failed', error_code = 'gate_cleanup', locked_until = NULL WHERE status IN ('requested', 'running')"
    );

    const login = async (group: string, prefix: string) => {
      const role = `${prefix}_${randomUUID().replaceAll("-", "")}`;
      const password = randomBytes(24).toString("hex");
      await owner.pool.query(
        `CREATE ROLE "${role}" WITH LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`
      );
      await owner.pool.query(`GRANT "${group}" TO "${role}"`);
      logins.push([role, group]);
      return temporaryRuntimeUrl(adminUrl, role, password);
    };
    const tenantUrl = await login(runtimeRole, "polaris_obx_tenant");
    const outboxUrl = await login("polaris_outbox_runtime", "polaris_obx_disp");
    const privacyUrl = await login(
      "polaris_privacy_runtime",
      "polaris_obx_priv"
    );
    const runtime = createDatabase(tenantUrl, { maxConnections: 2 });
    closers.push(() => runtime.pool.end());
    const dispatcher = createOutboxClient(outboxUrl);
    closers.push(() => dispatcher.close());
    const rival = createOutboxClient(outboxUrl);
    closers.push(() => rival.close());
    const privacy = createPrivacyMaintenanceClient(privacyUrl);
    closers.push(() => privacy.close());
    const outboxDirect = createDatabase(outboxUrl, { maxConnections: 1 });
    closers.push(() => outboxDirect.pool.end());
    const privacyDirect = createDatabase(privacyUrl, { maxConnections: 1 });
    closers.push(() => privacyDirect.pool.end());

    const suffix = randomUUID().slice(0, 8);
    const fixture = (label: string) =>
      createTenantFixture(
        owner.pool,
        `obx ${label} ${suffix}`,
        "America/Sao_Paulo",
        "pro"
      );
    const ask = (tenant: TenantFixture) =>
      withTenantAs(
        runtime.db,
        tenant,
        "organization:export",
        (transaction, identity) =>
          requestDataExport(transaction, identity, {
            formats: ["json"],
            requestId: randomUUID(),
          })
      );
    const eventOf = async (exportId: string) => {
      const found = await owner.pool.query<{
        attempts: number;
        available_in: number;
        dispatched: boolean;
        id: string;
        idempotency_key: string;
        locked: boolean;
        organization_id: string;
        status: string;
      }>(
        `SELECT id, organization_id, idempotency_key, status, attempts, locked_until IS NOT NULL AS locked,
                dispatched_at IS NOT NULL AS dispatched,
                round(extract(epoch FROM available_at - now()))::integer AS available_in
           FROM public.event_outbox WHERE event ->> 'exportId' = $1`,
        [exportId]
      );
      const [row] = found.rows;
      assert.ok(row, "the export has its event");
      return row;
    };
    // an event the outbox holds, written as the owner (past the tenant policy) for the dispatch probes
    const syntheticEvent = async (organizationId: string) => {
      const exportId = randomUUID();
      const inserted = await owner.pool.query<{ id: string }>(
        `INSERT INTO public.event_outbox (organization_id, type, event, idempotency_key, correlation_id)
         VALUES ($1, 'data_export.requested', $2::jsonb, $3, $4) RETURNING id`,
        [
          organizationId,
          JSON.stringify({ exportId }),
          `data_export.requested:${exportId}`,
          randomUUID(),
        ]
      );
      const id = inserted.rows[0]?.id;
      assert.ok(id);
      return id;
    };

    const orgA = await fixture("A");
    const orgB = await fixture("B");

    // ------------------------------------------------- 1. who reaches what
    const permission = async (text: string, values: unknown[]) =>
      Boolean(
        (await owner.pool.query<{ allowed: boolean }>(text, values)).rows[0]
          ?.allowed
      );
    for (const table of ["event_outbox", "queue_processing", "data_exports"]) {
      assert.equal(
        // biome-ignore lint/performance/noAwaitInLoops: one table at a time, for a clear failure.
        await permission(
          "SELECT has_any_column_privilege($1, $2::regclass, 'SELECT,INSERT,UPDATE,REFERENCES') OR has_table_privilege($1, $2::regclass, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS allowed",
          ["polaris_outbox_runtime", `public.${table}`]
        ),
        false,
        `the outbox runtime reaches ${table} only through functions`
      );
    }
    for (const role of [...OTHER_ROLES, "polaris_privacy_owner"]) {
      assert.equal(
        // biome-ignore lint/performance/noAwaitInLoops: one role at a time, for a clear failure.
        await permission(
          "SELECT has_any_column_privilege($1, 'public.queue_processing'::regclass, 'SELECT,INSERT,UPDATE,REFERENCES') OR has_table_privilege($1, 'public.queue_processing'::regclass, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS allowed",
          [role]
        ),
        false,
        `${role} does not reach the processing record`
      );
    }
    // the purge owner reads and deletes the rows of an organization being purged, and nothing else (ADR 0081)
    for (const [privilege, allowed] of [
      ["SELECT", true],
      ["DELETE", true],
      ["INSERT", false],
      ["UPDATE", false],
      ["TRUNCATE", false],
    ] as const) {
      assert.equal(
        // biome-ignore lint/performance/noAwaitInLoops: one privilege at a time, for a clear failure.
        await permission(
          "SELECT has_table_privilege('polaris_purge_owner', 'public.queue_processing'::regclass, $1) AS allowed",
          [privilege]
        ),
        allowed,
        `the purge owner ${allowed ? "has" : "lacks"} ${privilege} on the processing record`
      );
    }
    for (const signature of OUTBOX_FUNCTIONS) {
      for (const role of ["polaris_outbox_runtime", ...OTHER_ROLES]) {
        assert.equal(
          // biome-ignore lint/performance/noAwaitInLoops: privilege probes, in order.
          await permission(
            "SELECT has_function_privilege($1, $2, 'EXECUTE') AS allowed",
            [role, signature]
          ),
          role === "polaris_outbox_runtime",
          `${role} on ${signature}`
        );
      }
      assert.equal(
        await permission(
          "SELECT coalesce(bool_or(acl.grantee = 0), false) AS allowed FROM pg_proc p, LATERAL aclexplode(p.proacl) acl WHERE p.oid = $1::regprocedure",
          [signature]
        ),
        false,
        `PUBLIC does not execute ${signature}`
      );
      assert.equal(
        await permission(
          "SELECT p.prosecdef AND pg_get_userbyid(p.proowner) = 'polaris_outbox_owner' AS allowed FROM pg_proc p WHERE p.oid = $1::regprocedure",
          [signature]
        ),
        true,
        `${signature} runs as the outbox owner`
      );
    }
    const roles = await owner.pool.query<{
      rolbypassrls: boolean;
      rolcanlogin: boolean;
      rolname: string;
      rolsuper: boolean;
    }>(
      "SELECT rolname, rolcanlogin, rolsuper, rolbypassrls FROM pg_roles WHERE rolname IN ('polaris_outbox_owner', 'polaris_outbox_runtime') ORDER BY rolname"
    );
    assert.deepEqual(
      roles.rows.map((row) => [
        row.rolname,
        row.rolcanlogin,
        row.rolsuper,
        row.rolbypassrls,
      ]),
      [
        ["polaris_outbox_owner", false, false, false],
        ["polaris_outbox_runtime", false, false, false],
      ],
      "both outbox roles are group roles that never log in and never pass row level security"
    );
    const updatable = await owner.pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'event_outbox'
          AND has_column_privilege('polaris_outbox_owner', 'public.event_outbox', column_name, 'UPDATE')
        ORDER BY column_name`
    );
    assert.deepEqual(
      updatable.rows.map((row) => row.column_name),
      ["attempts", "available_at", "dispatched_at", "locked_until", "status"],
      "the outbox owner moves only the delivery state, never the body, the key, the type or the organization"
    );
    const rearmable = await owner.pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'event_outbox'
          AND has_column_privilege('polaris_privacy_owner', 'public.event_outbox', column_name, 'UPDATE')
        ORDER BY column_name`
    );
    assert.deepEqual(
      rearmable.rows.map((row) => row.column_name),
      ["available_at", "status"],
      "the privacy owner only sends an event back to pending"
    );
    const forced = await owner.pool.query<{ relforcerowsecurity: boolean }>(
      "SELECT relforcerowsecurity FROM pg_class WHERE oid = 'public.queue_processing'::regclass"
    );
    assert.equal(forced.rows[0]?.relforcerowsecurity, true);
    await expectSqlState(
      () => outboxDirect.pool.query("SELECT 1 FROM public.event_outbox"),
      "42501",
      "the outbox runtime cannot read the events directly"
    );
    await expectSqlState(
      () => outboxDirect.pool.query("SELECT 1 FROM public.queue_processing"),
      "42501",
      "the outbox runtime cannot read the processing record directly"
    );
    await expectSqlState(
      () => privacyDirect.pool.query("SELECT 1 FROM public.event_outbox"),
      "42501",
      "the privacy runtime cannot read the events directly"
    );
    tests.push(
      "the outbox runtime has no privilege on event_outbox, queue_processing or data_exports and executes only its seven SECURITY DEFINER functions, owned by polaris_outbox_owner (no other runtime, nor PUBLIC, executes them); both outbox roles never log in nor pass RLS; the outbox owner updates only the delivery columns, the privacy owner only status and available_at; queue_processing forces RLS and no other role reaches it but the purge owner, which only reads and deletes (ADR 0081)"
    );

    // ------------------------------------------------- 2. claim, send, mark: the fence and the delay
    const exportA = await ask(orgA);
    const exportB = await ask(orgB);
    const firstClaim = await dispatcher.claimOutboxEvents(25, LEASE);
    const claimedIds = firstClaim.map((row) => row.id).sort();
    const eventA = await eventOf(exportA.id);
    const eventB = await eventOf(exportB.id);
    assert.deepEqual(claimedIds, [eventA.id, eventB.id].sort());
    const claimedA = firstClaim.find((row) => row.id === eventA.id);
    assert.ok(claimedA);
    assert.deepEqual(
      {
        attempts: claimedA.attempts,
        event: claimedA.event,
        idempotencyKey: claimedA.idempotencyKey,
        organizationId: claimedA.organizationId,
        recovered: claimedA.recovered,
        type: claimedA.type,
      },
      {
        attempts: 1,
        event: { exportId: exportA.id },
        idempotencyKey: `data_export.requested:${exportA.id}`,
        organizationId: orgA.organizationId,
        recovered: false,
        type: "data_export.requested",
      }
    );
    assert.ok(claimedA.correlationId.length > 0);
    assert.equal((await eventOf(exportA.id)).locked, true);
    assert.deepEqual(
      await rival.claimOutboxEvents(25, LEASE),
      [],
      "an event held by a run is not claimed by another"
    );
    assert.equal(
      await dispatcher.markOutboxEventsDispatched([
        { attempts: 2, id: eventA.id },
      ]),
      0,
      "a mark with other attempts than the claim's marks nothing"
    );
    assert.equal(
      await dispatcher.markOutboxEventsDispatched([
        { attempts: 1, id: eventA.id },
      ]),
      1
    );
    const markedA = await eventOf(exportA.id);
    assert.equal(markedA.status, "dispatched");
    assert.equal(markedA.dispatched, true);
    assert.equal(markedA.locked, false);
    assert.equal(
      await dispatcher.markOutboxEventsDispatched([
        { attempts: 1, id: eventA.id },
      ]),
      0,
      "a dispatched event is not marked twice"
    );
    assert.equal(
      await dispatcher.releaseOutboxEvents([
        { attempts: 1, delaySeconds: 120, id: eventB.id },
      ]),
      1
    );
    const releasedB = await eventOf(exportB.id);
    assert.equal(releasedB.status, "pending");
    assert.equal(releasedB.locked, false);
    assert.equal(releasedB.attempts, 1);
    assert.ok(
      releasedB.available_in >= 110 && releasedB.available_in <= 120,
      "a failed send is due again after its delay"
    );
    assert.deepEqual(
      await dispatcher.claimOutboxEvents(25, LEASE),
      [],
      "an event in its delay is not claimed"
    );
    await owner.pool.query(
      "UPDATE public.event_outbox SET available_at = now() - interval '1 second' WHERE id = $1",
      [eventB.id]
    );
    const again = await dispatcher.claimOutboxEvents(25, LEASE);
    assert.deepEqual(
      again.map((row) => [row.id, row.attempts, row.recovered]),
      [[eventB.id, 2, false]],
      "each claim counts an attempt"
    );
    tests.push(
      "a run claims the due pending events of every organization with their body, key, organization, type and correlation, counting an attempt; a held event is not claimed by another run; the mark needs the claim's attempts (the fence), sets dispatched_at and frees the claim, and does not mark twice; a failed send gives the event back due after its delay, and it is not claimed before"
    );

    // ------------------------------------------------- 3. the sweep: a claim that outlived its run
    await owner.pool.query(
      "UPDATE public.event_outbox SET locked_until = now() - interval '1 second' WHERE id = $1",
      [eventB.id]
    );
    const swept = await rival.claimOutboxEvents(25, LEASE);
    assert.deepEqual(
      swept.map((row) => [row.id, row.attempts, row.recovered]),
      [[eventB.id, 3, true]],
      "a claim whose lease ran out is taken again, and says so (it may have been sent)"
    );
    assert.equal(
      await dispatcher.markOutboxEventsDispatched([
        { attempts: 2, id: eventB.id },
      ]),
      0,
      "the run that lost its claim marks nothing"
    );
    assert.equal(
      await dispatcher.releaseOutboxEvents([
        { attempts: 2, delaySeconds: 0, id: eventB.id },
      ]),
      0,
      "nor gives it back"
    );
    assert.equal(
      await rival.markOutboxEventsDispatched([{ attempts: 3, id: eventB.id }]),
      1
    );
    // two runs at the same time never claim the same event
    const many = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        syntheticEvent(
          index % 2 === 0 ? orgA.organizationId : orgB.organizationId
        )
      )
    );
    const [left, right] = await Promise.all([
      dispatcher.claimOutboxEvents(4, LEASE),
      rival.claimOutboxEvents(4, LEASE),
    ]);
    const together = [...left, ...right].map((row) => row.id);
    assert.equal(new Set(together).size, together.length);
    assert.deepEqual([...together].sort(), [...many].sort());
    await owner.pool.query(
      "UPDATE public.event_outbox SET status = 'dispatched', locked_until = NULL WHERE id = ANY($1::uuid[])",
      [many]
    );
    // past the cap the event waits for the dead-letter handling
    const parked = await syntheticEvent(orgA.organizationId);
    await owner.pool.query(
      "UPDATE public.event_outbox SET attempts = 1000 WHERE id = $1",
      [parked]
    );
    assert.deepEqual(
      await dispatcher.claimOutboxEvents(25, LEASE),
      [],
      "an event that used its attempts is not claimed"
    );
    await owner.pool.query(
      "UPDATE public.event_outbox SET status = 'dispatched' WHERE id = $1",
      [parked]
    );
    await expectSqlState(
      () => dispatcher.claimOutboxEvents(0, LEASE),
      "22023",
      "the batch is bounded"
    );
    await expectSqlState(
      () => dispatcher.claimOutboxEvents(101, LEASE),
      "22023",
      "the batch is bounded above"
    );
    await expectSqlState(
      () => dispatcher.claimOutboxEvents(25, 30),
      "22023",
      "the lease is bounded"
    );
    await expectSqlState(
      () =>
        outboxDirect.pool.query(
          "SELECT public.mark_outbox_events_dispatched($1::uuid[], $2::integer[])",
          [[eventA.id], [1, 2]]
        ),
      "22023",
      "ids and attempts go in pairs"
    );
    await expectSqlState(
      () =>
        dispatcher.releaseOutboxEvents([
          { attempts: 1, delaySeconds: -1, id: eventA.id },
        ]),
      "22023",
      "a delay is not negative"
    );
    tests.push(
      "the sweep: an event whose claim ran out is claimed again by the next run, flagged as recovered, and the run that lost it neither marks nor releases it; two concurrent runs claim disjoint events (SKIP LOCKED) and together all the due ones; an event at 1000 attempts is no longer claimed; batch, lease, pairs and delay are bounded"
    );

    // ------------------------------------------------- 4. the consumer's durable processing record
    const keyA: ProcessingKey = {
      attempt: 1,
      eventId: eventA.id,
      idempotencyKey: `data_export.requested:${exportA.id}`,
      organizationId: orgA.organizationId,
      type: "data_export.requested",
    };
    const first = await dispatcher.claimProcessing(keyA, LEASE);
    assert.equal(first.result, "claimed");
    assert.equal((await rival.claimProcessing(keyA, LEASE)).result, "busy");
    await rival.releaseProcessing(keyA, randomUUID());
    assert.equal(
      (await rival.claimProcessing(keyA, LEASE)).result,
      "busy",
      "only the holder gives a claim back"
    );
    assert.ok(first.result === "claimed");
    await dispatcher.releaseProcessing(keyA, first.token);
    const retaken = await rival.claimProcessing(keyA, LEASE);
    assert.equal(retaken.result, "claimed");
    // a consumer that died: its lease runs out and another takes the key; the late one frees nothing
    await owner.pool.query(
      "UPDATE public.queue_processing SET lease_until = now() - interval '1 second' WHERE organization_id = $1 AND idempotency_key = $2",
      [keyA.organizationId, keyA.idempotencyKey]
    );
    const takenOver = await dispatcher.claimProcessing(keyA, LEASE);
    assert.equal(takenOver.result, "claimed");
    assert.ok(retaken.result === "claimed");
    await rival.releaseProcessing(keyA, retaken.token);
    assert.equal((await rival.claimProcessing(keyA, LEASE)).result, "busy");
    await dispatcher.completeProcessing(keyA);
    assert.equal(
      (await rival.claimProcessing(keyA, LEASE)).result,
      "done",
      "a duplicate of an attempt already done does nothing"
    );
    const lease = await owner.pool.query<{ seconds: number }>(
      "SELECT state, round(extract(epoch FROM coalesce(lease_until, now()) - now()))::integer AS seconds FROM public.queue_processing WHERE organization_id = $1 AND idempotency_key = $2",
      [keyA.organizationId, keyA.idempotencyKey]
    );
    assert.equal(lease.rows[0]?.seconds, 0, "a done record holds no lease");
    for (const [label, wrong] of [
      ["another event ID", { ...keyA, eventId: randomUUID() }],
      [
        "another organization",
        { ...keyA, organizationId: orgB.organizationId },
      ],
      [
        "another key",
        { ...keyA, idempotencyKey: `data_export.requested:${randomUUID()}` },
      ],
      ["another type", { ...keyA, type: "data_export.ready" }],
      ["an attempt the dispatcher never made", { ...keyA, attempt: 2 }],
      [
        "an event of another organization's key",
        { ...keyA, eventId: eventB.id },
      ],
    ] as const) {
      // biome-ignore lint/performance/noAwaitInLoops: refusals, in order.
      const refused = await dispatcher.claimProcessing(wrong, LEASE);
      assert.deepEqual(
        refused,
        { reason: "event_not_held", result: "unknown" },
        `the record refuses ${label}, and says why`
      );
    }
    // the record of a key vanishes between the insert and the lock (a release or the expiry at the same
    // time): the take starts again and gets the key, instead of answering "unknown" for an event it holds
    const racing = await syntheticEvent(orgA.organizationId);
    await owner.pool.query(
      "UPDATE public.event_outbox SET attempts = 1 WHERE id = $1",
      [racing]
    );
    const racingKey: ProcessingKey = {
      attempt: 1,
      eventId: racing,
      idempotencyKey: (
        await owner.pool.query<{ idempotency_key: string }>(
          "SELECT idempotency_key FROM public.event_outbox WHERE id = $1",
          [racing]
        )
      ).rows[0]?.idempotency_key as string,
      organizationId: orgA.organizationId,
      type: "data_export.requested",
    };
    assert.ok(racingKey.idempotencyKey);
    const outboxLogin = decodeURIComponent(new URL(outboxUrl).username);
    const waitsOnALock = async () => {
      for (let tries = 0; tries < 200; tries += 1) {
        // biome-ignore lint/performance/noAwaitInLoops: polling until the claim waits.
        const waiting = await owner.pool.query(
          "SELECT 1 FROM pg_stat_activity WHERE usename = $1 AND wait_event_type = 'Lock'",
          [outboxLogin]
        );
        if (waiting.rowCount) {
          return;
        }
        // biome-ignore lint/performance/noAwaitInLoops: polling until the claim waits.
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.fail("the claim never waited for the lock of the record");
    };
    // the record is removed by a raw DELETE under a lock the claim waits for, which is what a release or the
    // expiry does to it at the wrong moment: the claimed and the done record, each
    const vanish =
      "DELETE FROM public.queue_processing WHERE organization_id = $1 AND idempotency_key = $2";
    for (const label of ["a claimed record", "a done record"]) {
      // biome-ignore lint/performance/noAwaitInLoops: one race at a time.
      const taken = await dispatcher.claimProcessing(racingKey, LEASE);
      assert.equal(taken.result, "claimed");
      if (label === "a done record") {
        // what the expiry removes
        await dispatcher.completeProcessing(racingKey);
      }
      const holder = await owner.pool.connect();
      try {
        await holder.query("BEGIN");
        await holder.query(
          "SELECT 1 FROM public.queue_processing WHERE organization_id = $1 AND idempotency_key = $2 FOR UPDATE",
          [racingKey.organizationId, racingKey.idempotencyKey]
        );
        // the insert finds the record and skips; the lock then waits behind the holder
        const racer = rival.claimProcessing(racingKey, LEASE);
        racer.catch(() => undefined);
        await waitsOnALock();
        await holder.query(vanish, [
          racingKey.organizationId,
          racingKey.idempotencyKey,
        ]);
        await holder.query("COMMIT");
        assert.equal(
          (await racer).result,
          "claimed",
          `${label} that vanishes before the lock is taken again, not refused as unknown`
        );
      } finally {
        // a failed assertion must not return a connection that still holds the lock
        await holder.query("ROLLBACK").catch(() => undefined);
        holder.release();
      }
      await owner.pool.query(vanish, [
        racingKey.organizationId,
        racingKey.idempotencyKey,
      ]);
    }
    // the key is held under another event ID while the outbox holds this event with that key (the record
    // was written for an event the outbox has since replaced): refused, and the reason says so
    await owner.pool.query(
      "INSERT INTO public.queue_processing (organization_id, idempotency_key, event_id, attempt, state, token, lease_until) VALUES ($1, $2, $3, 1, 'claimed', $4, now() + interval '1 hour')",
      [
        racingKey.organizationId,
        racingKey.idempotencyKey,
        randomUUID(),
        randomUUID(),
      ]
    );
    assert.deepEqual(
      await dispatcher.claimProcessing(racingKey, LEASE),
      { reason: "key_of_another_event", result: "unknown" },
      "a key held under another event is refused, with its reason"
    );
    await owner.pool.query(
      "DELETE FROM public.queue_processing WHERE organization_id = $1 AND idempotency_key = $2",
      [racingKey.organizationId, racingKey.idempotencyKey]
    );
    await expectSqlState(
      () => dispatcher.claimProcessing({ ...keyA, attempt: 0 }, LEASE),
      "22023",
      "the attempt is bounded"
    );
    await expectSqlState(
      () => dispatcher.claimProcessing(keyA, 30),
      "22023",
      "the lease is bounded"
    );
    tests.push(
      "the durable record takes a key once (busy for another consumer), gives it back only to the holder's token, lets another take it when the lease runs out (the late holder frees nothing) and says done for a duplicate of a done attempt; it refuses an event ID, organization, key or type the outbox does not hold together, and an attempt the dispatcher has not made, saying why; a record that vanishes between the insert and the lock (a release, the expiry) is taken again instead of refused as unknown"
    );

    // ------------------------------------------------- 5. the export side: by ID, the delay, the re-arm
    assert.equal(
      await privacy.claimDataExportById(exportA.id, orgB.organizationId, LEASE),
      null,
      "an export is taken only with its own organization"
    );
    const byId = await privacy.claimDataExportById(
      exportA.id,
      orgA.organizationId,
      LEASE
    );
    assert.ok(byId);
    assert.equal(byId.id, exportA.id);
    assert.equal(byId.attempt, 1);
    assert.equal(
      await privacy.claimDataExportById(exportA.id, orgA.organizationId, LEASE),
      null,
      "a running export is not taken twice"
    );
    assert.equal(
      await privacy.failDataExport(exportA.id, "export_failed", false),
      false
    );
    const delay = await owner.pool.query<{ minutes: number; status: string }>(
      "SELECT status, round(extract(epoch FROM locked_until - now()) / 60)::integer AS minutes FROM public.data_exports WHERE id = $1",
      [exportA.id]
    );
    assert.deepEqual(delay.rows[0], { minutes: 15, status: "requested" });
    assert.equal(
      await privacy.claimDataExportById(exportA.id, orgA.organizationId, LEASE),
      null,
      "a failed run waits before it is taken again, however many messages ask"
    );
    // the event was dispatched just now: too early to send it again
    assert.equal(await privacy.rearmDataExportEvents(1800, 100), 0);
    await owner.pool.query(
      "UPDATE public.event_outbox SET dispatched_at = now() - interval '1 hour' WHERE id = ANY($1::uuid[])",
      [[eventA.id, eventB.id]]
    );
    assert.equal(
      await privacy.rearmDataExportEvents(1800, 100),
      1,
      "only B: A waits for its delay"
    );
    assert.equal((await eventOf(exportB.id)).status, "pending");
    assert.equal((await eventOf(exportA.id)).status, "dispatched");
    await owner.pool.query(
      "UPDATE public.data_exports SET locked_until = now() - interval '1 second' WHERE id = $1",
      [exportA.id]
    );
    assert.equal(await privacy.rearmDataExportEvents(1800, 100), 1);
    const rearmedA = await eventOf(exportA.id);
    assert.equal(rearmedA.status, "pending");
    assert.ok(rearmedA.available_in <= 0, "due at once");
    assert.equal(rearmedA.attempts, 1, "the re-arm counts no attempt");
    // the dispatcher sends it again as a new attempt, which the record runs again
    const resent = await dispatcher.claimOutboxEvents(25, LEASE);
    const resentA = resent.find((row) => row.id === eventA.id);
    assert.ok(resentA);
    assert.equal(resentA.attempts, 2);
    await dispatcher.markOutboxEventsDispatched(
      resent.map((row) => ({ attempts: row.attempts, id: row.id }))
    );
    // nobody records "done" ahead: a complete without a claim in progress changes nothing
    await rival.completeProcessing({ ...keyA, attempt: 2 });
    assert.equal(
      (await dispatcher.claimProcessing({ ...keyA, attempt: 2 }, LEASE)).result,
      "claimed",
      "a later attempt of a done event runs again"
    );
    // a late consumer of the older attempt does not close the newer claim
    await rival.completeProcessing(keyA);
    assert.equal(
      (await rival.claimProcessing({ ...keyA, attempt: 2 }, LEASE)).result,
      "busy"
    );
    await dispatcher.completeProcessing({ ...keyA, attempt: 2 });
    assert.equal(
      (await dispatcher.claimProcessing(keyA, LEASE)).result,
      "done",
      "an old duplicate stays done"
    );
    // a finished export, or one whose run is alive, is not owed
    const byIdAgain = await privacy.claimDataExportById(
      exportA.id,
      orgA.organizationId,
      LEASE
    );
    assert.ok(byIdAgain);
    await owner.pool.query(
      "UPDATE public.event_outbox SET dispatched_at = now() - interval '1 hour' WHERE id = $1",
      [eventA.id]
    );
    assert.equal(
      await privacy.rearmDataExportEvents(1800, 100),
      0,
      "a running export with its lease alive is not owed"
    );
    await privacy.recordDataExportFile({
      exportId: exportA.id,
      key: `exports/v1/${orgA.organizationId}/${exportA.id}/polaris-dados-2026-10-18.zip`,
      name: "polaris-dados-2026-10-18.zip",
      ordinal: 1,
      sizeBytes: 10,
    });
    await privacy.completeDataExport(exportA.id, 24);
    await owner.pool.query(
      "UPDATE public.data_exports SET locked_until = NULL WHERE id = $1",
      [exportA.id]
    );
    assert.equal(
      await privacy.rearmDataExportEvents(1800, 100),
      0,
      "a ready export is not owed"
    );
    await expectSqlState(
      () => privacy.rearmDataExportEvents(60, 100),
      "22023",
      "the re-arm waits at least fifteen minutes"
    );
    tests.push(
      "the consumer takes the export its event names only with its organization and only once; a non-final failure sends it back to requested with a 15-minute delay (an hour after the second) during which no claim takes it; the re-arm sends a dispatched export event back to pending, due at once and counting no attempt, only after it had time to be delivered and only while its export is owed and may be taken (not in its delay, not running with a live lease, not ready); the dispatcher then sends it as a new attempt, which the processing record runs again while an old duplicate stays done"
    );

    // ------------------------------------------------- 6. the purge removes an event while a run holds it
    const doomed = await syntheticEvent(orgB.organizationId);
    const held = await dispatcher.claimOutboxEvents(25, LEASE);
    const heldDoomed = held.find((row) => row.id === doomed);
    assert.ok(heldDoomed);
    await owner.pool.query("DELETE FROM public.event_outbox WHERE id = $1", [
      doomed,
    ]);
    assert.equal(
      await dispatcher.markOutboxEventsDispatched([
        { attempts: heldDoomed.attempts, id: doomed },
      ]),
      0,
      "the mark of a removed event is no error and marks nothing"
    );
    assert.deepEqual(
      await dispatcher.claimProcessing(
        {
          attempt: heldDoomed.attempts,
          eventId: doomed,
          idempotencyKey: heldDoomed.idempotencyKey,
          organizationId: orgB.organizationId,
          type: "data_export.requested",
        },
        LEASE
      ),
      { reason: "event_not_held", result: "unknown" },
      "a message for a removed event runs nothing"
    );
    await owner.pool.query(
      "UPDATE public.event_outbox SET status = 'dispatched', locked_until = NULL WHERE id = ANY($1::uuid[])",
      [held.map((row) => row.id)]
    );
    tests.push(
      "when the purge removes an event a run holds, the mark marks nothing without failing and a message already sent for it is refused by the processing record"
    );

    // ------------------------------------------------- 7. the processing record expires
    await owner.pool.query(
      "UPDATE public.queue_processing SET updated_at = now() - interval '8 days' WHERE organization_id = $1 AND idempotency_key = $2",
      [keyA.organizationId, keyA.idempotencyKey]
    );
    assert.ok((await dispatcher.expireProcessing(168, 1000)) >= 1);
    const gone = await owner.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM public.queue_processing WHERE organization_id = $1 AND idempotency_key = $2",
      [keyA.organizationId, keyA.idempotencyKey]
    );
    assert.equal(gone.rows[0]?.count, "0");
    await expectSqlState(
      () => dispatcher.expireProcessing(24, 100),
      "22023",
      "a record is kept at least two days"
    );
    tests.push(
      "a done record older than the retention is removed by the expiry, which keeps at least two days"
    );

    console.log(
      JSON.stringify(
        {
          branch,
          database: serverRow.database_name,
          serverVersion: serverRow.server_version,
          status: "passed",
          tests,
        },
        null,
        2
      )
    );
  } finally {
    for (const close of closers.reverse()) {
      // biome-ignore lint/performance/noAwaitInLoops: Cleanups, in order.
      await close().catch(() => undefined);
    }
    for (const [role, group] of logins) {
      // biome-ignore lint/performance/noAwaitInLoops: Cleanups, in order.
      await owner.pool.query(`REVOKE "${group}" FROM "${role}"`);
      await owner.pool.query(`DROP ROLE IF EXISTS "${role}"`);
    }
    await owner.pool.end();
  }
}

run().catch((error: unknown) => {
  console.error(
    `Outbox dispatcher PostgreSQL gate failed (${redactedFailure(error)})`
  );
  process.exitCode = 1;
});
