import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import {
  CustomerAnonymizedError,
  CustomerNotFoundError,
  CustomerVersionConflictError,
} from "@polaris/domain/customers/customer";
import { SaleCustomerArchivedError } from "@polaris/domain/sales/sale-customer-link";
import { createDatabase } from "../src/client";
import {
  anonymizeCustomerForPrivacy,
  archiveCustomer,
  createCustomer,
  findPossibleCustomerDuplicates,
  listCustomers,
  restoreCustomer,
  updateCustomer,
} from "../src/customer-repository";
import { receiveStock } from "../src/inventory-repository";
import { createProduct } from "../src/product-repository";
import { changeSaleCustomerLink } from "../src/sale-customer-link-repository";
import { confirmSale } from "../src/sale-repository";
import { TenantAuthorizationError } from "../src/tenant-transaction";
import {
  createTenantFixture,
  disposableHostPattern,
  expectSqlState,
  gateBranchPattern,
  journalMigrationCount,
  poolerPattern,
  recentInstant,
  redactedFailure,
  requiredEnvironment,
  runtimeRole,
  type TenantFixture,
  temporaryRuntimeUrl,
  withRuntimeSqlContext,
  withTenantAs,
} from "./sales-gate-support";

/**
 * Anonymizing a customer for privacy on a real PostgreSQL 18 (plan PR102, ADR 0075):
 * the record keeps its ID, so every sale that points to it keeps all its economic
 * facts, and nothing about the person is left; the database holds the record to that
 * and refuses any later change, so it cannot be undone; the audit and the change log
 * never held the data.
 */
const expectedDatabase =
  process.env.POLARIS_GATE_DATABASE ??
  process.env.POLARIS_SALES_GATE_DATABASE ??
  "neondb";

const PII_NAME = "Maria Aparecida Souza";
const PII_PHONE = "+55 11 98888-7777";
const PII_EMAIL = "maria.souza@example.com";
const PII_NOTES = "Prefere atendimento aos sábados; alergia a perfume";
const ANONYMIZED = "Cliente anonimizado";

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

    const role = `polaris_anon_${randomUUID().replaceAll("-", "")}`;
    const password = randomBytes(24).toString("hex");
    await owner.pool.query(
      `CREATE ROLE "${role}" WITH LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`
    );
    await owner.pool.query(`GRANT "${runtimeRole}" TO "${role}"`);
    logins.push([role, runtimeRole]);
    const tenantUrl = temporaryRuntimeUrl(adminUrl, role, password);
    runtime = createDatabase(tenantUrl, { maxConnections: 2 });
    const { db } = runtime;

    const tenantA = await createTenantFixture(owner.pool, "anon A");
    const tenantB = await createTenantFixture(owner.pool, "anon B");

    const asTenant = <T>(
      tenant: TenantFixture,
      capability: string,
      operation: Parameters<typeof withTenantAs<T>>[3]
    ) => withTenantAs(db, tenant, capability, operation);
    const newCustomer = (
      tenant: TenantFixture,
      over: Partial<{
        email: string | null;
        name: string;
        notes: string | null;
        phone: string | null;
      }> = {}
    ) =>
      asTenant(tenant, "customer:update", (transaction, identity) =>
        createCustomer(transaction, identity, {
          email: PII_EMAIL,
          name: PII_NAME,
          notes: PII_NOTES,
          phone: PII_PHONE,
          requestId: randomUUID(),
          ...over,
        })
      );
    const anonymize = (
      tenant: TenantFixture,
      id: string,
      expectedVersion: number,
      request: string | null = randomUUID(),
      capability = "customer:anonymize"
    ) =>
      asTenant(tenant, capability, (transaction, identity) =>
        anonymizeCustomerForPrivacy(transaction, identity, {
          expectedVersion,
          id,
          requestId: request,
        })
      );

    // a sale whose economics must stay exactly as they were
    const product = await asTenant(
      tenantA,
      "product:create",
      (transaction, identity) =>
        createProduct(transaction, identity, {
          name: "Produto anon",
          requestId: randomUUID(),
        })
    );
    const variantId = (
      await owner.pool.query<{ id: string }>(
        "SELECT id FROM public.product_variants WHERE organization_id = $1 AND product_id = $2",
        [tenantA.organizationId, product.id]
      )
    ).rows[0]?.id as string;
    await asTenant(tenantA, "inventory:adjust", (transaction, identity) =>
      receiveStock(transaction, identity, {
        commandId: randomUUID(),
        commandVersion: 1,
        occurredOn: "2026-10-01",
        quantity: 50,
        unitCost: "5.00",
        variantId,
      })
    );
    const makeSale = () =>
      asTenant(tenantA, "sale:create", (transaction, identity) =>
        confirmSale(transaction, identity, {
          adjustments: [
            { kind: "freight", value: { amount: "5", type: "fixed" } },
          ],
          commandId: randomUUID(),
          commandVersion: 1,
          items: [
            {
              chargedUnitPrice: "19.90",
              listedUnitPrice: "20.00",
              quantity: 2,
              variantId,
            },
          ],
          occurredAt: recentInstant(),
          payment: { anticipationRequested: false, method: "pix" },
          paymentProfile: null,
          requestId: randomUUID(),
        })
      );
    const sale = await makeSale();
    const saleId = sale.sale.id;
    const unlinkedSaleId = (await makeSale()).sale.id;
    const customer = await newCustomer(tenantA);
    const bystander = await newCustomer(tenantA, {
      email: "outro@example.com",
      name: "Outra Pessoa",
      notes: null,
      phone: null,
    });
    const foreign = await newCustomer(tenantB);
    await asTenant(tenantA, "sale:assign_customer", (transaction, identity) =>
      changeSaleCustomerLink(transaction, identity, {
        action: "assign",
        customerId: customer.id,
        expectedVersion: 0,
        saleId,
      })
    );

    const economicSnapshot = async () =>
      (
        await owner.pool.query<{ snapshot: string }>(
          `SELECT concat_ws('|',
            (SELECT row_to_json(s)::text FROM public.sales s WHERE s.id = $2 AND s.organization_id = $1),
            (SELECT COALESCE(json_agg(i ORDER BY i.position)::text, '') FROM public.sale_items i WHERE i.sale_id = $2 AND i.organization_id = $1),
            (SELECT COALESCE(json_agg(a ORDER BY a.position)::text, '') FROM public.sale_adjustments a WHERE a.sale_id = $2 AND a.organization_id = $1),
            (SELECT COALESCE(json_agg(p)::text, '') FROM public.sale_payments p WHERE p.sale_id = $2 AND p.organization_id = $1),
            (SELECT COALESCE(json_agg(l ORDER BY l.version)::text, '') FROM public.sale_customer_links l WHERE l.sale_id = $2 AND l.organization_id = $1),
            (SELECT COALESCE(json_agg(m ORDER BY m.command_index)::text, '') FROM public.stock_movements m WHERE m.organization_id = $1 AND m.command_id = (SELECT command_id FROM public.sales WHERE id = $2 AND organization_id = $1)),
            (SELECT COALESCE(json_agg(b ORDER BY b.variant_id)::text, '') FROM public.inventory_balances b WHERE b.organization_id = $1)
          ) AS snapshot`,
          [tenantA.organizationId, saleId]
        )
      ).rows[0]?.snapshot as string;
    const rowOf = async (id: string) =>
      (
        await owner.pool.query(
          "SELECT name, phone, email, notes, archived_at, anonymized_at, version FROM public.customers WHERE id = $1",
          [id]
        )
      ).rows[0];
    const auditRows = async (organizationId: string, eventType: string) =>
      (
        await owner.pool.query(
          "SELECT actor_user_id, entity_type, entity_id::text AS entity_id, request_id::text AS request_id FROM public.tenant_audit_event WHERE organization_id = $1 AND event_type = $2",
          [organizationId, eventType]
        )
      ).rows;
    const economicsBefore = await economicSnapshot();
    const bystanderBefore = await rowOf(bystander.id);
    const foreignBefore = await rowOf(foreign.id);

    // ------------------------------------------------- 1. what it takes
    await assert.rejects(
      () =>
        anonymize(
          tenantA,
          customer.id,
          customer.version,
          randomUUID(),
          "customer:update"
        ),
      (error: unknown) =>
        error instanceof TenantAuthorizationError &&
        error.code === "capability_denied",
      "anonymizing needs its own capability"
    );
    await assert.rejects(
      () => anonymize(tenantA, customer.id, customer.version + 5),
      CustomerVersionConflictError,
      "a stale version conflicts"
    );
    await assert.rejects(
      () => anonymize(tenantA, randomUUID(), 1),
      CustomerNotFoundError
    );
    await assert.rejects(
      () => anonymize(tenantA, foreign.id, foreign.version),
      CustomerNotFoundError,
      "another organization's customer is not found"
    );
    assert.equal((await rowOf(customer.id)).name, PII_NAME, "nothing happened");
    assert.deepEqual(await rowOf(foreign.id), foreignBefore);
    tests.push(
      "anonymizing needs its own capability and the current version, finds only the organization's own customer, and changes nothing when refused"
    );

    // ------------------------------------------------- 2. what it does
    const requestId = randomUUID();
    const done = await anonymize(
      tenantA,
      customer.id,
      customer.version,
      requestId
    );
    assert.equal(done.changed, true);
    assert.equal(done.customer.name, ANONYMIZED);
    assert.equal(done.customer.phone, null);
    assert.equal(done.customer.email, null);
    assert.equal(done.customer.notes, null);
    assert.notEqual(done.customer.anonymizedAt, null);
    assert.notEqual(
      done.customer.archivedAt,
      null,
      "it leaves the active list"
    );
    assert.equal(done.customer.version, customer.version + 1);
    const stored = await rowOf(customer.id);
    assert.equal(stored.name, ANONYMIZED);
    assert.equal(stored.phone, null);
    assert.equal(stored.email, null);
    assert.equal(stored.notes, null);
    assert.notEqual(stored.anonymized_at, null);
    assert.equal(
      await economicSnapshot(),
      economicsBefore,
      "the sale, its items, adjustments, payment, link, stock movements and balances are exactly as they were"
    );
    assert.deepEqual(
      await rowOf(bystander.id),
      bystanderBefore,
      "another customer of the organization is untouched"
    );
    assert.deepEqual(
      await rowOf(foreign.id),
      foreignBefore,
      "another organization is untouched"
    );
    // nothing of the person is left anywhere in the database's text columns that could hold it
    const leftovers = await owner.pool.query<{ where: string }>(
      `SELECT 'customers' AS "where" FROM public.customers WHERE id = $1 AND (name ILIKE '%' || $2 || '%' OR phone ILIKE '%' || $3 || '%' OR email ILIKE '%' || $4 || '%' OR notes ILIKE '%' || $5 || '%')
       UNION ALL
       SELECT 'tenant_audit_event' FROM public.tenant_audit_event WHERE organization_id = $6 AND to_jsonb(tenant_audit_event)::text ILIKE '%' || $4 || '%'
       UNION ALL
       SELECT 'sync_changes' FROM public.sync_changes WHERE organization_id = $6 AND to_jsonb(sync_changes)::text ILIKE '%' || $4 || '%'
       UNION ALL
       SELECT 'sync_commands' FROM public.sync_commands WHERE organization_id = $6 AND to_jsonb(sync_commands)::text ILIKE '%' || $4 || '%'
       UNION ALL
       SELECT 'sales' FROM public.sales WHERE organization_id = $6 AND to_jsonb(sales)::text ILIKE '%' || $3 || '%'`,
      [
        customer.id,
        "Aparecida",
        "98888-7777",
        "maria.souza",
        "sábados",
        tenantA.organizationId,
      ]
    );
    assert.deepEqual(
      leftovers.rows,
      [],
      "none of the person's data is left in the record, the audit, the change log or the sales"
    );
    const audit = await auditRows(
      tenantA.organizationId,
      "customer.anonymized"
    );
    assert.equal(audit.length, 1);
    assert.equal(audit[0]?.entity_id, customer.id);
    assert.equal(audit[0]?.entity_type, "customer");
    assert.equal(audit[0]?.request_id, requestId);
    assert.equal(audit[0]?.actor_user_id, tenantA.userId);
    // the device learns of it through the change log
    const changes = await owner.pool.query<{ change_kind: string }>(
      "SELECT change_kind FROM public.sync_changes WHERE organization_id = $1 AND entity_type = 'customer' AND entity_id = $2 ORDER BY seq DESC LIMIT 1",
      [tenantA.organizationId, customer.id]
    );
    assert.equal(
      changes.rows[0]?.change_kind,
      "upsert",
      "the change reaches devices as an upsert of the anonymized record"
    );
    tests.push(
      "anonymizing replaces the name with a fixed text and removes phone, e-mail and notes, archives the customer and bumps its version, in one transaction with one audit event (customer ID and request ID only); the sale, its items, adjustments, payment, customer link, stock movements and balances are byte-identical; none of the person's data is left in the record, the audit, the change log, the command log or the sales; another customer and another organization are untouched; the change reaches devices through the change log"
    );

    // ------------------------------------------------- 3. doing it again, and what can no longer be done
    const again = await anonymize(tenantA, customer.id, 1);
    assert.equal(
      again.changed,
      false,
      "a second anonymization is a no-op, whatever version it names"
    );
    assert.equal(
      (await auditRows(tenantA.organizationId, "customer.anonymized")).length,
      1
    );
    assert.deepEqual(await rowOf(customer.id), stored);
    await assert.rejects(
      () =>
        asTenant(tenantA, "customer:update", (transaction, identity) =>
          updateCustomer(transaction, identity, {
            email: PII_EMAIL,
            expectedVersion: done.customer.version,
            id: customer.id,
            name: PII_NAME,
            notes: null,
            phone: PII_PHONE,
          })
        ),
      CustomerAnonymizedError,
      "the person's data cannot be put back by an edit"
    );
    await assert.rejects(
      () =>
        asTenant(tenantA, "customer:update", (transaction, identity) =>
          restoreCustomer(transaction, identity, {
            expectedVersion: done.customer.version,
            id: customer.id,
          })
        ),
      CustomerAnonymizedError,
      "nor can it be restored to the active list"
    );
    const archivedAgain = await asTenant(
      tenantA,
      "customer:update",
      (transaction, identity) =>
        archiveCustomer(transaction, identity, {
          expectedVersion: done.customer.version,
          id: customer.id,
        })
    );
    assert.equal(
      archivedAgain.changed,
      false,
      "archiving what is archived is a no-op"
    );
    const archivedStale = await asTenant(
      tenantA,
      "customer:update",
      (transaction, identity) =>
        archiveCustomer(transaction, identity, {
          expectedVersion: 1,
          id: customer.id,
        })
    );
    assert.equal(
      archivedStale.changed,
      false,
      "and so is archiving it with an old version"
    );
    assert.deepEqual(await rowOf(customer.id), stored);
    // the same, straight at the database: the runtime cannot undo it by any statement
    const attempt = (sql: string) =>
      withRuntimeSqlContext(tenantUrl, tenantA, (client) =>
        client.query(sql, [customer.id])
      );
    await expectSqlState(
      () =>
        attempt(
          "UPDATE public.customers SET anonymized_at = NULL WHERE id = $1"
        ),
      "23514",
      "the anonymization cannot be unset",
      "customers_anonymization_final"
    );
    await expectSqlState(
      () =>
        attempt(
          "UPDATE public.customers SET name = 'Maria', email = 'm@example.com', anonymized_at = NULL WHERE id = $1"
        ),
      "23514",
      "the data cannot be put back and the mark removed"
    );
    await expectSqlState(
      () =>
        attempt(
          "UPDATE public.customers SET version = version + 1 WHERE id = $1"
        ),
      "23514",
      "not even the version of an anonymized record changes"
    );
    assert.deepEqual(await rowOf(customer.id), stored);
    tests.push(
      "a second anonymization is a no-op; an edit or a restore of an anonymized customer is refused (customer_anonymized) and archiving it again is a no-op; straight at the database the runtime cannot unset the mark, put the data back or change the record at all"
    );

    // ------------------------------------------------- 4. the record must be what the database says an anonymized one is
    const probe = await newCustomer(tenantA, {
      name: "Probe",
      phone: "+55 11 90000-0000",
      email: null,
      notes: null,
    });
    for (const [label, set] of [
      [
        "a real name",
        "name = 'Maria', anonymized_at = now(), archived_at = now(), phone = NULL, email = NULL, notes = NULL",
      ],
      [
        "a phone left",
        "name = 'Cliente anonimizado', anonymized_at = now(), archived_at = now()",
      ],
      [
        "notes left",
        "name = 'Cliente anonimizado', anonymized_at = now(), archived_at = now(), phone = NULL, email = NULL, notes = 'x'",
      ],
      [
        "not archived",
        "name = 'Cliente anonimizado', anonymized_at = now(), phone = NULL, email = NULL, notes = NULL",
      ],
    ] as const) {
      // biome-ignore lint/performance/noAwaitInLoops: Probes, in order.
      await expectSqlState(
        () =>
          withRuntimeSqlContext(tenantUrl, tenantA, (client) =>
            client.query(`UPDATE public.customers SET ${set} WHERE id = $1`, [
              probe.id,
            ])
          ),
        "23514",
        `an anonymized record with ${label} is refused`,
        "customers_anonymized_scrubbed"
      );
    }
    assert.equal((await rowOf(probe.id)).anonymized_at, null);
    // an ordinary customer still needs a name and a contact
    await expectSqlState(
      () =>
        withRuntimeSqlContext(tenantUrl, tenantA, (client) =>
          client.query(
            "UPDATE public.customers SET phone = NULL, email = NULL WHERE id = $1",
            [probe.id]
          )
        ),
      "23514",
      "an ordinary customer still needs a contact",
      "customers_contact_required"
    );
    tests.push(
      "the database refuses an anonymized record that keeps a real name, a phone, an e-mail or notes, or that is not archived, and an ordinary customer still needs a name and a contact"
    );

    // ------------------------------------------------- 5. how it shows
    const listed = await asTenant(
      tenantA,
      "customer:update",
      (transaction, identity) =>
        listCustomers(transaction, identity, { status: "all" })
    );
    const row = listed.find((entry) => entry.id === customer.id);
    assert.equal(row?.name, ANONYMIZED);
    assert.notEqual(row?.anonymizedAt, null);
    const active = await asTenant(
      tenantA,
      "customer:update",
      (transaction, identity) =>
        listCustomers(transaction, identity, { status: "active" })
    );
    assert.equal(
      active.some((entry) => entry.id === customer.id),
      false,
      "it is not in the active list"
    );
    for (const search of [{ email: PII_EMAIL }, { phone: PII_PHONE }]) {
      // biome-ignore lint/performance/noAwaitInLoops: Probes, in order.
      const matches = await asTenant(
        tenantA,
        "customer:update",
        (transaction, identity) =>
          findPossibleCustomerDuplicates(transaction, identity, search)
      );
      assert.equal(
        matches.length,
        0,
        "the old e-mail and phone no longer find anyone"
      );
    }
    // a sale can no longer be newly linked to it
    await assert.rejects(
      () =>
        asTenant(tenantA, "sale:assign_customer", (transaction, identity) =>
          changeSaleCustomerLink(transaction, identity, {
            action: "assign",
            customerId: customer.id,
            expectedVersion: 0,
            saleId: unlinkedSaleId,
          })
        ),
      SaleCustomerArchivedError,
      "an archived customer cannot be newly linked to a sale"
    );
    assert.equal(await economicSnapshot(), economicsBefore);
    tests.push(
      "an anonymized customer appears in the full list under the fixed name with its mark, not in the active list, is found by no old e-mail or phone, and cannot be newly linked to a sale; the sale it was linked to still points to it"
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
    `Customer anonymization PostgreSQL gate failed (${redactedFailure(error)})`
  );
  process.exitCode = 1;
});
