import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CustomerVersionConflictError } from "@polaris/domain/customers/customer";
import { createDatabase } from "../src/client";
import { recordDeletionLedgerEntry } from "../src/deletion-ledger";
import {
  anonymizeCustomerForPrivacy,
  createCustomer,
} from "../src/customer-repository";
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
 * The deletion ledger on a real PostgreSQL 18 (plan PR106, ADR 0080): anonymizing a customer leaves one
 * minimal tombstone, in the same transaction, holding only opaque IDs; the table is append-only for
 * every role and the tenant runtime can write only the tombstone of a customer that is already
 * anonymized in its own organization; nothing ties the ledger to the organization, so it survives the
 * purge; and the query the restore runbook uses lists what to reapply.
 */
const expectedDatabase =
  process.env.POLARIS_GATE_DATABASE ??
  process.env.POLARIS_SALES_GATE_DATABASE ??
  "neondb";

const PII_NAME = "Maria Aparecida Souza";
const PII_PHONE = "+55 11 98888-7777";
const PII_EMAIL = "maria.souza@example.com";
const PII_NOTES = "Prefere atendimento aos sábados; alergia a perfume";
const NOT_OPAQUE = [PII_NAME, PII_EMAIL, PII_PHONE];

const LEDGER_COLUMNS = [
  "entity_id",
  "entity_type",
  "id",
  "operation",
  "organization_id",
  "privacy_case_id",
  "recorded_at",
];

const ROLLED_BACK_ON_PURPOSE = /rolled back on purpose/;
const BACKFILL_STATEMENT = /INSERT INTO "deletion_ledger"[^;]*;/;

const RESTORE_QUERY = `SELECT entity_type, entity_id, operation, organization_id, privacy_case_id, recorded_at
   FROM public.deletion_ledger
  WHERE recorded_at >= $1
  ORDER BY recorded_at, id`;

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
      "SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations"
    );
    assert.equal(Number(migrations.rows[0]?.count), journalMigrationCount());
    tests.push(
      "disposable direct Neon connection is PostgreSQL 18 with every migration replayed from scratch"
    );

    const role = `polaris_ledger_${randomUUID().replaceAll("-", "")}`;
    const password = randomBytes(24).toString("hex");
    await owner.pool.query(
      `CREATE ROLE "${role}" WITH LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`
    );
    await owner.pool.query(`GRANT "${runtimeRole}" TO "${role}"`);
    logins.push([role, runtimeRole]);
    const tenantUrl = temporaryRuntimeUrl(adminUrl, role, password);
    runtime = createDatabase(tenantUrl, { maxConnections: 2 });
    const { db } = runtime;

    const tenantA = await createTenantFixture(owner.pool, "ledger A");
    const tenantB = await createTenantFixture(owner.pool, "ledger B");
    const asTenant = <T>(
      tenant: TenantFixture,
      capability: string,
      operation: Parameters<typeof withTenantAs<T>>[3]
    ) => withTenantAs(db, tenant, capability, operation);
    const newCustomer = (tenant: TenantFixture) =>
      asTenant(tenant, "customer:update", (transaction, identity) =>
        createCustomer(transaction, identity, {
          email: PII_EMAIL,
          name: PII_NAME,
          notes: PII_NOTES,
          phone: PII_PHONE,
          requestId: randomUUID(),
        })
      );
    const anonymize = (
      tenant: TenantFixture,
      id: string,
      expectedVersion: number,
      capability = "customer:anonymize"
    ) =>
      asTenant(tenant, capability, (transaction, identity) =>
        anonymizeCustomerForPrivacy(transaction, identity, {
          expectedVersion,
          id,
          requestId: randomUUID(),
        })
      );
    // other gates share the database: only this gate's two organizations are counted
    const ledgerRows = async (...organizationIds: string[]) =>
      (
        await owner.pool.query(
          `SELECT to_jsonb(deletion_ledger) AS row, entity_type, entity_id, operation, organization_id, privacy_case_id, recorded_at
             FROM public.deletion_ledger WHERE organization_id = ANY($1::text[])
            ORDER BY recorded_at, id`,
          [
            organizationIds.length > 0
              ? organizationIds
              : [tenantA.organizationId, tenantB.organizationId],
          ]
        )
      ).rows;

    // ------------------------------------------------- 1. what a tombstone is
    const columns = await owner.pool.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'deletion_ledger' ORDER BY column_name"
    );
    assert.deepEqual(
      columns.rows.map((row) => row.column_name),
      LEDGER_COLUMNS,
      "the table has no column that could hold a name, a contact, a note or a business value"
    );
    const constraints = await owner.pool.query<{ contype: string }>(
      "SELECT contype FROM pg_constraint WHERE conrelid = 'public.deletion_ledger'::regclass AND contype IN ('f')"
    );
    assert.equal(
      constraints.rows.length,
      0,
      "no foreign key to the organization or to the record: the ledger outlives both"
    );
    tests.push(
      "the table holds only opaque IDs, the kind of record and operation, the case and the time, and has no foreign key, so it outlives the organization and the record"
    );

    // ------------------------------------------------- 2. anonymizing writes it, once, with nothing personal
    const customer = await newCustomer(tenantA);
    const bystander = await newCustomer(tenantA);
    const foreign = await newCustomer(tenantB);
    assert.deepEqual(await ledgerRows(tenantA.organizationId), []);

    await assert.rejects(
      () => anonymize(tenantA, customer.id, customer.version + 5),
      CustomerVersionConflictError
    );
    await assert.rejects(() =>
      anonymize(tenantA, customer.id, customer.version, "customer:update")
    );
    await assert.rejects(() => anonymize(tenantA, foreign.id, foreign.version));
    assert.deepEqual(
      await ledgerRows(),
      [],
      "a refused anonymization (stale version, no capability, another organization's customer) leaves no tombstone"
    );

    const before = Date.now();
    const done = await anonymize(tenantA, customer.id, customer.version);
    assert.equal(done.changed, true);
    const rows = await ledgerRows(tenantA.organizationId);
    assert.equal(rows.length, 1, "one anonymization, one tombstone");
    const [tombstone] = rows;
    assert.ok(tombstone);
    assert.equal(tombstone.entity_type, "customer");
    assert.equal(tombstone.entity_id, customer.id);
    assert.equal(tombstone.operation, "anonymize");
    assert.equal(tombstone.organization_id, tenantA.organizationId);
    assert.equal(tombstone.privacy_case_id, null);
    assert.ok(
      new Date(tombstone.recorded_at).getTime() >= before - 60_000,
      "the tombstone carries the time it was written"
    );
    const text = JSON.stringify(tombstone.row).toLowerCase();
    for (const secret of [
      PII_NAME,
      PII_PHONE,
      PII_EMAIL,
      PII_NOTES,
      "aparecida",
      "maria",
      "sábados",
    ]) {
      assert.ok(
        !text.includes(secret.toLowerCase()),
        "the tombstone holds nothing of the person"
      );
    }
    assert.deepEqual(
      await ledgerRows(tenantB.organizationId),
      [],
      "another organization has none"
    );
    tests.push(
      "anonymizing a customer writes exactly one tombstone (customer, its ID, anonymize, the organization, no case, the time) and none of the person's data appears in it; a refused anonymization (stale version, missing capability, another organization's customer) writes none"
    );

    // ------------------------------------------------- 3. again, and atomic with the removal
    const again = await anonymize(tenantA, customer.id, 1);
    assert.equal(again.changed, false);
    assert.equal(
      (await ledgerRows(tenantA.organizationId)).length,
      1,
      "a second anonymization is a no-op and writes no second tombstone"
    );
    await assert.rejects(
      () =>
        asTenant(
          tenantA,
          "customer:anonymize",
          async (transaction, identity) => {
            await anonymizeCustomerForPrivacy(transaction, identity, {
              expectedVersion: bystander.version,
              id: bystander.id,
            });
            throw new Error("rolled back on purpose");
          }
        ),
      ROLLED_BACK_ON_PURPOSE
    );
    const stillThere = await owner.pool.query<{ anonymized_at: Date | null }>(
      "SELECT anonymized_at FROM public.customers WHERE id = $1",
      [bystander.id]
    );
    assert.equal(stillThere.rows[0]?.anonymized_at, null);
    assert.equal(
      (await ledgerRows(tenantA.organizationId)).length,
      1,
      "the tombstone and the anonymization stand or fall together"
    );
    tests.push(
      "a second anonymization writes no second tombstone; when the transaction rolls back, neither the anonymization nor its tombstone remain"
    );

    // ------------------------------------------------- 4. append-only, and what the tenant runtime may write
    const attempt = (
      tenant: TenantFixture,
      sql: string,
      values: unknown[] = []
    ) =>
      withRuntimeSqlContext(tenantUrl, tenant, (client) =>
        client.query(sql, values)
      );
    const insertTombstone =
      "INSERT INTO public.deletion_ledger (organization_id, entity_type, entity_id, operation) VALUES ($1, $2, $3, $4)";
    await expectSqlState(
      () => attempt(tenantA, "SELECT * FROM public.deletion_ledger"),
      "42501",
      "the tenant runtime reads nothing from the ledger"
    );
    await expectSqlState(
      () =>
        attempt(
          tenantA,
          "UPDATE public.deletion_ledger SET operation = 'anonymize'"
        ),
      "42501",
      "the tenant runtime updates nothing"
    );
    await expectSqlState(
      () => attempt(tenantA, "DELETE FROM public.deletion_ledger"),
      "42501",
      "the tenant runtime deletes nothing"
    );
    await expectSqlState(
      () => attempt(tenantA, "TRUNCATE public.deletion_ledger"),
      "42501",
      "the tenant runtime truncates nothing"
    );
    // a forged tombstone for a customer that was not anonymized would, on a restore, anonymize a real person
    await expectSqlState(
      () =>
        attempt(tenantA, insertTombstone, [
          tenantA.organizationId,
          "customer",
          bystander.id,
          "anonymize",
        ]),
      "42501",
      "no tombstone for a customer that is not anonymized"
    );
    await expectSqlState(
      () =>
        attempt(tenantA, insertTombstone, [
          tenantA.organizationId,
          "customer",
          randomUUID(),
          "anonymize",
        ]),
      "42501",
      "no tombstone for a record that does not exist"
    );
    const foreignDone = await anonymize(tenantB, foreign.id, foreign.version);
    assert.equal(foreignDone.changed, true);
    await expectSqlState(
      () =>
        attempt(tenantA, insertTombstone, [
          tenantA.organizationId,
          "customer",
          foreign.id,
          "anonymize",
        ]),
      "42501",
      "no tombstone for another organization's customer under this organization"
    );
    await expectSqlState(
      () =>
        attempt(tenantA, insertTombstone, [
          tenantB.organizationId,
          "customer",
          foreign.id,
          "anonymize",
        ]),
      "42501",
      "no tombstone under another organization"
    );
    await expectSqlState(
      () =>
        attempt(tenantA, insertTombstone, [
          tenantA.organizationId,
          "organization",
          tenantA.organizationId,
          "purge",
        ]),
      "42501",
      "the tenant runtime cannot write a purge tombstone"
    );
    await expectSqlState(
      () =>
        attempt(
          tenantA,
          "INSERT INTO public.deletion_ledger (organization_id, entity_type, entity_id, operation, privacy_case_id) VALUES ($1, 'customer', $2, 'anonymize', $3)",
          [tenantA.organizationId, customer.id, randomUUID()]
        ),
      "42501",
      "the tenant runtime cannot name a case"
    );
    await expectSqlState(
      () =>
        attempt(
          tenantA,
          "INSERT INTO public.deletion_ledger (organization_id, entity_type, entity_id, operation, recorded_at) VALUES ($1, 'customer', $2, 'anonymize', now() - interval '3 years')",
          [tenantA.organizationId, customer.id]
        ),
      "42501",
      "the tenant runtime cannot choose the time"
    );
    // the one write it may make is the tombstone it already wrote: a duplicate is refused by the index
    await expectSqlState(
      () =>
        attempt(tenantA, insertTombstone, [
          tenantA.organizationId,
          "customer",
          customer.id,
          "anonymize",
        ]),
      "23505",
      "a tombstone is written once",
      "deletion_ledger_entity_operation_unique"
    );
    // the repository's own statement, run twice as the tenant runtime: the repeat is a no-op, not an error
    for (const times of [1, 2]) {
      // biome-ignore lint/performance/noAwaitInLoops: The same statement twice, in order.
      await asTenant(
        tenantA,
        "customer:anonymize",
        async (transaction) =>
          await recordDeletionLedgerEntry(transaction, {
            entityId: customer.id,
            entityType: "customer",
            operation: "anonymize",
            organizationId: tenantA.organizationId,
          })
      );
      assert.equal(
        (await ledgerRows(tenantA.organizationId)).length,
        1,
        `the statement run ${times} time(s) leaves one tombstone`
      );
    }
    assert.equal(
      (await ledgerRows()).length,
      2,
      "every probe left the ledger as it was"
    );
    const privileges = await owner.pool.query<{
      grantee: string;
      privilege: string;
      allowed: boolean;
    }>(
      `SELECT g.grantee, p.privilege, (has_table_privilege(g.grantee, 'public.deletion_ledger', p.privilege)
                OR (p.privilege IN ('SELECT', 'INSERT', 'UPDATE') AND has_any_column_privilege(g.grantee, 'public.deletion_ledger', p.privilege))) AS allowed
         FROM (VALUES ('${runtimeRole}'), ('polaris_billing_runtime'), ('polaris_catalog_runtime'), ('polaris_admin_runtime'), ('polaris_privacy_runtime'), ('polaris_privacy_owner')) AS g(grantee)
        CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE')) AS p(privilege)`
    );
    const allowed = privileges.rows
      .filter((row) => row.allowed)
      .map((row) => `${row.grantee}:${row.privilege}`)
      .sort();
    assert.deepEqual(
      allowed,
      [`${runtimeRole}:INSERT`, "polaris_privacy_owner:SELECT"],
      "the tenant runtime may insert, the privacy owner may read, nobody else may do anything"
    );
    const columnPrivileges = await owner.pool.query<{ grantee: string }>(
      `SELECT g.grantee
         FROM (VALUES ('polaris_billing_runtime'), ('polaris_catalog_runtime'), ('polaris_admin_runtime'), ('polaris_privacy_runtime')) AS g(grantee)
        CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('REFERENCES')) AS p(privilege)
        WHERE has_any_column_privilege(g.grantee, 'public.deletion_ledger', p.privilege)`
    );
    assert.deepEqual(
      columnPrivileges.rows,
      [],
      "the other service roles hold no privilege on any column either"
    );
    const insertable = await owner.pool.query<{
      column_name: string;
      allowed: boolean;
    }>(
      `SELECT c.column_name, has_column_privilege('${runtimeRole}', 'public.deletion_ledger', c.column_name, 'INSERT') AS allowed
         FROM information_schema.columns AS c WHERE c.table_schema = 'public' AND c.table_name = 'deletion_ledger'`
    );
    assert.deepEqual(
      insertable.rows
        .filter((row) => row.allowed)
        .map((row) => row.column_name)
        .sort(),
      ["entity_id", "entity_type", "operation", "organization_id"]
    );
    const policies = await owner.pool.query<{ cmd: string; roles: string[] }>(
      "SELECT cmd, roles::text[] AS roles FROM pg_policies WHERE schemaname = 'public' AND tablename = 'deletion_ledger' ORDER BY cmd, roles::text"
    );
    // the purge owner inserts only the tombstone of a purge it runs (ADR 0081)
    assert.deepEqual(
      policies.rows.map((row) => [row.cmd, row.roles]),
      [
        ["INSERT", [runtimeRole]],
        ["INSERT", ["polaris_purge_owner"]],
        ["SELECT", ["polaris_privacy_owner"]],
        // the purge owner reads only the purge tombstones, for a purge reapplied after a restore (ADR 0081)
        ["SELECT", ["polaris_purge_owner"]],
      ],
      "no policy allows an update or a delete to any role"
    );
    const forced = await owner.pool.query<{ relforcerowsecurity: boolean }>(
      "SELECT relforcerowsecurity FROM pg_class WHERE oid = 'public.deletion_ledger'::regclass"
    );
    assert.equal(forced.rows[0]?.relforcerowsecurity, true);
    tests.push(
      "the ledger is append-only: the tenant runtime cannot read, update, delete or truncate it, can insert only the four columns of a tombstone (no case, no time) and only for a customer already anonymized in its own organization (a forged, foreign, absent or purge tombstone is refused by row level security, a duplicate by the unique index); no policy allows an update or a delete to any role; only the tenant runtime (insert) and the privacy owner (read) hold any privilege; row level security is forced"
    );

    // ------------------------------------------------- 5. the database vocabulary, probed with a policy that is rolled back
    const probes: [string, unknown[], string][] = [
      [
        "a customer purge",
        [tenantA.organizationId, "customer", randomUUID(), "purge"],
        "deletion_ledger_kind_allowed",
      ],
      [
        "an organization anonymization",
        [
          tenantA.organizationId,
          "organization",
          tenantA.organizationId,
          "anonymize",
        ],
        "deletion_ledger_kind_allowed",
      ],
      [
        "an unknown kind",
        [tenantA.organizationId, "sale", randomUUID(), "purge"],
        "deletion_ledger_kind_allowed",
      ],
      ...NOT_OPAQUE.flatMap((value): [string, unknown[], string][] => [
        [
          "a customer ID that is not a UUID",
          [tenantA.organizationId, "customer", value, "anonymize"],
          "deletion_ledger_entity_shape",
        ],
        [
          "an organization purge whose ID is not opaque",
          [value, "organization", value, "purge"],
          "deletion_ledger_ids_opaque",
        ],
      ]),
      [
        "an organization ID that is not opaque",
        [PII_EMAIL, "customer", randomUUID(), "anonymize"],
        "deletion_ledger_ids_opaque",
      ],
      [
        "a customer UUID in uppercase, which would never match the record",
        [
          tenantA.organizationId,
          "customer",
          randomUUID().toUpperCase(),
          "anonymize",
        ],
        "deletion_ledger_entity_shape",
      ],
      [
        "a customer that is not a UUID",
        [tenantA.organizationId, "customer", "cliente-1", "anonymize"],
        "deletion_ledger_entity_shape",
      ],
      [
        "an organization purge of another ID",
        [tenantA.organizationId, "organization", "other_org", "purge"],
        "deletion_ledger_entity_shape",
      ],
    ];
    // PostgreSQL tests CHECK constraints in the order of their names, so a value that breaks two names the
    // first: "deletion_ledger_entity_shape" before "deletion_ledger_ids_opaque" before "deletion_ledger_kind_allowed"
    for (const [label, values, constraint] of probes) {
      // biome-ignore lint/performance/noAwaitInLoops: Probes, in order, each in its own rolled back transaction.
      const client = await owner.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "CREATE POLICY ledger_probe ON public.deletion_ledger FOR INSERT TO CURRENT_USER WITH CHECK (true)"
        );
        await expectSqlState(
          () => client.query(insertTombstone, values),
          "23514",
          `the database refuses ${label}`,
          constraint
        );
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    }
    assert.equal((await ledgerRows()).length, 2);
    tests.push(
      "the CHECKs refuse a kind that has no meaning, an ID that is not opaque (a name, an e-mail, a phone), a customer that is not a UUID and an organization purge of another ID"
    );

    // ------------------------------------------------- 6. what the restore reads
    const restore = await owner.pool.connect();
    try {
      await restore.query("BEGIN");
      await restore.query(
        "GRANT polaris_privacy_owner TO CURRENT_USER WITH SET TRUE, INHERIT FALSE, ADMIN FALSE"
      );
      await restore.query("SET LOCAL ROLE polaris_privacy_owner");
      const listed = await restore.query<{
        entity_type: string;
        entity_id: string;
        operation: string;
        organization_id: string;
        privacy_case_id: string | null;
      }>(RESTORE_QUERY, [new Date(before - 60_000)]);
      assert.deepEqual(
        listed.rows
          .filter((row) =>
            [tenantA.organizationId, tenantB.organizationId].includes(
              row.organization_id
            )
          )
          .map((row) => [row.operation, row.entity_type, row.entity_id])
          .sort(),
        [
          ["anonymize", "customer", customer.id],
          ["anonymize", "customer", foreign.id],
        ].sort(),
        "the restore query lists every tombstone from the restore point on"
      );
      assert.deepEqual(
        Object.keys(listed.rows[0] ?? {}).sort(),
        [
          "entity_id",
          "entity_type",
          "operation",
          "organization_id",
          "privacy_case_id",
          "recorded_at",
        ],
        "and nothing but opaque IDs, the kinds and the time"
      );
      const none = await restore.query(RESTORE_QUERY, [
        new Date(Date.now() + 3_600_000),
      ]);
      assert.equal(none.rows.length, 0, "a later restore point lists none");
      await restore.query("RESET ROLE");
    } finally {
      await restore.query("ROLLBACK");
      restore.release();
    }
    tests.push(
      "the privacy owner, which the restore runbook assumes, lists every tombstone from the restore point on with only opaque IDs, the kinds and the time"
    );

    // the runbook's completeness checks of the source: every anonymized customer has its tombstone and no tombstone names a customer that was not anonymized
    const missing = await owner.pool.query<{ id: string }>(
      `SELECT c.id::text AS id
         FROM public.customers AS c
         LEFT JOIN public.deletion_ledger AS l
           ON l.entity_type = 'customer' AND l.operation = 'anonymize'
          AND l.entity_id = c.id::text AND l.organization_id = c.organization_id
        WHERE c.anonymized_at IS NOT NULL AND l.id IS NULL
          AND c.organization_id = ANY($1::text[])`,
      [[tenantA.organizationId, tenantB.organizationId]]
    );
    assert.deepEqual(
      missing.rows,
      [],
      "no anonymized customer is without a tombstone"
    );
    const forged = await owner.pool.query<{ entity_id: string }>(
      `SELECT l.entity_id
         FROM public.deletion_ledger AS l
         JOIN public.customers AS c ON c.id::text = l.entity_id AND c.organization_id = l.organization_id
        WHERE l.entity_type = 'customer' AND l.operation = 'anonymize' AND c.anonymized_at IS NULL
          AND l.organization_id = ANY($1::text[])`,
      [[tenantA.organizationId, tenantB.organizationId]]
    );
    assert.deepEqual(
      forged.rows,
      [],
      "no tombstone names a customer that was not anonymized"
    );
    // the verification the runbook ends with: a tombstone whose effect is missing shows up, one that took effect does not
    const verification = `SELECT l.entity_id, l.organization_id
       FROM public.deletion_ledger AS l
       JOIN public.customers AS c ON c.id::text = l.entity_id AND c.organization_id = l.organization_id
      WHERE l.entity_type = 'customer' AND l.operation = 'anonymize' AND c.anonymized_at IS NULL
     UNION ALL
     SELECT l.entity_id, l.organization_id
       FROM public.deletion_ledger AS l
       JOIN public.organizations AS o ON o.id = l.entity_id
      WHERE l.entity_type = 'organization' AND l.operation = 'purge'
        AND o.status <> 'purged'`;
    const ours = [tenantA.organizationId, tenantB.organizationId];
    const pending = async (client: {
      query: (sql: string) => Promise<{
        rows: { entity_id: string; organization_id: string }[];
      }>;
    }) =>
      (await client.query(verification)).rows
        .filter((row) => ours.includes(row.organization_id))
        .map((row) => row.entity_id)
        .sort();
    assert.deepEqual(
      await pending(owner.pool),
      [],
      "after the anonymizations took effect nothing is left to reapply"
    );
    const simulated = await owner.pool.connect();
    try {
      await simulated.query("BEGIN");
      await simulated.query(
        "CREATE POLICY ledger_probe ON public.deletion_ledger FOR INSERT TO CURRENT_USER WITH CHECK (true)"
      );
      // what a restored environment looks like: a tombstone for a customer that came back, and for an organization that came back
      await simulated.query(insertTombstone, [
        tenantA.organizationId,
        "customer",
        bystander.id,
        "anonymize",
      ]);
      await simulated.query(insertTombstone, [
        tenantB.organizationId,
        "organization",
        tenantB.organizationId,
        "purge",
      ]);
      assert.deepEqual(
        await pending(simulated),
        [bystander.id, tenantB.organizationId].sort(),
        "a customer that is not anonymized and an organization that still exists are listed"
      );
      // the tombstone of a purge the closure period scheduled has no privacy case (ADR 0102): it is listed all the same
      const automatic = await simulated.query<{
        privacy_case_id: string | null;
      }>(
        "SELECT privacy_case_id FROM public.deletion_ledger WHERE organization_id = $1 AND entity_type = 'organization' AND operation = 'purge'",
        [tenantB.organizationId]
      );
      assert.deepEqual(automatic.rows, [{ privacy_case_id: null }]);
    } finally {
      await simulated.query("ROLLBACK");
      simulated.release();
    }
    assert.equal((await ledgerRows()).length, 2);
    tests.push(
      "the completeness checks of the runbook (an anonymized customer without a tombstone; a tombstone for a customer that was not anonymized) are empty, and the verification query of the runbook is empty when every tombstone has taken effect and lists a customer that came back with data and an organization that came back, its purge tombstone without a privacy case as an automatic purge leaves it"
    );

    // the backfill of the migration: a tombstone the owner removes comes back when the same INSERT ... SELECT runs again
    const migration = readFileSync(
      fileURLToPath(
        new URL("../drizzle/0069_deletion_ledger.sql", import.meta.url)
      ),
      "utf8"
    );
    const backfill = migration.match(BACKFILL_STATEMENT)?.[0];
    assert.ok(backfill, "the migration has the backfill statement");
    assert.ok(
      backfill.includes("ON CONFLICT DO NOTHING"),
      "the backfill statement is whole"
    );
    const [anonymized] = await ledgerRows(tenantA.organizationId);
    assert.ok(anonymized);
    const backfilled = await owner.pool.connect();
    try {
      await backfilled.query("BEGIN");
      // the ledger is immutable (migration 0080); the check removes the tombstone as the owner, with the
      // trigger off, and the rollback below puts everything back
      await backfilled.query(
        "ALTER TABLE public.deletion_ledger DISABLE TRIGGER deletion_ledger_no_change"
      );
      await backfilled.query(
        "CREATE POLICY ledger_probe_delete ON public.deletion_ledger FOR DELETE TO CURRENT_USER USING (true)"
      );
      await backfilled.query(
        "CREATE POLICY ledger_probe ON public.deletion_ledger FOR INSERT TO CURRENT_USER WITH CHECK (true)"
      );
      await backfilled.query(
        "CREATE POLICY ledger_probe_select ON public.deletion_ledger FOR SELECT TO CURRENT_USER USING (true)"
      );
      const removed = await backfilled.query(
        "DELETE FROM public.deletion_ledger WHERE organization_id = $1 AND entity_id = $2",
        [tenantA.organizationId, anonymized.entity_id]
      );
      assert.equal(removed.rowCount, 1, "the owner removed the tombstone");
      await backfilled.query(backfill);
      const restored = await backfilled.query(
        `SELECT entity_type, operation, privacy_case_id, recorded_at = c.anonymized_at AS same_time
           FROM public.deletion_ledger AS l
           JOIN public.customers AS c ON c.id::text = l.entity_id AND c.organization_id = l.organization_id
          WHERE l.organization_id = $1 AND l.entity_id = $2`,
        [tenantA.organizationId, anonymized.entity_id]
      );
      assert.equal(
        restored.rowCount,
        1,
        "the backfill brought the tombstone back, once"
      );
      assert.deepEqual(restored.rows[0], {
        entity_type: "customer",
        operation: "anonymize",
        privacy_case_id: null,
        same_time: true,
      });
      await backfilled.query(backfill);
      const total = await backfilled.query(
        "SELECT count(*)::int AS count FROM public.deletion_ledger WHERE organization_id = $1",
        [tenantA.organizationId]
      );
      assert.equal(
        total.rows[0]?.count,
        1,
        "running the backfill again adds nothing"
      );
    } finally {
      await backfilled.query("ROLLBACK");
      backfilled.release();
    }
    assert.equal(
      (await ledgerRows()).length,
      2,
      "the backfill check leaves the ledger as it was"
    );
    tests.push(
      "the backfill of the migration (the same INSERT ... SELECT) recreates, with the anonymization time and no case, a tombstone the owner removed, and running it again adds nothing; the check is rolled back"
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
    `Deletion ledger PostgreSQL gate failed (${redactedFailure(error)})`
  );
  process.exitCode = 1;
});
