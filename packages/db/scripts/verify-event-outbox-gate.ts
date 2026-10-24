import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { InvalidExportRequestError } from "@polaris/domain/privacy/data-export";
import { InvalidOutboxEventError } from "@polaris/domain/events/outbox";
import { createDatabase } from "../src/client";
import { requestDataExport } from "../src/data-export-repository";
import { recordOutboxEvent } from "../src/event-outbox";
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
  withRuntimeSqlContext,
  withTenantAs,
} from "./sales-gate-support";

/**
 * The transactional outbox on a real PostgreSQL 18 (plan PR108, ADR 0082): requesting a data export
 * writes one `data_export.requested` event in the same transaction, holding only opaque IDs and the
 * correlation of the request; a repeated key writes nothing; the table is insert-only for the tenant
 * runtime, in its own organization and only for the listed types (with exactly the body keys of the type),
 * and only the dispatcher's, the privacy and the purge owners read or move it (the purge owner also deletes,
 * for an organization whose purge was scheduled); the database refuses a body that could hold a person's data.
 */
const expectedDatabase =
  process.env.POLARIS_GATE_DATABASE ??
  process.env.POLARIS_SALES_GATE_DATABASE ??
  "neondb";

const OUTBOX_COLUMNS = [
  "attempts",
  "available_at",
  "correlation_id",
  "created_at",
  "dispatched_at",
  "event",
  "id",
  "idempotency_key",
  "locked_until",
  "organization_id",
  "status",
  "type",
];
const INSERTABLE_COLUMNS = [
  "correlation_id",
  "event",
  "idempotency_key",
  "organization_id",
  "type",
];
// the owners that move the events (the outbox owner, and the privacy owner for the re-arm) are proved
// by the outbox-dispatcher gate; these roles hold nothing here
const OTHER_ROLES = [
  "polaris_billing_runtime",
  "polaris_catalog_runtime",
  "polaris_admin_runtime",
  "polaris_admin_owner",
  "polaris_privacy_runtime",
  "polaris_outbox_runtime",
];

const ROLLED_BACK_ON_PURPOSE = /rolled back on purpose/;
const UUID_TEXT = /^[0-9a-f-]{36}$/;

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
  let runtime: ReturnType<typeof createDatabase> | undefined;

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
      "SELECT count(*) AS count FROM drizzle.__drizzle_migrations"
    );
    assert.equal(Number(migrations.rows[0]?.count), journalMigrationCount());
    tests.push(
      "disposable direct Neon connection is PostgreSQL 18 with every migration replayed from scratch"
    );

    const role = `polaris_outbox_${randomUUID().replaceAll("-", "")}`;
    const password = randomBytes(24).toString("hex");
    await owner.pool.query(
      `CREATE ROLE "${role}" WITH LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`
    );
    await owner.pool.query(`GRANT "${runtimeRole}" TO "${role}"`);
    logins.push([role, runtimeRole]);
    const tenantUrl = temporaryRuntimeUrl(adminUrl, role, password);
    runtime = createDatabase(tenantUrl, { maxConnections: 2 });
    const { db } = runtime;

    const suffix = randomUUID().slice(0, 8);
    const tenantA = await createTenantFixture(
      owner.pool,
      `outbox A ${suffix}`,
      "America/Sao_Paulo",
      "pro"
    );
    const tenantB = await createTenantFixture(
      owner.pool,
      `outbox B ${suffix}`,
      "America/Sao_Paulo",
      "pro"
    );
    const asTenant = <T>(
      tenant: TenantFixture,
      capability: string,
      operation: Parameters<typeof withTenantAs<T>>[3]
    ) => withTenantAs(db, tenant, capability, operation);
    const ask = (
      tenant: TenantFixture,
      trace: string | null,
      capability = "organization:export"
    ) =>
      asTenant(tenant, capability, (transaction, identity) =>
        requestDataExport(transaction, identity, {
          formats: ["json"],
          requestId: trace,
        })
      );
    // other gates share the database: only this gate's organizations are counted
    const outboxRows = async (...organizationIds: string[]) =>
      (
        await owner.pool.query(
          `SELECT to_jsonb(event_outbox) AS row, type, event, status, attempts, idempotency_key, correlation_id, available_at, created_at
             FROM public.event_outbox WHERE organization_id = ANY($1::text[])
            ORDER BY created_at, id`,
          [
            organizationIds.length > 0
              ? organizationIds
              : [tenantA.organizationId, tenantB.organizationId],
          ]
        )
      ).rows;

    // ------------------------------------------------- 1. what an event is
    const columns = await owner.pool.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'event_outbox' ORDER BY column_name"
    );
    assert.deepEqual(
      columns.rows.map((row) => row.column_name),
      OUTBOX_COLUMNS,
      "the table has the plan's fields and no column for a name, a contact or a note"
    );
    const foreignKeys = await owner.pool.query<{
      confdeltype: string;
      target: string;
    }>(
      "SELECT confdeltype, confrelid::regclass::text AS target FROM pg_constraint WHERE conrelid = 'public.event_outbox'::regclass AND contype = 'f'"
    );
    assert.deepEqual(
      foreignKeys.rows,
      [{ confdeltype: "c", target: "organizations" }],
      "the events go with their organization when it is deleted (the purge deletes them in a step of its own, ADR 0081)"
    );
    tests.push(
      "the table has the plan's fields (event, type, status, available_at, attempts, idempotency, correlation) and its only foreign key is the organization, ON DELETE CASCADE"
    );

    // ------------------------------------------------- 2. requesting an export writes one event, in the same transaction
    assert.deepEqual(await outboxRows(), []);
    await assert.rejects(() => ask(tenantA, randomUUID(), "customer:update"));
    assert.deepEqual(
      await outboxRows(),
      [],
      "a refused request (no capability) leaves no event"
    );

    const requestId = randomUUID();
    const before = Date.now();
    const exportA = await ask(tenantA, requestId);
    const rows = await outboxRows(tenantA.organizationId);
    assert.equal(rows.length, 1, "one request, one event");
    const [event] = rows;
    assert.ok(event);
    assert.equal(event.type, "data_export.requested");
    assert.deepEqual(event.event, { exportId: exportA.id });
    assert.equal(event.status, "pending");
    assert.equal(event.attempts, 0);
    assert.equal(event.idempotency_key, `data_export.requested:${exportA.id}`);
    assert.equal(event.correlation_id, requestId, "the request's trace");
    assert.ok(
      new Date(event.available_at).getTime() >= before - 60_000 &&
        new Date(event.available_at).getTime() <= Date.now() + 60_000,
      "available as of its creation"
    );
    assert.deepEqual(
      await outboxRows(tenantB.organizationId),
      [],
      "another organization has none"
    );
    const text = JSON.stringify(event.row);
    assert.ok(
      !text.includes(tenantA.userId),
      "not even the user's ID is in the event"
    );

    await assert.rejects(
      () =>
        asTenant(
          tenantB,
          "organization:export",
          async (transaction, identity) => {
            await requestDataExport(transaction, identity, {
              formats: ["json"],
              requestId: randomUUID(),
            });
            throw new Error("rolled back on purpose");
          }
        ),
      ROLLED_BACK_ON_PURPOSE
    );
    assert.deepEqual(
      await outboxRows(tenantB.organizationId),
      [],
      "when the transaction rolls back, the request and its event both go"
    );
    const none = await owner.pool.query(
      "SELECT 1 FROM public.data_exports WHERE organization_id = $1",
      [tenantB.organizationId]
    );
    assert.equal(none.rowCount, 0);

    await assert.rejects(
      () => ask(tenantA, randomUUID()),
      InvalidExportRequestError,
      "one export at a time"
    );
    assert.equal(
      (await outboxRows(tenantA.organizationId)).length,
      1,
      "a refused request (one already running) leaves no second event"
    );
    const noTrace = await ask(tenantB, null);
    const [traceless] = await outboxRows(tenantB.organizationId);
    assert.ok(traceless);
    assert.equal(
      traceless.idempotency_key,
      `data_export.requested:${noTrace.id}`
    );
    assert.match(
      traceless.correlation_id,
      UUID_TEXT,
      "a request without a trace starts one"
    );
    tests.push(
      "requesting an export writes exactly one pending data_export.requested event (attempts 0, available now) holding only the export's ID, keyed by the type and the ID, with the request's correlation (or a new one); a refused request (no capability, one already running) writes none; when the transaction rolls back, neither the request nor the event remain"
    );

    // ------------------------------------------------- 3. the same key writes once
    for (const times of [1, 2]) {
      // biome-ignore lint/performance/noAwaitInLoops: The same statement twice, in order.
      await asTenant(tenantA, "organization:export", (transaction, identity) =>
        recordOutboxEvent(transaction, {
          event: { exportId: exportA.id },
          idempotencyKey: `data_export.requested:${exportA.id}`,
          organizationId: identity.organizationId,
          type: "data_export.requested",
        })
      );
      assert.equal(
        (await outboxRows(tenantA.organizationId)).length,
        1,
        `the statement run ${times} time(s) leaves one event`
      );
    }
    const [kept] = await outboxRows(tenantA.organizationId);
    assert.ok(kept);
    assert.equal(
      kept.correlation_id,
      requestId,
      "the repeat did not overwrite the original"
    );
    await assert.rejects(
      () =>
        asTenant(tenantA, "organization:export", (transaction, identity) =>
          recordOutboxEvent(transaction, {
            event: { exportId: exportA.id, owner: "maria@example.com" },
            idempotencyKey: "data_export.requested:other",
            organizationId: identity.organizationId,
            type: "data_export.requested",
          })
        ),
      InvalidOutboxEventError,
      "the helper refuses text before touching the database"
    );
    tests.push(
      "the same idempotency key written again is a no-op (one event, the first one kept); the helper refuses a body with free text before touching the database"
    );

    // ------------------------------------------------- 4. insert-only, in its own organization, for the listed types
    const attempt = (
      tenant: TenantFixture,
      sql: string,
      values: unknown[] = []
    ) =>
      withRuntimeSqlContext(tenantUrl, tenant, (client) =>
        client.query(sql, values)
      );
    const insertEvent =
      "INSERT INTO public.event_outbox (organization_id, type, event, idempotency_key, correlation_id) VALUES ($1, $2, $3::jsonb, $4, $5)";
    const good = (key: string) => [
      tenantA.organizationId,
      "data_export.requested",
      JSON.stringify({ exportId: exportA.id }),
      key,
      "trace-1",
    ];
    for (const [statement, label] of [
      ["SELECT * FROM public.event_outbox", "reads"],
      ["UPDATE public.event_outbox SET status = 'dispatched'", "updates"],
      ["DELETE FROM public.event_outbox", "deletes"],
      ["TRUNCATE public.event_outbox", "truncates"],
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: Probes, in order.
      await expectSqlState(
        () => attempt(tenantA, statement as string),
        "42501",
        `the tenant runtime ${label} nothing`
      );
    }
    await expectSqlState(
      () =>
        attempt(
          tenantA,
          "INSERT INTO public.event_outbox (organization_id, type, event, idempotency_key, correlation_id, status) VALUES ($1, 'data_export.requested', '{}', 'k-status', 'c', 'dispatched')",
          [tenantA.organizationId]
        ),
      "42501",
      "the tenant runtime cannot choose the status"
    );
    for (const column of ["attempts", "available_at", "created_at", "id"]) {
      // biome-ignore lint/performance/noAwaitInLoops: Probes, in order.
      await expectSqlState(
        () =>
          attempt(
            tenantA,
            `INSERT INTO public.event_outbox (organization_id, type, event, idempotency_key, correlation_id, ${column}) VALUES ($1, 'data_export.requested', '{}', 'k-${column}', 'c', DEFAULT)`,
            [tenantA.organizationId]
          ),
        "42501",
        `the tenant runtime cannot name ${column}`
      );
    }
    await expectSqlState(
      () =>
        attempt(tenantA, insertEvent, [
          tenantB.organizationId,
          "data_export.requested",
          "{}",
          "k-foreign",
          "c",
        ]),
      "42501",
      "no event under another organization"
    );
    await expectSqlState(
      () =>
        attempt(tenantA, insertEvent, [
          tenantA.organizationId,
          "organization.purged",
          "{}",
          "k-type",
          "c",
        ]),
      "42501",
      "no event of a type the policy does not list"
    );
    await expectSqlState(
      () => attempt(tenantA, insertEvent, good(kept.idempotency_key)),
      "23505",
      "a key is written once",
      "event_outbox_idempotency_unique"
    );
    // the event has to be about an export that this user asked for in this organization, and its key is
    // the type and that export's ID: a forged event for another's export, or with a free key, is refused
    const exportB = await owner.pool.query<{ id: string }>(
      "SELECT id FROM public.data_exports WHERE organization_id = $1",
      [tenantB.organizationId]
    );
    const foreignExport = exportB.rows[0]?.id;
    assert.ok(foreignExport);
    await expectSqlState(
      () =>
        attempt(tenantA, insertEvent, [
          tenantA.organizationId,
          "data_export.requested",
          JSON.stringify({ exportId: foreignExport }),
          `data_export.requested:${foreignExport}`,
          "c",
        ]),
      "42501",
      "no event for another organization's export"
    );
    await expectSqlState(
      () =>
        attempt(tenantA, insertEvent, [
          tenantA.organizationId,
          "data_export.requested",
          JSON.stringify({ exportId: randomUUID() }),
          `data_export.requested:${randomUUID()}`,
          "c",
        ]),
      "42501",
      "no event for an export that does not exist"
    );
    await expectSqlState(
      () =>
        attempt(tenantA, insertEvent, [
          tenantA.organizationId,
          "data_export.requested",
          JSON.stringify({ exportId: exportA.id }),
          "a-free-key",
          "c",
        ]),
      "42501",
      "no event whose key is not the type and the export's ID"
    );
    // the body holds exactly the keys of its type: an extra key is refused even with a valid ID (the
    // policy, not the unique index: that would be 23505)
    for (const extra of [
      { exportId: exportA.id, saleId: randomUUID() },
      { exportId: exportA.id, files: 3 },
      { exportId: exportA.id, retry: false },
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: each probe is its own refused statement.
      await expectSqlState(
        () =>
          attempt(tenantA, insertEvent, [
            tenantA.organizationId,
            "data_export.requested",
            JSON.stringify(extra),
            `data_export.requested:${exportA.id}`,
            "c",
          ]),
        "42501",
        "no key in the body beyond the ones its type declares"
      );
    }
    // a second member of the same organization cannot write an event for the export of the first
    const secondUser = randomUUID();
    await owner.pool.query(
      'INSERT INTO public."user" (id, name, email, email_verified) VALUES ($1, $2, $3, true)',
      [
        secondUser,
        `outbox second ${suffix}`,
        `outbox-${secondUser}@example.invalid`,
      ]
    );
    await owner.pool.query(
      "INSERT INTO public.memberships (organization_id, user_id, role, status) VALUES ($1, $2, 'owner', 'active')",
      [tenantA.organizationId, secondUser]
    );
    await expectSqlState(
      () =>
        withRuntimeSqlContext(
          tenantUrl,
          { organizationId: tenantA.organizationId, userId: secondUser },
          (client) =>
            client.query(insertEvent, [
              tenantA.organizationId,
              "data_export.requested",
              JSON.stringify({ exportId: exportA.id }),
              `data_export.requested:${exportA.id}`,
              "c",
            ])
        ),
      "42501",
      "no event for an export that another member asked for"
    );
    await expectSqlState(
      () =>
        attempt(tenantA, insertEvent, [
          tenantA.organizationId,
          "data_export.requested",
          "{}",
          "data_export.requested:",
          "c",
        ]),
      "42501",
      "no event that names no export"
    );
    assert.equal((await outboxRows(tenantA.organizationId)).length, 1);

    const privileges = await owner.pool.query<{
      grantee: string;
      privilege: string;
      allowed: boolean;
    }>(
      `SELECT g.grantee, p.privilege, (has_table_privilege(g.grantee, 'public.event_outbox', p.privilege)
                OR (p.privilege IN ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES') AND has_any_column_privilege(g.grantee, 'public.event_outbox', p.privilege))) AS allowed
         FROM (VALUES ('${runtimeRole}'), ${OTHER_ROLES.map((name) => `('${name}')`).join(", ")}, ('polaris_purge_owner')) AS g(grantee)
        CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES')) AS p(privilege)`
    );
    assert.deepEqual(
      privileges.rows
        .filter((row) => row.allowed)
        .map((row) => `${row.grantee}:${row.privilege}`)
        .sort(),
      [
        // the notices of the billing cycle (ADR 0104, 0101): five columns, one type (gate billing-notices)
        "polaris_billing_runtime:INSERT",
        "polaris_purge_owner:DELETE",
        "polaris_purge_owner:SELECT",
        `${runtimeRole}:INSERT`,
      ].sort(),
      "only the tenant runtime and the billing runtime hold a privilege, and it is INSERT; the purge owner reads and deletes, for the organization it purges (ADR 0081)"
    );
    const insertable = await owner.pool.query<{
      column_name: string;
      allowed: boolean;
    }>(
      `SELECT c.column_name, has_column_privilege('${runtimeRole}', 'public.event_outbox', c.column_name, 'INSERT') AS allowed
         FROM information_schema.columns AS c WHERE c.table_schema = 'public' AND c.table_name = 'event_outbox'`
    );
    assert.deepEqual(
      insertable.rows
        .filter((row) => row.allowed)
        .map((row) => row.column_name)
        .sort(),
      INSERTABLE_COLUMNS
    );
    const policies = await owner.pool.query<{ cmd: string; roles: string[] }>(
      "SELECT cmd, roles::text[] AS roles FROM pg_policies WHERE schemaname = 'public' AND tablename = 'event_outbox' ORDER BY cmd, roles::text"
    );
    assert.deepEqual(
      policies.rows.map((row) => [row.cmd, row.roles]),
      [
        ["DELETE", ["polaris_purge_owner"]],
        // the notice of the billing cycle or the welcome (ADR 0104, 0101): its own policy, proved by the gate billing-notices
        ["INSERT", ["polaris_billing_runtime"]],
        ["INSERT", [runtimeRole]],
        // the request of a closed organization's copy (ADR 0081), the cancellation of the renewal at the
        // closure (ADR 0074) and the notice of a closure milestone (ADR 0102), through the privacy owner's functions
        ["INSERT", ["polaris_privacy_owner"]],
        ["INSERT", ["polaris_privacy_owner"]],
        ["INSERT", ["polaris_privacy_owner"]],
        ["SELECT", ["polaris_outbox_owner"]],
        ["SELECT", ["polaris_privacy_owner"]],
        ["SELECT", ["polaris_privacy_owner"]],
        ["SELECT", ["polaris_purge_owner"]],
        ["UPDATE", ["polaris_outbox_owner"]],
        ["UPDATE", ["polaris_privacy_owner"]],
        ["UPDATE", ["polaris_privacy_owner"]],
      ],
      "the tenant only inserts (and the privacy owner, for a closed organization's copy); reads and updates are the owners' (dispatcher and re-arm), through their functions; only the purge owner deletes (ADR 0081)"
    );
    const forced = await owner.pool.query<{ relforcerowsecurity: boolean }>(
      "SELECT relforcerowsecurity FROM pg_class WHERE oid = 'public.event_outbox'::regclass"
    );
    assert.equal(forced.rows[0]?.relforcerowsecurity, true);
    tests.push(
      "the tenant runtime cannot read, update, delete or truncate the outbox and can insert only the five columns of an event (not the status, attempts, times or ID), only in its own organization and only for a type the policy lists; only for an export that the same user asked for in the same organization, with the key the type and that export's ID and no body key beyond the type's (an extra key with a valid ID is refused); a duplicate key is refused by the unique index; no other runtime holds any privilege, only the dispatcher's and the privacy owners have read and update policies, only the purge owner deletes (and reads, for an organization whose purge was scheduled), and row level security is forced"
    );

    // ------------------------------------------------- 5. the database refuses a body that could hold a person's data
    const bodies: [string, string][] = [
      ["an e-mail", JSON.stringify({ owner: "maria.souza@example.com" })],
      ["a name", JSON.stringify({ customer: "Maria Aparecida Souza" })],
      ["a phone", JSON.stringify({ phone: "+55 11 98888-7777" })],
      ["a string longer than an ID", JSON.stringify({ id: "a".repeat(65) })],
      ["an empty string", JSON.stringify({ id: "" })],
      ["a nested object", JSON.stringify({ id: { name: "Maria" } })],
      ["a list", JSON.stringify({ ids: ["a", "b"] })],
      ["a null", JSON.stringify({ id: null })],
      ["a decimal", JSON.stringify({ amount: 1.5 })],
      ["a number beyond the safe integers", '{"amount": 9007199254740993}'],
      ["a line break inside a string", '{"note": "Maria\\nSouza"}'],
      ["a trailing line break", '{"note": "abc\\n"}'],
      [
        "a long string made of line breaks",
        JSON.stringify({ note: "palavra\n".repeat(200) }),
      ],
      ["an accented name", JSON.stringify({ note: "João" })],
      ["a key that is an e-mail", JSON.stringify({ "maria@example.com": 1 })],
      ["a key with spaces", JSON.stringify({ "Maria Souza": true })],
      ["a key in capitals", JSON.stringify({ Export: 1 })],
      [
        "a key longer than 32 characters",
        JSON.stringify({ [`a${"b".repeat(32)}`]: 1 }),
      ],
      [
        "a body past the size limit",
        JSON.stringify(
          Object.fromEntries(
            Array.from({ length: 200 }, (_, index) => [
              `k${index}`,
              "abcdefghij",
            ])
          )
        ),
      ],
    ];
    // the tenant policy refuses any key beyond the type's before a CHECK runs (section 4), so the CHECKs,
    // the defence in depth for every role, are probed as the owner, who passes the policies: every probe
    // names the real export and adds the one thing that must be refused
    const exportKey = `data_export.requested:${exportA.id}`;
    for (const [label, extra] of bodies) {
      // biome-ignore lint/performance/noAwaitInLoops: Probes, in order.
      await expectSqlState(
        () =>
          owner.pool.query(insertEvent, [
            tenantA.organizationId,
            "data_export.requested",
            JSON.stringify({ exportId: exportA.id, ...JSON.parse(extra) }),
            `${exportKey}-${randomUUID().slice(0, 8)}`,
            "c",
          ]),
        "23514",
        `the database refuses ${label}`,
        "event_outbox_event_shape"
      );
    }
    await expectSqlState(
      () =>
        attempt(tenantA, insertEvent, [
          tenantA.organizationId,
          "data_export.requested",
          JSON.stringify({ exportId: exportA.id }),
          exportKey,
          "a b",
        ]),
      "23514",
      "the database refuses a correlation with spaces",
      "event_outbox_tokens_format"
    );
    assert.equal(
      (await outboxRows(tenantA.organizationId)).length,
      1,
      "every probe left the outbox as it was"
    );
    tests.push(
      "the CHECKs refuse a body with an e-mail, a name, a phone with symbols, a string longer than an ID or with a line break, an empty string, an accented name, a nested object, a list, a null, a decimal, an unsafe integer, a body that is too large, a key that is not a short name, and a correlation that is not a token, probed as the owner past the policies (the real events of section 2 show that an ID is accepted)"
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
    await runtime?.pool.end().catch(() => undefined);
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
    `Event outbox PostgreSQL gate failed (${redactedFailure(error)})`
  );
  process.exitCode = 1;
});
