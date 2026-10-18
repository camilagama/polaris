// biome-ignore-all lint/performance/noAwaitInLoops: a gate runs its probes strictly one at a time, for a clear failure
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { InvalidIncidentRetryError } from "@polaris/domain/admin/operational-incident";
import { Client } from "pg";
import {
  listOperationalIncidents,
  readOperationalIncident,
  retryDeadLetter,
} from "../src/admin-incident-repository";
import { createDatabase } from "../src/client";
import { createOutboxClient, type ProcessingKey } from "../src/outbox-dispatch";
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
  sqlState,
  type TenantFixture,
  temporaryRuntimeUrl,
} from "./sales-gate-support";

/**
 * The dead-letter queue on a real PostgreSQL 18 (plan PR111, ADR 0085): operational incidents (one row
 * per cause, counted) and the dead outbox events the Admin can send again. The outbox role records them
 * only through two functions and reads nothing; the Admin owner alone retries (the retry puts the same
 * outbox event back to pending, starts an event past the attempts cap over and forgets its processing
 * record, and refuses while a run holds it); the Admin role lists, reads and retries only through three
 * functions that check the operator and the reason and write the audit in the retry's transaction; the
 * incident carries a cause, a type and opaque IDs, never a message body; the incidents carry no
 * organization, so the purge of an organization leaves them. Removing an organization's dead events
 * is the purge's own job (its policy and DELETE grant come with the purge PR, which proves it).
 */
const expectedDatabase =
  process.env.POLARIS_GATE_DATABASE ??
  process.env.POLARIS_SALES_GATE_DATABASE ??
  "neondb";

const issuer = "https://polaris-dead-letter-gate.cloudflareaccess.com";
const LEASE = 960;
const FORMAT_START = /\^\[a-z\]/;
const REFERENCE_LENGTH = /\{1,128\}/;
const CAUSE_LISTED = /retries_exhausted/;
const KIND_LISTED = /queue_dead_letter/;
const STATE_LISTED = /dead/;
const CAUSES = [
  "retries_exhausted",
  "invalid_envelope",
  "unknown_type",
  "wrong_queue",
];
const OUTBOX_FUNCTIONS = [
  "public.claim_outbox_events(integer,integer)",
  "public.mark_outbox_events_dispatched(uuid[],integer[])",
  "public.release_outbox_events(uuid[],integer[],integer[])",
  "public.claim_queue_processing(text,text,text,uuid,integer,integer)",
  "public.complete_queue_processing(text,text,uuid,integer)",
  "public.release_queue_processing(text,text,uuid)",
  "public.expire_queue_processing(integer,integer)",
];
const ROLES = [
  "polaris_outbox_runtime",
  "polaris_outbox_owner",
  "polaris_admin_runtime",
  "polaris_admin_owner",
  "polaris_pr11_runtime",
  "polaris_billing_runtime",
  "polaris_catalog_runtime",
  "polaris_privacy_runtime",
  "polaris_privacy_owner",
  "polaris_purge_owner",
];
const OUTBOX_SIDE = ["polaris_outbox_runtime", "polaris_outbox_owner"];
const ADMIN_SIDE = ["polaris_admin_runtime", "polaris_admin_owner"];
const NEW_FUNCTIONS: {
  allowed: string[];
  owner: string;
  signature: string;
}[] = [
  {
    allowed: OUTBOX_SIDE,
    owner: "polaris_outbox_owner",
    signature: "public.record_dead_letter(text,text,text,uuid,text)",
  },
  {
    allowed: OUTBOX_SIDE,
    owner: "polaris_outbox_owner",
    signature: "public.record_exhausted_outbox_events(integer)",
  },
  {
    // only the Admin owner's own function calls it: no runtime does
    allowed: ["polaris_admin_owner", "polaris_outbox_owner"],
    owner: "polaris_outbox_owner",
    signature: "public.retry_dead_letter(uuid)",
  },
  {
    allowed: ADMIN_SIDE,
    owner: "polaris_admin_owner",
    signature: "public.admin_list_operational_incidents(integer,uuid)",
  },
  {
    allowed: ADMIN_SIDE,
    owner: "polaris_admin_owner",
    signature: "public.admin_read_operational_incident(uuid,integer,uuid)",
  },
  {
    allowed: ADMIN_SIDE,
    owner: "polaris_admin_owner",
    signature: "public.admin_retry_dead_letter(uuid,uuid,uuid,text)",
  },
];
const INCIDENT_KEYS = [
  "cause",
  "firstSeenAt",
  "id",
  "kind",
  "lastReference",
  "lastSeenAt",
  "occurrenceCount",
  "subject",
];
const EVENT_KEYS = [
  "eventId",
  "eventType",
  "firstSeenAt",
  "lastSeenAt",
  "occurrences",
  "organizationId",
  "retriedAt",
  "retryCount",
  "state",
];

interface EventOptions {
  attempts?: number;
  lock?: "expired" | "live";
  secondsAgo?: number;
  status?: "dispatched" | "pending";
}

interface ItemRow {
  incident_id: string;
  occurrences: number;
  organization_id: string;
  retried: boolean;
  retry_count: number;
  state: string;
}

interface IncidentRow {
  first_seen_at: Date;
  id: string;
  last_reference: string | null;
  last_seen_at: Date;
  occurrence_count: string;
}

async function expectError(
  operation: () => Promise<unknown>,
  code: string,
  message: string,
  label: string
) {
  await assert.rejects(
    operation,
    (error: unknown) => {
      assert.equal(sqlState(error), code, label);
      assert.equal((error as Error).message, message, `${label} (message)`);
      return true;
    },
    label
  );
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one linear gate script, section by section
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
  const suffix = randomUUID().slice(0, 8);
  const fixtures: TenantFixture[] = [];
  const unknownBefore: string[] = [];
  const cleanupFailures: string[] = [];
  let primaryFailure = false;

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
      "disposable direct connection is PostgreSQL 18 with every migration replayed from scratch"
    );

    // incidents without a subject are shared by cause: remember the ones that exist, remove only ours
    unknownBefore.push(
      ...(
        await owner.pool.query<{ id: string }>(
          "SELECT id FROM public.operational_incidents WHERE subject = 'unknown'"
        )
      ).rows.map((row) => row.id)
    );
    // other gates share the database: their pending events must not reach this gate's runs
    await owner.pool.query(
      "UPDATE public.event_outbox SET status = 'dispatched', locked_until = NULL, dispatched_at = now() WHERE status = 'pending'"
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
    const outboxUrl = await login("polaris_outbox_runtime", "polaris_dlq_obx");
    const adminLoginUrl = await login(
      "polaris_admin_runtime",
      "polaris_dlq_admin"
    );
    const adminOwnerUrl = await login(
      "polaris_admin_owner",
      "polaris_dlq_aowner"
    );
    const tenantUrl = await login(runtimeRole, "polaris_dlq_tenant");
    const dispatcher = createOutboxClient(outboxUrl);
    closers.push(() => dispatcher.close());
    const rival = createOutboxClient(outboxUrl);
    closers.push(() => rival.close());
    const outboxDirect = createDatabase(outboxUrl, { maxConnections: 1 });
    closers.push(() => outboxDirect.pool.end());
    const racers = createDatabase(outboxUrl, { maxConnections: 6 });
    closers.push(() => racers.pool.end());
    const retryDb = createDatabase(adminOwnerUrl, { maxConnections: 2 });
    closers.push(() => retryDb.pool.end());
    const tenantDirect = createDatabase(tenantUrl, { maxConnections: 1 });
    closers.push(() => tenantDirect.pool.end());
    const adminClient = new Client({
      connectionString: adminLoginUrl,
      connectionTimeoutMillis: 5000,
    });
    await adminClient.connect();
    closers.push(() => adminClient.end());

    // ------------------------------------------------- fixtures and readers
    const fixture = async (label: string) => {
      const created = await createTenantFixture(
        owner.pool,
        `dlq ${label} ${suffix}`,
        "America/Sao_Paulo",
        "pro"
      );
      fixtures.push(created);
      return created;
    };
    const principal = async (status = "active") =>
      (
        await owner.pool.query<{ id: string }>(
          "INSERT INTO public.platform_principals (issuer, subject, role, status) VALUES ($1, $2, 'platform_owner', $3) RETURNING id",
          [issuer, `sub-${randomUUID()}`, status]
        )
      ).rows[0]?.id as string;
    const typeName = (label: string) => `gate_dlq.${label}${suffix}`;
    const orgA = await fixture("A");
    const orgB = await fixture("B");
    const orgC = await fixture("C");
    const operator = await principal();
    const disabled = await principal("disabled");
    const bodyMarker = `corpo-secreto-${suffix}`;

    // an event the outbox holds, written as the owner (past the tenant policy)
    const makeEvent = async (
      organizationId: string,
      type: string,
      options: EventOptions = {}
    ) => {
      const status = options.status ?? "pending";
      const inserted = await owner.pool.query<{
        id: string;
        idempotency_key: string;
      }>(
        `INSERT INTO public.event_outbox (organization_id, type, event, idempotency_key, correlation_id, attempts, status, locked_until, available_at, dispatched_at)
         VALUES ($1, $2, $3::jsonb, $4, $5, $6::integer, $7::text,
                 CASE $8::text WHEN 'live' THEN now() + interval '1 hour' WHEN 'expired' THEN now() - interval '1 minute' END,
                 now() - $9::integer * interval '1 second',
                 CASE WHEN $7::text = 'dispatched' THEN now() END)
         RETURNING id, idempotency_key`,
        [
          organizationId,
          type,
          JSON.stringify({ note: bodyMarker }),
          `${type}:${randomUUID()}`,
          randomUUID(),
          options.attempts ?? 0,
          status,
          options.lock ?? null,
          options.secondsAgo ?? 0,
        ]
      );
      const [row] = inserted.rows;
      assert.ok(row);
      return { id: row.id, key: row.idempotency_key, organizationId, type };
    };
    const recordDeadLetter = async (
      cause: string | null,
      subject: string | null,
      reference: string | null,
      eventId: string | null,
      organizationId: string | null,
      pool = outboxDirect.pool
    ) =>
      (
        await pool.query<{ result: { incident: string; tracked: boolean } }>(
          "SELECT public.record_dead_letter($1::text, $2::text, $3::text, $4::uuid, $5::text) AS result",
          [cause, subject, reference, eventId, organizationId]
        )
      ).rows[0]?.result as { incident: string; tracked: boolean };
    const recordExhausted = async (limit: number, pool = outboxDirect.pool) =>
      Number(
        (
          await pool.query<{ recorded: number }>(
            "SELECT public.record_exhausted_outbox_events($1::integer) AS recorded",
            [limit]
          )
        ).rows[0]?.recorded
      );
    const incidentOf = async (kind: string, cause: string, subject: string) =>
      (
        await owner.pool.query<IncidentRow>(
          "SELECT id, occurrence_count::text AS occurrence_count, first_seen_at, last_seen_at, last_reference FROM public.operational_incidents WHERE kind = $1 AND cause = $2 AND subject = $3",
          [kind, cause, subject]
        )
      ).rows[0];
    const countOf = async (text: string, values: unknown[] = []) =>
      Number(
        (await owner.pool.query<{ count: string }>(text, values)).rows[0]?.count
      );
    const itemOf = async (eventId: string) =>
      (
        await owner.pool.query<ItemRow>(
          "SELECT state, occurrences, retry_count, retried_at IS NOT NULL AS retried, incident_id, organization_id FROM public.queue_dead_letters WHERE event_id = $1",
          [eventId]
        )
      ).rows[0];
    const eventOf = async (eventId: string) =>
      (
        await owner.pool.query<{
          attempts: number;
          due: boolean;
          locked: boolean;
          status: string;
        }>(
          "SELECT status, attempts, locked_until IS NOT NULL AS locked, available_at <= now() AS due FROM public.event_outbox WHERE id = $1",
          [eventId]
        )
      ).rows[0];
    const processingOf = async (organizationId: string, key: string) =>
      (
        await owner.pool.query<{
          attempt: number;
          state: string;
          token: string | null;
        }>(
          "SELECT attempt, state, token FROM public.queue_processing WHERE organization_id = $1 AND idempotency_key = $2",
          [organizationId, key]
        )
      ).rows[0];
    const leaseKind: Record<string, string | null> = {
      "claimed-expired": "expired",
      "claimed-live": "live",
      done: null,
    };
    const putProcessing = (
      event: { id: string; key: string; organizationId: string },
      attempt: number,
      state: "claimed-expired" | "claimed-live" | "done"
    ) =>
      owner.pool.query(
        `INSERT INTO public.queue_processing (organization_id, idempotency_key, event_id, attempt, state, token, lease_until)
         VALUES ($1, $2, $3, $4, $5, CASE WHEN $6 THEN gen_random_uuid() END,
                 CASE $7::text WHEN 'live' THEN now() + interval '1 hour' WHEN 'expired' THEN now() - interval '1 minute' END)`,
        [
          event.organizationId,
          event.key,
          event.id,
          attempt,
          state === "done" ? "done" : "claimed",
          state !== "done",
          leaseKind[state],
        ]
      );
    const deadItem = async (
      organizationId: string,
      type: string,
      options: EventOptions = {}
    ) => {
      const event = await makeEvent(organizationId, type, options);
      const recorded = await recordDeadLetter(
        "retries_exhausted",
        type,
        `ref-${event.id}`,
        event.id,
        organizationId
      );
      assert.equal(recorded.tracked, true, "the event becomes a dead item");
      return { ...event, incident: recorded.incident };
    };
    const retry = async (eventId: string, pool = retryDb.pool) =>
      (
        await pool.query<{
          result: { organizationId?: string; result: string };
        }>("SELECT public.retry_dead_letter($1::uuid) AS result", [eventId])
      ).rows[0]?.result as { organizationId?: string; result: string };
    const auditsOf = async (eventId: string) =>
      (
        await owner.pool.query<{
          detail: string;
          entity_id: string;
          entity_type: string;
          event_type: string;
          organization_id: string | null;
          principal_id: string;
          support_case_id: string | null;
        }>(
          "SELECT event_type, entity_type, entity_id, organization_id, support_case_id, principal_id, detail FROM public.platform_audit_events WHERE entity_type = 'queue_dead_letter' AND entity_id = $1 ORDER BY created_at, id",
          [eventId]
        )
      ).rows;
    const quiesce = () =>
      owner.pool.query(
        "UPDATE public.event_outbox SET status = 'dispatched', locked_until = NULL WHERE status = 'pending' AND organization_id = ANY($1::text[])",
        [fixtures.map((tenant) => tenant.organizationId)]
      );
    const pause = (milliseconds: number) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds));
    const adminRetry = (
      incidentId: string,
      eventId: string,
      why: string,
      principalId = operator
    ) => retryDeadLetter(adminClient, principalId, incidentId, eventId, why);

    // ------------------------------------------------- 1. who owns and reaches what
    const permission = async (text: string, values: unknown[]) =>
      Boolean(
        (await owner.pool.query<{ allowed: boolean }>(text, values)).rows[0]
          ?.allowed
      );
    const TABLES = ["operational_incidents", "queue_dead_letters"];
    const tableOwners = await owner.pool.query<{
      relname: string;
      rolname: string;
    }>(
      "SELECT c.relname, pg_get_userbyid(c.relowner) AS rolname FROM pg_class c WHERE c.oid = ANY(ARRAY['public.operational_incidents'::regclass, 'public.queue_dead_letters'::regclass, 'public.event_outbox'::regclass])"
    );
    const ownerOf = (name: string) =>
      tableOwners.rows.find((row) => row.relname === name)?.rolname;
    assert.ok(ownerOf("event_outbox"));
    for (const table of TABLES) {
      assert.equal(
        ownerOf(table),
        ownerOf("event_outbox"),
        `${table} is owned by the migration owner, as the outbox`
      );
      assert.equal(
        (ownerOf(table) ?? "").startsWith("polaris_"),
        false,
        `${table} is not owned by a polaris role`
      );
    }
    for (const signature of [
      ...OUTBOX_FUNCTIONS,
      ...NEW_FUNCTIONS.map((entry) => entry.signature),
    ]) {
      const expectedOwner = NEW_FUNCTIONS.find(
        (entry) => entry.signature === signature
      )?.owner;
      const found = await owner.pool.query<{
        config: string[] | null;
        definer: boolean;
        owner: string;
        public_grant: boolean;
      }>(
        "SELECT p.prosecdef AS definer, pg_get_userbyid(p.proowner) AS owner, p.proconfig AS config, coalesce((SELECT bool_or(acl.grantee = 0) FROM aclexplode(p.proacl) acl), false) AS public_grant FROM pg_proc p WHERE p.oid = $1::regprocedure",
        [signature]
      );
      const [row] = found.rows;
      assert.ok(row, `${signature} exists`);
      assert.equal(row.definer, true, `${signature} is SECURITY DEFINER`);
      assert.equal(
        row.owner,
        expectedOwner ?? "polaris_outbox_owner",
        `${signature} owner`
      );
      assert.ok(
        row.config?.includes("search_path=pg_catalog, public"),
        `${signature} pins its search_path`
      );
      assert.equal(row.public_grant, false, `PUBLIC executes ${signature}`);
    }
    tests.push(
      "owners: the two tables belong to the migration owner like the outbox, never to a polaris role; the three outbox functions (record_dead_letter, record_exhausted_outbox_events, retry_dead_letter) are SECURITY DEFINER with a pinned search_path owned by polaris_outbox_owner and the three Admin functions by polaris_admin_owner; PUBLIC executes none"
    );

    for (const signature of NEW_FUNCTIONS) {
      for (const role of ROLES) {
        assert.equal(
          await permission(
            "SELECT has_function_privilege($1, $2, 'EXECUTE') AS allowed",
            [role, signature.signature]
          ),
          signature.allowed.includes(role),
          `${role} on ${signature.signature}`
        );
      }
    }
    for (const signature of OUTBOX_FUNCTIONS) {
      assert.equal(
        await permission(
          "SELECT has_function_privilege('polaris_outbox_runtime', $1, 'EXECUTE') AS allowed",
          [signature]
        ),
        true,
        `the outbox runtime still executes ${signature}`
      );
    }
    const outboxRuntimeFunctions = await owner.pool.query<{
      proname: string;
    }>(
      `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND has_function_privilege('polaris_outbox_runtime', p.oid, 'EXECUTE')
          AND p.proname NOT LIKE 'gen\\_%' AND p.prokind = 'f'
          AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
        ORDER BY p.proname`
    );
    assert.deepEqual(
      outboxRuntimeFunctions.rows.map((row) => row.proname),
      [
        "claim_outbox_events",
        "claim_queue_processing",
        "claim_scheduled_job",
        "complete_queue_processing",
        "complete_scheduled_job",
        "expire_queue_processing",
        "mark_outbox_events_dispatched",
        "record_dead_letter",
        "record_exhausted_outbox_events",
        "release_outbox_events",
        "release_queue_processing",
        "release_scheduled_job",
      ],
      "the outbox runtime executes exactly its eleven functions (the scheduler's three included), no retry and no admin_*"
    );
    const adminRuntimeFunctions = await owner.pool.query<{ proname: string }>(
      `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname IN ('admin_list_operational_incidents', 'admin_read_operational_incident', 'admin_retry_dead_letter', 'retry_dead_letter', 'record_dead_letter', 'record_exhausted_outbox_events')
          AND has_function_privilege('polaris_admin_runtime', p.oid, 'EXECUTE')
        ORDER BY p.proname`
    );
    assert.deepEqual(
      adminRuntimeFunctions.rows.map((row) => row.proname),
      [
        "admin_list_operational_incidents",
        "admin_read_operational_incident",
        "admin_retry_dead_letter",
      ],
      "the Admin runtime executes the three admin functions and neither the recording nor the bare retry"
    );
    tests.push(
      "execute: polaris_outbox_runtime executes record_dead_letter, record_exhausted_outbox_events and its seven earlier functions and nothing else (not retry_dead_letter, no admin_*); polaris_admin_owner executes retry_dead_letter (the outbox owner owns it) and no runtime does; polaris_admin_runtime executes only the three new admin_* functions; no tenant, billing, catalog or privacy role executes any of the six"
    );

    const readsNoTable = await owner.pool.query<{ relname: string }>(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
          AND (has_any_column_privilege('polaris_admin_runtime', c.oid, 'SELECT,INSERT,UPDATE,REFERENCES')
               OR has_table_privilege('polaris_admin_runtime', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))`
    );
    assert.deepEqual(
      readsNoTable.rows.map((row) => row.relname),
      ["platform_principals"],
      "the Admin runtime reaches no table but the principals (its own, since the principals gate), none of the two new ones"
    );
    for (const table of TABLES) {
      for (const role of ROLES) {
        const expected =
          {
            polaris_admin_owner: ["SELECT"],
            polaris_outbox_owner: ["INSERT", "SELECT", "UPDATE"],
            // the purge deletes the dead events of an organization being purged (ADR 0081)
            ...(table === "queue_dead_letters"
              ? { polaris_purge_owner: ["DELETE", "SELECT"] }
              : {}),
          }[role] ?? [];
        for (const privilege of [
          "SELECT",
          "INSERT",
          "UPDATE",
          "DELETE",
          "TRUNCATE",
          "REFERENCES",
          "TRIGGER",
        ]) {
          assert.equal(
            await permission(
              "SELECT has_table_privilege($1, $2::regclass, $3) OR (($3 IN ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES')) AND has_any_column_privilege($1, $2::regclass, $3)) AS allowed",
              [role, `public.${table}`, privilege]
            ),
            expected.includes(privilege),
            `${role} ${privilege} on ${table}`
          );
        }
      }
      const acl = await owner.pool.query<{
        grantee: string;
        privileges: string[];
      }>(
        "SELECT pg_get_userbyid(acl.grantee) AS grantee, array_agg(acl.privilege_type ORDER BY acl.privilege_type) AS privileges FROM pg_class c, LATERAL aclexplode(c.relacl) acl WHERE c.oid = $1::regclass AND acl.grantee <> c.relowner GROUP BY 1 ORDER BY 1",
        [`public.${table}`]
      );
      assert.deepEqual(
        acl.rows.map((row) => [row.grantee, row.privileges]),
        [
          ["polaris_admin_owner", ["SELECT"]],
          ["polaris_outbox_owner", ["INSERT", "SELECT", "UPDATE"]],
          ...(table === "queue_dead_letters"
            ? [["polaris_purge_owner", ["DELETE", "SELECT"]]]
            : []),
        ],
        `the whole ACL of ${table}: nobody else, DELETE only for the purge (ADR 0081), PUBLIC nothing`
      );
      assert.equal(
        await countOf(
          "SELECT count(*)::text AS count FROM pg_attribute WHERE attrelid = $1::regclass AND attacl IS NOT NULL",
          [`public.${table}`]
        ),
        0,
        `${table} has no column privilege`
      );
      const forced = await owner.pool.query<{
        relforcerowsecurity: boolean;
        relrowsecurity: boolean;
      }>(
        "SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = $1::regclass",
        [`public.${table}`]
      );
      assert.deepEqual(
        forced.rows[0],
        { relforcerowsecurity: true, relrowsecurity: true },
        `${table} enforces RLS, even for its owner`
      );
    }
    tests.push(
      "tables: polaris_outbox_owner has exactly SELECT, INSERT and UPDATE and polaris_admin_owner exactly SELECT on both tables (the whole ACL is those two grants, PUBLIC and the column ACLs are empty); nobody holds DELETE, TRUNCATE, REFERENCES or TRIGGER on either; no outbox runtime, Admin runtime, tenant, billing, catalog or privacy role reaches them; both force RLS; the Admin runtime reaches no table of the schema but platform_principals, which an earlier migration granted"
    );

    for (const table of TABLES) {
      for (const statement of [
        `SELECT 1 FROM public.${table}`,
        `DELETE FROM public.${table}`,
        `UPDATE public.${table} SET last_seen_at = now()`,
      ]) {
        await expectSqlState(
          () => outboxDirect.pool.query(statement),
          "42501",
          `the outbox runtime, logged in, cannot: ${statement}`
        );
        await expectSqlState(
          () => adminClient.query(statement),
          "42501",
          `the Admin runtime, logged in, cannot: ${statement}`
        );
        await expectSqlState(
          () => tenantDirect.pool.query(statement),
          "42501",
          `a tenant runtime, logged in, cannot: ${statement}`
        );
      }
    }
    await expectSqlState(
      () => retryDb.pool.query("DELETE FROM public.queue_dead_letters"),
      "42501",
      "even the Admin owner cannot delete a dead event"
    );
    await expectSqlState(
      () =>
        retryDb.pool.query(
          "UPDATE public.queue_dead_letters SET occurrences = 1"
        ),
      "42501",
      "the Admin owner only reads the tables"
    );
    for (const statement of [
      "SELECT public.retry_dead_letter(gen_random_uuid())",
      "SELECT public.admin_list_operational_incidents(10, NULL)",
      "SELECT public.admin_read_operational_incident(gen_random_uuid(), 10, NULL)",
      "SELECT public.admin_retry_dead_letter(gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'x')",
    ]) {
      await expectSqlState(
        () => outboxDirect.pool.query(statement),
        "42501",
        `the outbox runtime cannot run: ${statement}`
      );
    }
    for (const statement of [
      "SELECT public.retry_dead_letter(gen_random_uuid())",
      "SELECT public.record_dead_letter('retries_exhausted', 'a.b', NULL, NULL, NULL)",
      "SELECT public.record_exhausted_outbox_events(1)",
    ]) {
      await expectSqlState(
        () => adminClient.query(statement),
        "42501",
        `the Admin runtime cannot run: ${statement}`
      );
    }
    for (const statement of [
      "SELECT public.retry_dead_letter(gen_random_uuid())",
      "SELECT public.record_dead_letter('retries_exhausted', 'a.b', NULL, NULL, NULL)",
      "SELECT public.record_exhausted_outbox_events(1)",
      "SELECT public.admin_list_operational_incidents(10, NULL)",
      "SELECT public.admin_retry_dead_letter(gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'x')",
    ]) {
      await expectSqlState(
        () => tenantDirect.pool.query(statement),
        "42501",
        `a tenant runtime cannot run: ${statement}`
      );
    }
    tests.push(
      "logged in: polaris_outbox_runtime, the Admin runtime and a tenant runtime get 42501 on SELECT, UPDATE and DELETE of both tables; the Admin owner cannot delete or update them; the outbox runtime cannot call retry_dead_letter or an admin_*, the Admin runtime cannot call retry_dead_letter or the two recording functions, a tenant runtime none of them"
    );

    // ------------------------------------------------- 8 (first: the shape). No message body in the tables
    const columns = await owner.pool.query<{
      column_name: string;
      data_type: string;
      is_nullable: string;
      table_name: string;
    }>(
      `SELECT table_name, column_name, data_type, is_nullable FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name IN ('operational_incidents', 'queue_dead_letters')
        ORDER BY table_name, column_name`
    );
    assert.deepEqual(
      columns.rows.map((row) => [
        row.table_name,
        row.column_name,
        row.data_type,
        row.is_nullable,
      ]),
      [
        ["operational_incidents", "cause", "text", "NO"],
        [
          "operational_incidents",
          "first_seen_at",
          "timestamp with time zone",
          "NO",
        ],
        ["operational_incidents", "id", "uuid", "NO"],
        ["operational_incidents", "kind", "text", "NO"],
        ["operational_incidents", "last_reference", "text", "YES"],
        [
          "operational_incidents",
          "last_seen_at",
          "timestamp with time zone",
          "NO",
        ],
        ["operational_incidents", "occurrence_count", "bigint", "NO"],
        ["operational_incidents", "subject", "text", "NO"],
        ["queue_dead_letters", "event_id", "uuid", "NO"],
        ["queue_dead_letters", "event_type", "text", "NO"],
        [
          "queue_dead_letters",
          "first_seen_at",
          "timestamp with time zone",
          "NO",
        ],
        ["queue_dead_letters", "incident_id", "uuid", "NO"],
        [
          "queue_dead_letters",
          "last_seen_at",
          "timestamp with time zone",
          "NO",
        ],
        ["queue_dead_letters", "occurrences", "integer", "NO"],
        ["queue_dead_letters", "organization_id", "text", "NO"],
        ["queue_dead_letters", "retried_at", "timestamp with time zone", "YES"],
        ["queue_dead_letters", "retry_count", "integer", "NO"],
        ["queue_dead_letters", "state", "text", "NO"],
      ],
      "the two tables have exactly the expected columns"
    );
    assert.equal(
      columns.rows.some((row) =>
        ["json", "jsonb", "bytea", "xml", "ARRAY"].includes(row.data_type)
      ),
      false,
      "no json, bytea or array column"
    );
    // every free text column is held by a format CHECK
    const checks = await owner.pool.query<{ definition: string; name: string }>(
      `SELECT con.conname AS name, pg_get_constraintdef(con.oid) AS definition FROM pg_constraint con
        WHERE con.conrelid IN ('public.operational_incidents'::regclass, 'public.queue_dead_letters'::regclass) AND con.contype = 'c'`
    );
    const definitionOf = (name: string) =>
      checks.rows.find((row) => row.name === name)?.definition ?? "";
    assert.match(
      definitionOf("operational_incidents_subject_format"),
      FORMAT_START
    );
    assert.match(
      definitionOf("operational_incidents_reference_format"),
      REFERENCE_LENGTH
    );
    assert.match(
      definitionOf("queue_dead_letters_event_type_format"),
      FORMAT_START
    );
    assert.match(
      definitionOf("operational_incidents_cause_allowed"),
      CAUSE_LISTED
    );
    assert.match(
      definitionOf("operational_incidents_kind_allowed"),
      KIND_LISTED
    );
    assert.match(
      definitionOf("queue_dead_letters_state_allowed"),
      STATE_LISTED
    );
    const holdingIncident = randomUUID();
    const badIncidentRows: [string, string, string | null, string, string][] = [
      [
        "a subject with a space",
        "gate_dlq.has space",
        null,
        "operational_incidents_subject_format",
        "retries_exhausted",
      ],
      [
        "a subject with a line break",
        "gate_dlq.line\nbreak",
        null,
        "operational_incidents_subject_format",
        "retries_exhausted",
      ],
      [
        "a subject with one segment",
        "nodot",
        null,
        "operational_incidents_subject_format",
        "retries_exhausted",
      ],
      [
        "a long text as the subject",
        `gate_dlq.${"a".repeat(200)}`,
        null,
        "operational_incidents_subject_format",
        "retries_exhausted",
      ],
      [
        "a subject of 81 characters",
        `a.${"b".repeat(79)}`,
        null,
        "operational_incidents_subject_format",
        "retries_exhausted",
      ],
      [
        "a reference with a space",
        `gate_dlq.ok${suffix}`,
        "has space",
        "operational_incidents_reference_format",
        "retries_exhausted",
      ],
      [
        "a reference with a line break",
        `gate_dlq.ok${suffix}`,
        "line\nbreak",
        "operational_incidents_reference_format",
        "retries_exhausted",
      ],
      [
        "a reference of 129 characters",
        `gate_dlq.ok${suffix}`,
        "a".repeat(129),
        "operational_incidents_reference_format",
        "retries_exhausted",
      ],
      [
        "an empty reference",
        `gate_dlq.ok${suffix}`,
        "",
        "operational_incidents_reference_format",
        "retries_exhausted",
      ],
      [
        "a free text as the cause",
        `gate_dlq.ok${suffix}`,
        null,
        "operational_incidents_cause_allowed",
        "the message said hello",
      ],
    ];
    for (const [
      label,
      subject,
      reference,
      constraint,
      cause,
    ] of badIncidentRows) {
      await expectSqlState(
        () =>
          owner.pool.query(
            "INSERT INTO public.operational_incidents (kind, cause, subject, last_reference) VALUES ('queue_dead_letter', $1, $2, $3)",
            [cause, subject, reference]
          ),
        "23514",
        `even the owner cannot keep ${label}`,
        constraint
      );
    }
    await expectSqlState(
      () =>
        owner.pool.query(
          "INSERT INTO public.operational_incidents (kind, cause, subject) VALUES ('outbox_attempts_exhausted', 'retries_exhausted', 'a.b')"
        ),
      "23514",
      "a cause of the other kind is refused",
      "operational_incidents_cause_allowed"
    );
    await expectSqlState(
      () =>
        owner.pool.query(
          "INSERT INTO public.operational_incidents (kind, cause, subject) VALUES ('anything', 'retries_exhausted', 'a.b')"
        ),
      "23514",
      "an unknown kind is refused"
    );
    const hostIncident = await recordDeadLetter(
      "wrong_queue",
      typeName("shape"),
      "shape-ref",
      null,
      null
    );
    for (const [label, type, constraint] of [
      [
        "an event type with a space",
        "gate_dlq.has space",
        "queue_dead_letters_event_type_format",
      ],
      [
        "an event type with a line break",
        "gate_dlq.a\nb",
        "queue_dead_letters_event_type_format",
      ],
      [
        "a long text as the event type",
        `gate_dlq.${"a".repeat(200)}`,
        "queue_dead_letters_event_type_format",
      ],
    ] as const) {
      await expectSqlState(
        () =>
          owner.pool.query(
            "INSERT INTO public.queue_dead_letters (event_id, organization_id, event_type, incident_id) VALUES ($1, $2, $3, $4)",
            [randomUUID(), orgA.organizationId, type, hostIncident.incident]
          ),
        "23514",
        `even the owner cannot keep ${label}`,
        constraint
      );
    }
    for (const [label, state, retriedAt, retryCount, constraint] of [
      [
        "a free state",
        "free text",
        null,
        0,
        "queue_dead_letters_state_allowed",
      ],
      [
        "a retried item without its date",
        "retried",
        null,
        1,
        "queue_dead_letters_state_coherent",
      ],
      [
        "a retried item with no retry counted",
        "retried",
        new Date().toISOString(),
        0,
        "queue_dead_letters_state_coherent",
      ],
    ] as const) {
      await expectSqlState(
        () =>
          owner.pool.query(
            "INSERT INTO public.queue_dead_letters (event_id, organization_id, event_type, incident_id, state, retried_at, retry_count) VALUES ($1, $2, $3, $4, $5, $6, $7)",
            [
              randomUUID(),
              orgA.organizationId,
              typeName("shape"),
              hostIncident.incident,
              state,
              retriedAt,
              retryCount,
            ]
          ),
        "23514",
        `even the owner cannot keep ${label}`,
        constraint
      );
    }
    await expectSqlState(
      () =>
        owner.pool.query(
          "INSERT INTO public.queue_dead_letters (event_id, organization_id, event_type, incident_id) VALUES ($1, $2, $3, $4)",
          [
            randomUUID(),
            orgA.organizationId,
            typeName("shape"),
            holdingIncident,
          ]
        ),
      "23503",
      "a dead event needs a real incident"
    );
    await expectSqlState(
      () =>
        owner.pool.query(
          "INSERT INTO public.queue_dead_letters (event_id, organization_id, event_type, incident_id) VALUES ($1, $2, $3, $4)",
          [randomUUID(), randomUUID(), typeName("shape"), hostIncident.incident]
        ),
      "23503",
      "a dead event needs a real organization"
    );
    tests.push(
      "shape: the two tables have exactly the expected columns and types (no jsonb, json, bytea or array column; the free text ones are cause, kind, subject, last_reference, event_type and state); as the owner, past every role, a subject or event type with a space, a line break, a single segment, 200 characters or 81 characters, a reference with a space, a line break, 129 characters or empty, a free text cause or kind, a state outside dead/retried, and an incoherent retried item are all refused by their named CHECK; a dead event needs a real incident and organization"
    );

    // ------------------------------------------------- 2. record_dead_letter
    const subject1 = typeName("one");
    const incidentsBefore = await countOf(
      "SELECT count(*)::text AS count FROM public.operational_incidents"
    );
    const first = await recordDeadLetter(
      "retries_exhausted",
      subject1,
      "ref-1",
      null,
      null
    );
    assert.equal(first.tracked, false);
    const afterFirst = await incidentOf(
      "queue_dead_letter",
      "retries_exhausted",
      subject1
    );
    assert.ok(afterFirst);
    assert.equal(afterFirst.id, first.incident);
    assert.equal(afterFirst.occurrence_count, "1");
    assert.equal(afterFirst.last_reference, "ref-1");
    await pause(30);
    const second = await dispatcher.recordDeadLetter({
      cause: "retries_exhausted",
      event: null,
      reference: "ref-2",
      subject: subject1,
    });
    assert.equal(second, undefined);
    const afterSecond = await incidentOf(
      "queue_dead_letter",
      "retries_exhausted",
      subject1
    );
    assert.ok(afterSecond);
    assert.equal(afterSecond.id, first.incident, "the same incident");
    assert.equal(afterSecond.occurrence_count, "2");
    assert.equal(afterSecond.last_reference, "ref-2");
    assert.equal(
      afterSecond.first_seen_at.getTime(),
      afterFirst.first_seen_at.getTime(),
      "the first sighting never moves"
    );
    assert.ok(
      afterSecond.last_seen_at.getTime() > afterFirst.last_seen_at.getTime(),
      "the last sighting moves"
    );
    await recordDeadLetter("retries_exhausted", subject1, null, null, null);
    const afterThird = await incidentOf(
      "queue_dead_letter",
      "retries_exhausted",
      subject1
    );
    assert.equal(afterThird?.occurrence_count, "3");
    assert.equal(
      afterThird?.last_reference,
      "ref-2",
      "a message without a reference keeps the last one"
    );
    assert.equal(
      await countOf(
        "SELECT count(*)::text AS count FROM public.operational_incidents WHERE kind = 'queue_dead_letter' AND subject = $1",
        [subject1]
      ),
      1
    );
    for (const cause of CAUSES) {
      const made = await recordDeadLetter(
        cause,
        typeName("causes"),
        null,
        null,
        null
      );
      assert.equal(made.tracked, false);
    }
    assert.equal(
      await countOf(
        "SELECT count(*)::text AS count FROM public.operational_incidents WHERE kind = 'queue_dead_letter' AND subject = $1",
        [typeName("causes")]
      ),
      CAUSES.length,
      "one incident per (kind, cause, subject): each of the four causes has its own"
    );
    const unknownSubject = await recordDeadLetter(
      "invalid_envelope",
      "unknown",
      "unknown-ref",
      null,
      null
    );
    assert.equal(unknownSubject.tracked, false);
    const longest = `gate_dlq.${"a".repeat(80 - 9 - suffix.length)}${suffix}`;
    assert.equal(longest.length, 80);
    await recordDeadLetter("wrong_queue", longest, "a".repeat(128), null, null);
    tests.push(
      "record_dead_letter: the first record of a (cause, subject) creates one queue_dead_letter incident (count 1, reference kept, tracked=false without an event); the second, through the outbox client, only adds to occurrence_count and moves last_seen_at and last_reference while first_seen_at stays; a record without a reference keeps the last one; each of the four causes has its own incident; subject 'unknown', an 80-character subject and a 128-character reference are accepted"
    );

    const concurrentSubject = typeName("race");
    const raced = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        recordDeadLetter(
          "retries_exhausted",
          concurrentSubject,
          `race-${index}`,
          null,
          null,
          racers.pool
        )
      )
    );
    assert.equal(new Set(raced.map((row) => row.incident)).size, 1);
    assert.equal(
      (
        await incidentOf(
          "queue_dead_letter",
          "retries_exhausted",
          concurrentSubject
        )
      )?.occurrence_count,
      "20",
      "twenty concurrent records of one cause count exactly twenty"
    );
    tests.push(
      "record_dead_letter, concurrent: twenty records of one new (cause, subject) at the same time over six connections create one incident and count exactly twenty"
    );

    const countsBeforeInvalid = {
      incidents: await countOf(
        "SELECT count(*)::text AS count FROM public.operational_incidents"
      ),
      items: await countOf(
        "SELECT count(*)::text AS count FROM public.queue_dead_letters"
      ),
    };
    assert.ok(countsBeforeInvalid.incidents > incidentsBefore);
    const invalidInputs: [
      string,
      string | null,
      string | null,
      string | null,
    ][] = [
      ["a cause outside the list", "made_up_cause", subject1, null],
      ["an empty cause", "", subject1, null],
      ["a null cause", null, subject1, null],
      ["a null subject", "retries_exhausted", null, null],
      ["an uppercase subject", "retries_exhausted", "Gate.Upper", null],
      ["a subject with a space", "retries_exhausted", "gate.has space", null],
      [
        "a subject with a line break",
        "retries_exhausted",
        "gate.line\nbreak",
        null,
      ],
      ["a subject with one segment", "retries_exhausted", "nodot", null],
      ["a subject that ends with a dot", "retries_exhausted", "gate.", null],
      ["an empty subject", "retries_exhausted", "", null],
      [
        "a subject of 81 characters",
        "retries_exhausted",
        `a.${"b".repeat(79)}`,
        null,
      ],
      [
        "a long text as the subject",
        "retries_exhausted",
        "gate.".padEnd(300, "a"),
        null,
      ],
      ["a reference with a space", "retries_exhausted", subject1, "has space"],
      ["a reference with a line break", "retries_exhausted", subject1, "a\nb"],
      [
        "a reference of 129 characters",
        "retries_exhausted",
        subject1,
        "a".repeat(129),
      ],
      ["an empty reference", "retries_exhausted", subject1, ""],
      ["a reference with a slash", "retries_exhausted", subject1, "a/b"],
      ["a reference with a quote", "retries_exhausted", subject1, "a'b"],
    ];
    for (const [label, cause, subject, reference] of invalidInputs) {
      await expectError(
        () => recordDeadLetter(cause, subject, reference, null, null),
        "22023",
        "invalid_dead_letter",
        `record_dead_letter refuses ${label}`
      );
    }
    assert.deepEqual(
      {
        incidents: await countOf(
          "SELECT count(*)::text AS count FROM public.operational_incidents"
        ),
        items: await countOf(
          "SELECT count(*)::text AS count FROM public.queue_dead_letters"
        ),
      },
      countsBeforeInvalid,
      "a refused record creates nothing and counts nothing"
    );
    assert.equal(
      (await incidentOf("queue_dead_letter", "retries_exhausted", subject1))
        ?.occurrence_count,
      "3"
    );
    tests.push(
      "record_dead_letter, invalid: a cause outside the list (empty, null, free text), a null, uppercase, spaced, line-broken, single-segment, dot-ended, empty, 81-character or 300-character subject, and a reference with a space, a line break, a slash, a quote, empty or of 129 characters are all refused with 22023 invalid_dead_letter, and no incident or item is created or counted"
    );

    const typeTracked = typeName("tracked");
    const eventTracked = await makeEvent(orgA.organizationId, typeTracked, {
      attempts: 4,
      status: "dispatched",
    });
    const trackedOnce = await recordDeadLetter(
      "retries_exhausted",
      typeTracked,
      "t-1",
      eventTracked.id,
      orgA.organizationId
    );
    assert.equal(trackedOnce.tracked, true);
    const itemOnce = await itemOf(eventTracked.id);
    assert.ok(itemOnce);
    assert.deepEqual(
      [
        itemOnce.state,
        itemOnce.occurrences,
        itemOnce.retry_count,
        itemOnce.retried,
        itemOnce.incident_id,
        itemOnce.organization_id,
      ],
      ["dead", 1, 0, false, trackedOnce.incident, orgA.organizationId]
    );
    const itemMeta = await owner.pool.query<{ event_type: string }>(
      "SELECT event_type FROM public.queue_dead_letters WHERE event_id = $1",
      [eventTracked.id]
    );
    assert.equal(itemMeta.rows[0]?.event_type, typeTracked);
    const trackedTwice = await recordDeadLetter(
      "retries_exhausted",
      typeTracked,
      "t-2",
      eventTracked.id,
      orgA.organizationId
    );
    assert.equal(trackedTwice.tracked, true);
    assert.equal(trackedTwice.incident, trackedOnce.incident);
    assert.equal(
      (await itemOf(eventTracked.id))?.occurrences,
      2,
      "a second record of the same event only adds to its occurrences"
    );
    assert.equal(
      await countOf(
        "SELECT count(*)::text AS count FROM public.queue_dead_letters WHERE event_id = $1",
        [eventTracked.id]
      ),
      1
    );
    await owner.pool.query(
      "UPDATE public.queue_dead_letters SET state = 'retried', retried_at = now(), retry_count = 1 WHERE event_id = $1",
      [eventTracked.id]
    );
    await recordDeadLetter(
      "retries_exhausted",
      typeTracked,
      "t-3",
      eventTracked.id,
      orgA.organizationId
    );
    const backToDead = await itemOf(eventTracked.id);
    assert.equal(
      backToDead?.state,
      "dead",
      "a retried event that died again is dead again"
    );
    assert.equal(backToDead?.occurrences, 3);
    tests.push(
      "record_dead_letter, tracked: for an event the outbox holds (same organization, same type) the item is created dead with occurrences 1, its incident, organization and type; recording the same event again adds one occurrence and keeps one item; an item that was retried goes back to dead"
    );

    const typeUntracked = typeName("untracked");
    const heldEvent = await makeEvent(orgA.organizationId, typeUntracked, {
      attempts: 2,
      status: "dispatched",
    });
    const untrackedCases: [string, string, string | null, string | null][] = [
      [
        "an event the outbox does not hold",
        typeUntracked,
        randomUUID(),
        orgA.organizationId,
      ],
      [
        "another organization's name for the event",
        typeUntracked,
        heldEvent.id,
        orgB.organizationId,
      ],
      [
        "a type that is not the event's",
        typeName("othertype"),
        heldEvent.id,
        orgA.organizationId,
      ],
      ["the subject 'unknown'", "unknown", heldEvent.id, orgA.organizationId],
      ["no organization", typeUntracked, heldEvent.id, null],
      ["no event", typeUntracked, null, orgA.organizationId],
    ];
    const itemsBeforeUntracked = await countOf(
      "SELECT count(*)::text AS count FROM public.queue_dead_letters"
    );
    for (const [label, subject, eventId, organizationId] of untrackedCases) {
      const result = await recordDeadLetter(
        "wrong_queue",
        subject,
        "u-ref",
        eventId,
        organizationId
      );
      assert.equal(result.tracked, false, `${label} is only counted`);
      assert.ok(result.incident, `${label} still counts the incident`);
    }
    assert.equal(
      await countOf(
        "SELECT count(*)::text AS count FROM public.queue_dead_letters"
      ),
      itemsBeforeUntracked,
      "none of them created an item"
    );
    assert.equal(
      await itemOf(heldEvent.id),
      undefined,
      "the event has no item"
    );
    assert.equal(
      (await incidentOf("queue_dead_letter", "wrong_queue", typeUntracked))
        ?.occurrence_count,
      "4",
      "the incidents were counted: unknown event, wrong organization, no organization, no event"
    );
    assert.equal(
      (
        await incidentOf(
          "queue_dead_letter",
          "wrong_queue",
          typeName("othertype")
        )
      )?.occurrence_count,
      "1"
    );
    tests.push(
      "record_dead_letter, not tracked: an event the outbox does not hold, one named with another organization or none, one named with a type that is not its own, the subject 'unknown' and a record without an event only count the incident (tracked=false) and create no item"
    );

    // ------------------------------------------------- 3. record_exhausted_outbox_events
    await quiesce();
    const typeE1 = typeName("exhausta");
    const typeE2 = typeName("exhaustb");
    const e1 = await makeEvent(orgA.organizationId, typeE1, {
      attempts: 1000,
      secondsAgo: 120,
    });
    const e2 = await makeEvent(orgA.organizationId, typeE1, {
      attempts: 1500,
      lock: "expired",
      secondsAgo: 60,
    });
    const e3 = await makeEvent(orgA.organizationId, typeE1, {
      attempts: 1000,
      lock: "live",
    });
    const e4 = await makeEvent(orgA.organizationId, typeE1, {
      attempts: 1000,
      status: "dispatched",
    });
    const e5 = await makeEvent(orgA.organizationId, typeE1, { attempts: 999 });
    const e6 = await makeEvent(orgB.organizationId, typeE2, { attempts: 1000 });
    assert.equal(
      await recordExhausted(100),
      3,
      "only the pending, exhausted and unheld events"
    );
    for (const event of [e1, e2, e6]) {
      const item = await itemOf(event.id);
      assert.equal(item?.state, "dead", `${event.id} is dead`);
      assert.equal(item?.organization_id, event.organizationId);
      assert.equal(item?.occurrences, 1);
    }
    for (const [label, event] of [
      ["a live claim", e3],
      ["a dispatched event", e4],
      ["999 attempts", e5],
    ] as const) {
      assert.equal(
        await itemOf(event.id),
        undefined,
        `${label} is not recorded`
      );
    }
    const exhaustedA = await incidentOf(
      "outbox_attempts_exhausted",
      "attempts_exhausted",
      typeE1
    );
    assert.equal(exhaustedA?.occurrence_count, "2", "one incident per type");
    assert.equal(
      exhaustedA?.last_reference,
      e2.id,
      "the reference is the last event's ID"
    );
    assert.equal(
      (
        await incidentOf(
          "outbox_attempts_exhausted",
          "attempts_exhausted",
          typeE2
        )
      )?.occurrence_count,
      "1"
    );
    assert.equal(
      await countOf(
        "SELECT count(DISTINCT incident_id)::text AS count FROM public.queue_dead_letters WHERE event_id = ANY($1::uuid[])",
        [[e1.id, e2.id, e6.id]]
      ),
      2
    );
    assert.equal(
      await recordExhausted(100),
      0,
      "a second run records nothing: the events are dead already"
    );
    assert.equal(
      (
        await incidentOf(
          "outbox_attempts_exhausted",
          "attempts_exhausted",
          typeE1
        )
      )?.occurrence_count,
      "2",
      "and counts nothing"
    );
    assert.equal((await itemOf(e1.id))?.occurrences, 1);
    // the live claim runs out: now the event is recorded
    await owner.pool.query(
      "UPDATE public.event_outbox SET locked_until = now() - interval '1 second' WHERE id = $1",
      [e3.id]
    );
    assert.equal(await dispatcher.recordExhaustedOutboxEvents(100), 1);
    assert.equal((await itemOf(e3.id))?.state, "dead");
    // the limit is a batch size
    const more = [
      await makeEvent(orgA.organizationId, typeE1, { attempts: 1000 }),
      await makeEvent(orgA.organizationId, typeE1, { attempts: 1000 }),
    ];
    assert.equal(await recordExhausted(1), 1);
    assert.equal(await recordExhausted(1), 1);
    assert.equal(await recordExhausted(1), 0);
    for (const event of more) {
      assert.equal((await itemOf(event.id))?.state, "dead");
    }
    for (const limit of [0, 101, -1]) {
      await expectError(
        () => recordExhausted(limit),
        "22023",
        "invalid_limit",
        `a limit of ${limit} is refused`
      );
    }
    await expectError(
      () =>
        outboxDirect.pool.query(
          "SELECT public.record_exhausted_outbox_events(NULL)"
        ),
      "22023",
      "invalid_limit",
      "a null limit is refused"
    );
    tests.push(
      "record_exhausted_outbox_events: records only pending events at 1000 attempts or more with no live claim (an expired claim counts) and ignores dispatched, 999-attempt and live-claim events; one incident per event type (kind outbox_attempts_exhausted, cause attempts_exhausted) counting its events, with the last event's ID as reference; a second run returns 0 and counts nothing; an event whose claim runs out is recorded by the next run; the limit is a batch size; a limit of 0, 101, -1 or null is refused with 22023"
    );

    // two runs at once never count one event twice
    for (let round = 0; round < 3; round += 1) {
      const raceType = typeName(`exh${round}race`);
      const made = await owner.pool.query<{ id: string }>(
        `INSERT INTO public.event_outbox (organization_id, type, event, idempotency_key, correlation_id, attempts, status)
         SELECT $1, $2::text, '{}'::jsonb, $2::text || ':' || gen_random_uuid()::text, gen_random_uuid()::text, 1000, 'pending'
           FROM generate_series(1, 100) RETURNING id`,
        [orgA.organizationId, raceType]
      );
      assert.equal(made.rows.length, 100);
      const runs = await Promise.all(
        Array.from({ length: 4 }, () => recordExhausted(100, racers.pool))
      );
      assert.equal(
        runs.reduce((sum, value) => sum + value, 0),
        100,
        `round ${round}: four concurrent runs record each of the hundred events once (they recorded ${runs.join("+")})`
      );
      const counted = await owner.pool.query<{
        incident_count: string;
        max_occurrences: number;
        items: string;
      }>(
        "SELECT (SELECT occurrence_count::text FROM public.operational_incidents WHERE kind = 'outbox_attempts_exhausted' AND subject = $1) AS incident_count, (SELECT count(*)::text FROM public.queue_dead_letters WHERE event_type = $1) AS items, (SELECT max(occurrences) FROM public.queue_dead_letters WHERE event_type = $1) AS max_occurrences",
        [raceType]
      );
      assert.deepEqual(
        counted.rows[0],
        { incident_count: "100", items: "100", max_occurrences: 1 },
        `round ${round}: the incident counts a hundred and no event twice`
      );
    }
    tests.push(
      "record_exhausted_outbox_events, concurrent: three rounds of four runs at the same time over a hundred exhausted events each record exactly a hundred in total, one item each with occurrences 1, and the incident counts exactly a hundred"
    );

    // the event is sent again (retry) and exhausts again: dead again, one more occurrence
    const reexhaust = await retry(e1.id);
    assert.equal(reexhaust.result, "retried");
    assert.deepEqual(
      [(await eventOf(e1.id))?.attempts, (await eventOf(e1.id))?.status],
      [0, "pending"]
    );
    assert.equal((await itemOf(e1.id))?.state, "retried");
    await owner.pool.query(
      "UPDATE public.event_outbox SET attempts = 1000 WHERE id = $1",
      [e1.id]
    );
    assert.equal(await recordExhausted(100), 1);
    const dead2 = await itemOf(e1.id);
    assert.equal(dead2?.state, "dead", "dead again");
    assert.equal(dead2?.occurrences, 2, "one more occurrence");
    assert.equal(dead2?.retry_count, 1, "its retry stays counted");
    assert.equal(
      (
        await incidentOf(
          "outbox_attempts_exhausted",
          "attempts_exhausted",
          typeE1
        )
      )?.occurrence_count,
      "6",
      "the incident counts it again (e1, e2, e3, two more, e1 again)"
    );
    tests.push(
      "record_exhausted_outbox_events, after a retry: an event sent again and exhausted again goes back to dead, adds an occurrence, keeps its retry count and counts once more in its incident"
    );

    // ------------------------------------------------- 4. retry_dead_letter
    await quiesce();
    const typeR = typeName("retry");
    // A: dispatched below the cap: back to pending, attempts untouched, processing record kept as done
    const a = await deadItem(orgA.organizationId, typeR, {
      attempts: 3,
      status: "dispatched",
    });
    await putProcessing(a, 3, "done");
    const aKey: ProcessingKey = {
      attempt: 3,
      eventId: a.id,
      idempotencyKey: a.key,
      organizationId: a.organizationId,
      type: typeR,
    };
    assert.equal(
      (await dispatcher.claimProcessing(aKey, LEASE)).result,
      "done",
      "before the retry the attempt is a duplicate of a done one"
    );
    const aRetried = await retry(a.id);
    assert.deepEqual(aRetried, {
      eventType: typeR,
      organizationId: orgA.organizationId,
      result: "retried",
    });
    assert.deepEqual(await eventOf(a.id), {
      attempts: 3,
      due: true,
      locked: false,
      status: "pending",
    });
    const aItem = await itemOf(a.id);
    assert.deepEqual(
      [aItem?.state, aItem?.retried, aItem?.retry_count],
      ["retried", true, 1]
    );
    const aAgain = await retry(a.id);
    assert.equal(aAgain.result, "already_pending");
    const aItemAgain = await itemOf(a.id);
    assert.deepEqual(
      [aItemAgain?.state, aItemAgain?.retry_count],
      ["retried", 1],
      "a repeat changes no retry count"
    );
    assert.equal((await eventOf(a.id))?.attempts, 3);
    // the dispatcher takes it again, and the consumer's record runs the new attempt
    const resent = await dispatcher.claimOutboxEvents(100, LEASE);
    const resentA = resent.find((row) => row.id === a.id);
    assert.ok(resentA, "the dispatcher claims the retried event");
    assert.equal(resentA.attempts, 4);
    assert.equal(resentA.type, typeR);
    assert.equal(
      (await dispatcher.claimProcessing({ ...aKey, attempt: 4 }, LEASE)).result,
      "claimed",
      "the new attempt is not taken for the old done one"
    );
    await dispatcher.completeProcessing({ ...aKey, attempt: 4 });
    assert.equal(
      await dispatcher.markOutboxEventsDispatched(
        resent.map((row) => ({ attempts: row.attempts, id: row.id }))
      ),
      resent.length
    );
    // it dies once more and is retried a second time
    await recordDeadLetter(
      "retries_exhausted",
      typeR,
      "again",
      a.id,
      orgA.organizationId
    );
    assert.equal((await itemOf(a.id))?.state, "dead");
    assert.equal((await retry(a.id)).result, "retried");
    assert.equal((await itemOf(a.id))?.retry_count, 2);
    assert.equal(
      (await eventOf(a.id))?.attempts,
      4,
      "attempts are never reset below the cap"
    );
    tests.push(
      "retry_dead_letter, below the cap: a dispatched event goes back to pending, due now, with no claim and the same attempts; the item becomes retried with retried_at and retry_count 1; repeating gives already_pending and changes no count; the dispatcher claims it again (attempts + 1) and the processing record answers claimed, not done, for the new attempt (and done for the old duplicate before); a second death and retry makes retry_count 2"
    );

    // B: at the cap: attempts start over and the processing record of the key goes
    const b = await deadItem(orgA.organizationId, typeR, { attempts: 1000 });
    await putProcessing(b, 1000, "done");
    const bKey: ProcessingKey = {
      attempt: 1,
      eventId: b.id,
      idempotencyKey: b.key,
      organizationId: b.organizationId,
      type: typeR,
    };
    assert.equal(
      (await dispatcher.claimProcessing(bKey, LEASE)).result,
      "done",
      "without the delete, the first new attempt would be taken for a duplicate"
    );
    assert.equal((await retry(b.id)).result, "retried");
    assert.deepEqual(await eventOf(b.id), {
      attempts: 0,
      due: true,
      locked: false,
      status: "pending",
    });
    assert.equal(await processingOf(b.organizationId, b.key), undefined);
    const bItem = await itemOf(b.id);
    assert.deepEqual([bItem?.state, bItem?.retry_count], ["retried", 1]);
    const bResent = (await dispatcher.claimOutboxEvents(100, LEASE)).find(
      (row) => row.id === b.id
    );
    assert.equal(bResent?.attempts, 1, "attempts start over");
    assert.equal(
      (await dispatcher.claimProcessing(bKey, LEASE)).result,
      "claimed",
      "the new delivery runs"
    );
    await dispatcher.completeProcessing(bKey);
    await dispatcher.markOutboxEventsDispatched([{ attempts: 1, id: b.id }]);
    // B2: the same with a claimed record whose lease ran out; a dispatched event at the cap as well
    const b2 = await deadItem(orgA.organizationId, typeR, {
      attempts: 1200,
      status: "dispatched",
    });
    await putProcessing(b2, 1000, "claimed-expired");
    assert.equal((await retry(b2.id)).result, "retried");
    assert.deepEqual(
      [(await eventOf(b2.id))?.attempts, (await eventOf(b2.id))?.status],
      [0, "pending"]
    );
    assert.equal(await processingOf(b2.organizationId, b2.key), undefined);
    // a record of another key is not touched
    const other = await makeEvent(orgA.organizationId, typeR, {
      attempts: 5,
      status: "dispatched",
    });
    await putProcessing(other, 5, "done");
    const b3 = await deadItem(orgA.organizationId, typeR, { attempts: 1000 });
    assert.equal((await retry(b3.id)).result, "retried");
    assert.equal(
      (await processingOf(other.organizationId, other.key))?.state,
      "done",
      "only the key of the retried event is forgotten"
    );
    tests.push(
      "retry_dead_letter, at the cap: attempts go back to 0, the processing record of that key (done, or claimed with an expired lease) is removed and no other key's is, the item becomes retried; the dispatcher then claims attempts 1 and the processing record answers claimed (before the retry the same attempt would have answered done); a dispatched event at 1200 attempts is started over as well"
    );

    // C: at the cap with a claimed record whose lease is alive: busy, nothing changes
    const c = await deadItem(orgA.organizationId, typeR, { attempts: 1000 });
    await putProcessing(c, 1000, "claimed-live");
    const cBefore = await processingOf(c.organizationId, c.key);
    assert.equal((await retry(c.id)).result, "busy");
    assert.deepEqual(await eventOf(c.id), {
      attempts: 1000,
      due: true,
      locked: false,
      status: "pending",
    });
    assert.deepEqual(
      await processingOf(c.organizationId, c.key),
      cBefore,
      "the processing record is kept as it was, token included"
    );
    const cItem = await itemOf(c.id);
    assert.deepEqual(
      [cItem?.state, cItem?.retry_count, cItem?.retried],
      ["dead", 0, false],
      "the item did not change"
    );
    // C2: below the cap too, a consumer still running the last delivery holds the event: busy, nothing changes
    const c2 = await deadItem(orgA.organizationId, typeR, {
      attempts: 3,
      status: "dispatched",
    });
    await putProcessing(c2, 3, "claimed-live");
    const c2Before = await processingOf(c2.organizationId, c2.key);
    assert.equal((await retry(c2.id)).result, "busy");
    assert.equal((await eventOf(c2.id))?.status, "dispatched");
    assert.deepEqual(await processingOf(c2.organizationId, c2.key), c2Before);
    assert.equal((await itemOf(c2.id))?.state, "dead");
    tests.push(
      "retry_dead_letter, below the cap: a dispatched event whose last delivery a consumer still holds (claimed record with a live lease) answers busy and nothing changes"
    );

    // D: a live claim of the dispatcher: busy, nothing changes (below and at the cap)
    for (const [label, attempts, status] of [
      ["pending below the cap", 7, "pending"],
      ["pending at the cap", 1000, "pending"],
      ["dispatched below the cap", 7, "dispatched"],
    ] as const) {
      const held = await deadItem(orgA.organizationId, typeR, {
        attempts,
        lock: "live",
        status,
      });
      const before = await eventOf(held.id);
      assert.equal(
        (await retry(held.id)).result,
        "busy",
        `${label} with a live claim`
      );
      assert.deepEqual(
        await eventOf(held.id),
        before,
        `${label}: the event is untouched`
      );
      assert.equal((await itemOf(held.id))?.state, "dead");
      assert.equal((await itemOf(held.id))?.retry_count, 0);
    }
    // a claim that ran out is not busy
    const expired = await deadItem(orgA.organizationId, typeR, {
      attempts: 9,
      lock: "expired",
      status: "pending",
    });
    assert.equal((await retry(expired.id)).result, "already_pending");
    assert.equal((await itemOf(expired.id))?.state, "retried");
    // E: the event is gone (the purge): the item stays, nothing breaks
    const gone = await deadItem(orgA.organizationId, typeR, {
      attempts: 2,
      status: "dispatched",
    });
    await owner.pool.query("DELETE FROM public.event_outbox WHERE id = $1", [
      gone.id,
    ]);
    const goneResult = await retry(gone.id);
    assert.deepEqual(goneResult, {
      eventType: typeR,
      organizationId: orgA.organizationId,
      result: "event_gone",
    });
    assert.equal((await itemOf(gone.id))?.state, "dead", "the item stays");
    assert.equal((await itemOf(gone.id))?.retry_count, 0);
    // F: no such item
    assert.deepEqual(await retry(randomUUID()), { result: "unknown_item" });
    // G: a pending event below the cap whose item is dead: already pending, and the item is satisfied
    const g = await deadItem(orgA.organizationId, typeR, { attempts: 0 });
    assert.equal((await retry(g.id)).result, "already_pending");
    const gItem = await itemOf(g.id);
    assert.deepEqual([gItem?.state, gItem?.retry_count], ["retried", 1]);
    assert.equal((await retry(g.id)).result, "already_pending");
    assert.equal((await itemOf(g.id))?.retry_count, 1);
    tests.push(
      "retry_dead_letter, refusals: an event at the cap with a claimed processing record whose lease is alive, and an event with a live claim of the dispatcher (pending below or at the cap, dispatched), answer busy and change nothing (event, processing record with its token, item); a claim that ran out is not busy; an event the purge removed answers event_gone and the item stays dead; an unknown event answers unknown_item; a pending event whose item is dead answers already_pending and the item becomes retried once"
    );

    // concurrent retries: one retried, one already_pending, one count
    const h = await deadItem(orgA.organizationId, typeR, {
      attempts: 2,
      status: "dispatched",
    });
    const retried = await Promise.all([
      retry(h.id, retryDb.pool),
      retry(h.id, retryDb.pool),
    ]);
    assert.deepEqual(
      retried.map((row) => row.result).sort(),
      ["already_pending", "retried"],
      "two retries at the same time: one sends it, the other finds it pending"
    );
    assert.equal((await itemOf(h.id))?.retry_count, 1);
    tests.push(
      "retry_dead_letter, concurrent: two retries of one dispatched event at the same time answer one retried and one already_pending, and retry_count is 1"
    );

    // ------------------------------------------------- 6. the audit CHECK
    const auditClient = await owner.pool.connect();
    try {
      await auditClient.query("BEGIN");
      await auditClient.query(
        "INSERT INTO public.platform_audit_events (principal_id, event_type) VALUES ($1, 'operational_incident.retry')",
        [operator]
      );
      await auditClient.query("ROLLBACK");
      await auditClient.query("BEGIN");
      await expectSqlState(
        () =>
          auditClient.query(
            "INSERT INTO public.platform_audit_events (principal_id, event_type) VALUES ($1, 'operational_incident.anything')",
            [operator]
          ),
        "23514",
        "a made-up audit event type is refused",
        "platform_audit_events_type_allowed"
      );
      await auditClient.query("ROLLBACK");
    } finally {
      await auditClient.query("ROLLBACK").catch(() => undefined);
      auditClient.release();
    }
    const auditDefinition = await owner.pool.query<{ definition: string }>(
      "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname = 'platform_audit_events_type_allowed' AND conrelid = 'public.platform_audit_events'::regclass"
    );
    for (const type of [
      "support_case.opened",
      "privacy_case.action_recorded",
      "operational_incident.retry",
    ]) {
      assert.ok(
        auditDefinition.rows[0]?.definition.includes(`'${type}'`),
        `the audit CHECK still lists ${type}`
      );
    }
    tests.push(
      "audit CHECK: platform_audit_events accepts operational_incident.retry (inserted and rolled back), still lists the earlier types and refuses another type with the named constraint"
    );

    // ------------------------------------------------- 5. the Admin's functions
    const typeAdmin = typeName("admin");
    const auditCountBefore = await countOf(
      "SELECT count(*)::text AS count FROM public.platform_audit_events WHERE event_type = 'operational_incident.retry'"
    );
    const x = await deadItem(orgA.organizationId, typeAdmin, {
      attempts: 6,
      status: "dispatched",
    });
    const y = await deadItem(orgB.organizationId, typeName("adminother"), {
      attempts: 6,
      status: "dispatched",
    });
    assert.notEqual(x.incident, y.incident);
    const untouched = async (event: { id: string }, label: string) => {
      assert.deepEqual(
        await eventOf(event.id),
        { attempts: 6, due: true, locked: false, status: "dispatched" },
        `${label}: the event did not move`
      );
      const item = await itemOf(event.id);
      assert.deepEqual(
        [item?.state, item?.retry_count],
        ["dead", 0],
        `${label}: the item did not change`
      );
      assert.equal(
        (await auditsOf(event.id)).length,
        0,
        `${label}: nothing was audited`
      );
    };
    // the operator
    for (const [label, id] of [
      ["an unknown principal", randomUUID()],
      ["a disabled principal", disabled],
    ] as const) {
      await expectSqlState(
        () => adminRetry(x.incident, x.id, "motivo valido", id),
        "42501",
        `${label} is refused`
      );
    }
    await expectSqlState(
      () =>
        adminClient.query(
          "SELECT public.admin_retry_dead_letter(NULL, $1::uuid, $2::uuid, 'motivo')",
          [x.incident, x.id]
        ),
      "42501",
      "a null principal is refused"
    );
    await untouched(x, "an invalid operator");
    // the reason
    const reasons: [string, string | null][] = [
      ["an empty reason", ""],
      ["a reason of spaces", "     "],
      ["a null reason", null],
      ["a reason of 151 characters", "r".repeat(151)],
      ["a reason with a tab", "um\ttab"],
      ["a reason with a line break", "uma\nlinha"],
      ["a reason with a carriage return", "uma\rlinha"],
      ["a reason with a bell", "toque\u0007"],
      ["a reason with DEL", "del\u007f"],
      ["a reason with a C1 control", "c1\u0085"],
      ["a reason with a zero-width space", "zw\u200bsp"],
      ["a reason with a line separator", "ls\u2028ls"],
      ["a reason with a paragraph separator", "ps\u2029ps"],
      ["a reason with a direction override", "rl\u202eo"],
      ["a reason with a direction isolate", "is\u2066o"],
      ["a reason with a byte order mark", "bom\ufeff"],
    ];
    for (const [label, reason] of reasons) {
      await expectError(
        () =>
          adminClient.query(
            "SELECT public.admin_retry_dead_letter($1::uuid, $2::uuid, $3::uuid, $4::text)",
            [operator, x.incident, x.id, reason]
          ),
        "22023",
        "invalid_incident_reason",
        `${label} is refused`
      );
    }
    await assert.rejects(
      () => adminRetry(x.incident, x.id, " \t "),
      InvalidIncidentRetryError,
      "the repository turns the refusal into the domain error"
    );
    await untouched(x, "an invalid reason");
    // an item that is not of the incident
    for (const [label, incident, event] of [
      ["an event of another incident", y.incident, x.id],
      ["an event that is no item", x.incident, randomUUID()],
      ["an incident that does not exist", randomUUID(), x.id],
    ] as const) {
      assert.equal(
        await adminRetry(incident, event, "motivo valido"),
        "unknown_item",
        label
      );
    }
    await untouched(x, "an item that is not of the incident");
    await untouched(y, "an item that is not of the incident");
    assert.equal(
      await countOf(
        "SELECT count(*)::text AS count FROM public.platform_audit_events WHERE event_type = 'operational_incident.retry'"
      ),
      auditCountBefore,
      "none of the refusals wrote an audit"
    );
    tests.push(
      "admin_retry_dead_letter, refusals: an unknown, a disabled or a null principal is refused with 42501; an empty, spaces-only, null, 151-character or control-character (tab, line break, carriage return, bell, DEL) reason is refused with 22023 invalid_incident_reason (and the repository raises InvalidIncidentRetryError); an event of another incident, an event that is no item and an incident that does not exist answer unknown_item; in every case the event, the item and the audit are unchanged"
    );

    // atomicity: the audit fails, so the retry must not stay
    await owner.pool.query(
      `CREATE OR REPLACE FUNCTION public.gate_dlq_block_audit() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN RAISE EXCEPTION 'gate_dlq_audit_blocked'; END; $$`
    );
    await owner.pool.query(
      "CREATE TRIGGER gate_dlq_block_audit BEFORE INSERT ON public.platform_audit_events FOR EACH ROW EXECUTE FUNCTION public.gate_dlq_block_audit()"
    );
    const atomicBelow = x;
    const atomicCap = await deadItem(orgA.organizationId, typeAdmin, {
      attempts: 1000,
    });
    await putProcessing(atomicCap, 1000, "done");
    try {
      await expectError(
        () => adminRetry(atomicBelow.incident, atomicBelow.id, "motivo valido"),
        "P0001",
        "gate_dlq_audit_blocked",
        "a failing audit fails the retry"
      );
      await untouched(atomicBelow, "a failed audit (below the cap)");
      const capBefore = await processingOf(
        atomicCap.organizationId,
        atomicCap.key
      );
      await expectError(
        () => adminRetry(atomicCap.incident, atomicCap.id, "motivo valido"),
        "P0001",
        "gate_dlq_audit_blocked",
        "a failing audit fails the retry at the cap"
      );
      assert.deepEqual(await eventOf(atomicCap.id), {
        attempts: 1000,
        due: true,
        locked: false,
        status: "pending",
      });
      assert.deepEqual(
        await processingOf(atomicCap.organizationId, atomicCap.key),
        capBefore,
        "the processing record the retry deleted is back (same transaction)"
      );
      const capItem = await itemOf(atomicCap.id);
      assert.deepEqual([capItem?.state, capItem?.retry_count], ["dead", 0]);
      assert.equal((await auditsOf(atomicCap.id)).length, 0);
    } finally {
      await owner.pool.query(
        "DROP TRIGGER IF EXISTS gate_dlq_block_audit ON public.platform_audit_events"
      );
      await owner.pool.query(
        "DROP FUNCTION IF EXISTS public.gate_dlq_block_audit()"
      );
    }
    tests.push(
      "admin_retry_dead_letter, atomic: with a BEFORE INSERT trigger on platform_audit_events that raises, the retry fails and the event stays dispatched (below the cap) or pending at 1000 attempts with its processing record still there (at the cap), the item stays dead with no retry counted and no audit exists; the trigger is removed afterwards"
    );

    // success: exactly one audit, the same transaction
    const reason = "  razão: reenvio após correção do consumidor  ";
    assert.equal(await adminRetry(x.incident, x.id, reason), "retried");
    assert.deepEqual(await eventOf(x.id), {
      attempts: 6,
      due: true,
      locked: false,
      status: "pending",
    });
    const xAudits = await auditsOf(x.id);
    assert.equal(xAudits.length, 1, "exactly one audit row");
    assert.deepEqual(xAudits[0], {
      detail:
        "result=retried; reason=razão: reenvio após correção do consumidor",
      entity_id: x.id,
      entity_type: "queue_dead_letter",
      event_type: "operational_incident.retry",
      organization_id: orgA.organizationId,
      principal_id: operator,
      support_case_id: null,
    });
    assert.ok((xAudits[0]?.detail.length ?? 999) <= 200);
    assert.equal((await itemOf(x.id))?.state, "retried");
    // a repeat is audited too and changes nothing
    assert.equal(
      await adminRetry(x.incident, x.id, "segunda tentativa"),
      "already_pending"
    );
    const xAudits2 = await auditsOf(x.id);
    assert.equal(xAudits2.length, 2, "a repeat is audited");
    assert.equal(
      xAudits2[1]?.detail,
      "result=already_pending; reason=segunda tentativa"
    );
    assert.equal((await itemOf(x.id))?.retry_count, 1);
    // the longest reason fits the audit detail
    const longReason = "é".repeat(150);
    assert.equal(
      await adminRetry(y.incident, y.id, longReason),
      "retried",
      "a reason of 150 characters is accepted"
    );
    const [yAudit] = await auditsOf(y.id);
    assert.equal(yAudit?.detail, `result=retried; reason=${longReason}`);
    assert.ok((yAudit?.detail.length ?? 999) <= 200);
    // busy and event_gone are audited with their result, and change nothing
    const busy = await deadItem(orgB.organizationId, typeAdmin, {
      attempts: 3,
      lock: "live",
    });
    assert.equal(await adminRetry(busy.incident, busy.id, "tentativa"), "busy");
    assert.equal(
      (await auditsOf(busy.id))[0]?.detail,
      "result=busy; reason=tentativa"
    );
    assert.equal(
      (await auditsOf(busy.id))[0]?.organization_id,
      orgB.organizationId
    );
    assert.equal((await itemOf(busy.id))?.state, "dead");
    const vanished = await deadItem(orgB.organizationId, typeAdmin, {
      attempts: 3,
      status: "dispatched",
    });
    await owner.pool.query("DELETE FROM public.event_outbox WHERE id = $1", [
      vanished.id,
    ]);
    assert.equal(
      await adminRetry(vanished.incident, vanished.id, "tentativa"),
      "event_gone"
    );
    assert.equal(
      (await auditsOf(vanished.id))[0]?.detail,
      "result=event_gone; reason=tentativa"
    );
    assert.equal(
      await countOf(
        "SELECT count(*)::text AS count FROM public.platform_audit_events WHERE event_type = 'operational_incident.retry'"
      ),
      auditCountBefore + 5,
      "five audited retries in all: retried, repeat, retried, busy, event_gone"
    );
    tests.push(
      "admin_retry_dead_letter, success: one audit row (event_type operational_incident.retry, entity_type queue_dead_letter, entity_id the event, the event's organization, no support case, the operator, detail 'result=retried; reason=<trimmed reason>' within 200 characters) in the same transaction as the retry; a repeat answers already_pending, audits too and changes no count; a 150-character reason fits the detail; busy and event_gone are audited with their result and change nothing"
    );

    // the list
    for (const limit of [0, 51, -1]) {
      await expectError(
        () => listOperationalIncidents(adminClient, { after: null, limit }),
        "22023",
        "invalid page size",
        `a page of ${limit} is refused`
      );
      await expectError(
        () =>
          readOperationalIncident(adminClient, x.incident, {
            after: null,
            limit,
          }),
        "22023",
        "invalid page size",
        `an incident page of ${limit} is refused`
      );
    }
    await expectError(
      () =>
        adminClient.query(
          "SELECT public.admin_list_operational_incidents(NULL, NULL)"
        ),
      "22023",
      "invalid page size",
      "a null page size is refused"
    );
    const allIncidents = (
      await owner.pool.query<{ id: string }>(
        "SELECT id FROM public.operational_incidents ORDER BY id DESC"
      )
    ).rows.map((row) => row.id);
    assert.ok(allIncidents.length > 8);
    const pageOne = await listOperationalIncidents(adminClient, {
      after: null,
      limit: 3,
    });
    assert.deepEqual(
      pageOne.incidents.map((row) => row.id),
      allIncidents.slice(0, 3),
      "newest first"
    );
    assert.equal(pageOne.next, allIncidents[2], "next is the last ID shown");
    const pageTwo = await listOperationalIncidents(adminClient, {
      after: pageOne.next,
      limit: 3,
    });
    assert.deepEqual(
      pageTwo.incidents.map((row) => row.id),
      allIncidents.slice(3, 6)
    );
    const walked: Awaited<
      ReturnType<typeof listOperationalIncidents>
    >["incidents"] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: Awaited<ReturnType<typeof listOperationalIncidents>> =
        await listOperationalIncidents(adminClient, {
          after: cursor,
          limit: 50,
        });
      walked.push(...page.incidents);
      cursor = page.next;
      pages += 1;
      assert.ok(pages < 1000);
    } while (cursor);
    assert.deepEqual(
      walked.map((row) => row.id),
      allIncidents,
      "walking the pages gives every incident once, newest first, and the last page has no next"
    );
    const exactLimit = await listOperationalIncidents(adminClient, {
      after: null,
      limit: 50,
    });
    assert.equal(
      exactLimit.next === null,
      allIncidents.length <= 50,
      "next exists only when there are more"
    );
    for (const row of walked) {
      assert.deepEqual(
        Object.keys(row).sort(),
        [...INCIDENT_KEYS, "deadEvents"].sort()
      );
      assert.equal(typeof row.occurrenceCount, "number");
      assert.equal(typeof row.deadEvents, "number");
    }
    const dead = await owner.pool.query<{ dead: string; id: string }>(
      "SELECT incident.id, (SELECT count(*)::text FROM public.queue_dead_letters item WHERE item.incident_id = incident.id AND item.state = 'dead') AS dead FROM public.operational_incidents incident"
    );
    const deadById = new Map(
      dead.rows.map((row) => [row.id, Number(row.dead)])
    );
    for (const row of walked) {
      assert.equal(
        row.deadEvents,
        deadById.get(row.id),
        `deadEvents of ${row.subject} counts only the dead items`
      );
    }
    const typeAdminIncident = walked.find((row) => row.subject === typeAdmin);
    assert.ok(typeAdminIncident);
    assert.equal(typeAdminIncident.kind, "queue_dead_letter");
    assert.equal(typeAdminIncident.cause, "retries_exhausted");
    assert.equal(
      typeAdminIncident.deadEvents,
      3,
      "busy, event_gone and the atomic-cap one are still dead; the retried one is not"
    );
    assert.equal(typeAdminIncident.occurrenceCount, 4);
    assert.equal(
      listBody(walked).includes(bodyMarker),
      false,
      "the list carries no body"
    );
    tests.push(
      "admin_list_operational_incidents: a page size of 0, 51, -1 or null is refused with 22023; pages come newest first with next equal to the last ID shown (null on the last page); walking the pages gives exactly every incident once; each row has exactly the nine fields; deadEvents counts only the items still dead (retried ones are not counted); no event body appears"
    );

    // the detail
    const typeDetail = typeName("detail");
    const detailItems: { id: string }[] = [];
    for (let index = 0; index < 5; index += 1) {
      detailItems.push(
        await deadItem(
          index % 2 === 0 ? orgA.organizationId : orgB.organizationId,
          typeDetail,
          {
            attempts: 2,
            status: "dispatched",
          }
        )
      );
    }
    const detailIncident = (await itemOf(detailItems[0]?.id as string))
      ?.incident_id as string;
    await adminRetry(detailIncident, detailItems[1]?.id as string, "um motivo");
    const itemRows = (
      await owner.pool.query<{ event_id: string }>(
        "SELECT event_id FROM public.queue_dead_letters WHERE incident_id = $1 ORDER BY event_id DESC",
        [detailIncident]
      )
    ).rows.map((row) => row.event_id);
    assert.equal(itemRows.length, 5);
    const detailPage1 = await readOperationalIncident(
      adminClient,
      detailIncident,
      {
        after: null,
        limit: 2,
      }
    );
    assert.ok(detailPage1);
    assert.equal(detailPage1.incident.id, detailIncident);
    assert.equal(detailPage1.incident.subject, typeDetail);
    assert.equal(detailPage1.incident.occurrenceCount, 5);
    assert.deepEqual(Object.keys(detailPage1.incident).sort(), INCIDENT_KEYS);
    assert.deepEqual(
      detailPage1.events.map((row) => row.eventId),
      itemRows.slice(0, 2),
      "the events come newest ID first"
    );
    assert.equal(detailPage1.next, itemRows[1]);
    const detailPage2 = await readOperationalIncident(
      adminClient,
      detailIncident,
      {
        after: detailPage1.next,
        limit: 2,
      }
    );
    const detailPage3 = await readOperationalIncident(
      adminClient,
      detailIncident,
      {
        after: detailPage2?.next ?? null,
        limit: 2,
      }
    );
    assert.deepEqual(
      [
        detailPage2?.events.map((row) => row.eventId),
        detailPage3?.events.map((row) => row.eventId),
      ],
      [itemRows.slice(2, 4), itemRows.slice(4)]
    );
    assert.equal(detailPage2?.next, itemRows[3]);
    assert.equal(detailPage3?.next, null, "the last page has no next");
    const allDetail = await readOperationalIncident(
      adminClient,
      detailIncident,
      {
        after: null,
        limit: 50,
      }
    );
    assert.equal(allDetail?.events.length, 5);
    assert.equal(allDetail?.next, null);
    for (const row of allDetail?.events ?? []) {
      assert.deepEqual(Object.keys(row).sort(), EVENT_KEYS);
      assert.equal(row.eventType, typeDetail);
      assert.ok(
        [orgA.organizationId, orgB.organizationId].includes(row.organizationId)
      );
    }
    const retriedDetail = allDetail?.events.find(
      (row) => row.eventId === detailItems[1]?.id
    );
    assert.equal(retriedDetail?.state, "retried");
    assert.equal(retriedDetail?.retryCount, 1);
    assert.ok(retriedDetail?.retriedAt);
    assert.equal(
      allDetail?.events.filter((row) => row.state === "dead").length,
      4
    );
    assert.equal(
      await readOperationalIncident(adminClient, randomUUID(), {
        after: null,
        limit: 10,
      }),
      null,
      "an incident that does not exist is null"
    );
    const detailText = JSON.stringify(allDetail);
    for (const secret of [
      bodyMarker,
      (await makeEvent(orgA.organizationId, typeName("probe"))).key.slice(
        0,
        20
      ),
      "idempotency",
      "correlation",
      "payload",
      "body",
    ]) {
      assert.equal(
        detailText.includes(secret),
        false,
        `the detail does not carry ${secret}`
      );
    }
    tests.push(
      "admin_read_operational_incident: returns the incident (exactly eight fields) and its events newest ID first in pages (limit 2 over five events gives 2, 2, 1 with next set on the first two and null on the last), each with exactly nine fields (IDs, type, state, counts, dates); a retried item shows state retried, retryCount and retriedAt; an incident that does not exist is null; a page size outside 1..50 is refused with 22023; no event body, key or correlation appears anywhere in the answer"
    );

    // ------------------------------------------------- 7. the incident has no organization (the purge removes the items in its own PR)
    const typeScope = typeName("scope");
    const keepA = await deadItem(orgA.organizationId, typeScope, {
      attempts: 2,
      status: "dispatched",
    });
    const itemC1 = await deadItem(orgC.organizationId, typeScope, {
      attempts: 2,
      status: "dispatched",
    });
    const itemC2 = await deadItem(orgC.organizationId, typeScope, {
      attempts: 1000,
    });
    assert.equal(keepA.incident, itemC1.incident);
    const scopeIncident = await incidentOf(
      "queue_dead_letter",
      "retries_exhausted",
      typeScope
    );
    assert.equal(scopeIncident?.occurrence_count, "3");
    // no role holds DELETE on the item table here (checked in section 1), and the purge keeps the
    // organization row as a tombstone, so the foreign key cascade never fires for it: the purge has
    // to delete the items itself, with a policy and DELETE grant of its role (the purge PR proves it)
    assert.equal(
      await countOf(
        "SELECT count(*)::text AS count FROM public.queue_dead_letters WHERE organization_id = $1",
        [orgC.organizationId]
      ),
      2,
      "the organization's dead events stay until the purge deletes them itself"
    );
    assert.equal(
      (await itemOf(keepA.id))?.state,
      "dead",
      "another organization's item is untouched"
    );
    const incidentColumns = await owner.pool.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'operational_incidents' AND column_name LIKE '%organization%'"
    );
    assert.deepEqual(
      incidentColumns.rows,
      [],
      "an incident has no organization"
    );
    const incidentText = (
      await owner.pool.query<{ text: string }>(
        "SELECT row_to_json(incident)::text AS text FROM public.operational_incidents incident WHERE subject = $1",
        [typeScope]
      )
    ).rows[0]?.text as string;
    assert.equal(incidentText.includes(orgC.organizationId), false);
    assert.equal(incidentText.includes(orgC.userId), false);
    assert.equal(
      incidentText.includes(itemC2.id),
      true,
      "the incident keeps only the last opaque reference (an event ID)"
    );
    const detail = await readOperationalIncident(
      adminClient,
      scopeIncident?.id as string,
      {
        after: null,
        limit: 10,
      }
    );
    assert.deepEqual(
      detail?.events.map((row) => row.eventId).sort(),
      [keepA.id, itemC1.id, itemC2.id].sort(),
      "the Admin's detail lists the items of both organizations, by event ID only"
    );
    tests.push(
      "no organization in the incident: an incident has no organization column and holds only the opaque reference (no organization or user ID); the items of an organization stay until the purge deletes them itself (no role here holds DELETE, and the purge keeps the organization row, so the foreign key cascade does not fire: the purge PR adds the policy and the DELETE grant of its role and proves the removal); another organization's item is untouched; the Admin's detail lists the items by event ID only"
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
  } catch (error) {
    primaryFailure = true;
    throw error;
  } finally {
    for (const close of closers.reverse()) {
      await close().catch(() => undefined);
    }
    const cleanup = async (
      label: string,
      text: string,
      values: unknown[] = []
    ) => {
      try {
        await owner.pool.query(text, values);
      } catch (error) {
        cleanupFailures.push(`${label} (${redactedFailure(error)})`);
      }
    };
    await cleanup(
      "audit trigger",
      "DROP TRIGGER IF EXISTS gate_dlq_block_audit ON public.platform_audit_events"
    );
    await cleanup(
      "audit trigger function",
      "DROP FUNCTION IF EXISTS public.gate_dlq_block_audit()"
    );
    // test teardown only (superuser): the throwaway organizations take their events, dead events and processing records with them
    for (const tenant of fixtures) {
      await cleanup(
        "organization",
        "DELETE FROM public.organizations WHERE id = $1",
        [tenant.organizationId]
      );
      await cleanup("user", 'DELETE FROM public."user" WHERE id = $1', [
        tenant.userId,
      ]);
    }
    await cleanup(
      "incidents",
      "DELETE FROM public.operational_incidents WHERE subject LIKE $1 OR (subject = 'unknown' AND id <> ALL($2::uuid[]))",
      [`gate\\_dlq.%${suffix}`, unknownBefore]
    );
    for (const [role, group] of logins) {
      await cleanup("revoke", `REVOKE "${group}" FROM "${role}"`);
      await cleanup("role", `DROP ROLE IF EXISTS "${role}"`);
    }
    await owner.pool.end();
    if (cleanupFailures.length > 0) {
      console.error(
        `Dead-letter gate cleanup failed: ${cleanupFailures.join("; ")}`
      );
      if (!primaryFailure) {
        process.exitCode = 1;
      }
    }
  }
}

function listBody(value: unknown) {
  return JSON.stringify(value);
}

run().catch((error: unknown) => {
  console.error(
    `Dead-letter PostgreSQL gate failed (${redactedFailure(error)})`
  );
  process.exitCode = 1;
});
