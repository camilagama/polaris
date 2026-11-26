import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { CustomerNotFoundError } from "@polaris/domain/customers/customer";
import { saleEconomics } from "@polaris/domain/economics/sale-economics";
import {
  SaleCustomerArchivedError,
  SaleCustomerLinkStateError,
  SaleCustomerLinkVersionConflictError,
} from "@polaris/domain/sales/sale-customer-link";
import { SaleNotFoundError } from "@polaris/domain/sales/sale-errors";
import { createDatabase } from "../src/client";
import { readPeriodFacts } from "../src/economics-repository";
import { Client } from "pg";
import {
  archiveCustomer,
  createCustomer,
  getCustomer,
  listCustomers,
} from "../src/customer-repository";
import { receiveStock } from "../src/inventory-repository";
import { createProduct } from "../src/product-repository";
import {
  type ChangeSaleCustomerLinkInput,
  changeSaleCustomerLink,
  getSaleCustomerLink,
} from "../src/sale-customer-link-repository";
import { cancelSale } from "../src/sale-cancellation-repository";
import { confirmSale } from "../src/sale-repository";
import { createSaleReturn } from "../src/sale-return-repository";
import { TenantAuditEventError } from "../src/tenant-audit";
import {
  TenantAuthorizationError,
  withAuthorizedTenantTransaction,
} from "../src/tenant-transaction";
import {
  eachRound,
  fulfilled,
  lockRow,
  raceBehindLock,
  rejections,
} from "./concurrency-support";
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

const expectedDatabase = process.env.POLARIS_SALES_GATE_DATABASE ?? "neondb";
const linkCapability = "sale:assign_customer";

type RuntimeDatabase = ReturnType<typeof createDatabase>;
type ErrorClass = abstract new (...args: never[]) => Error;

async function run() {
  const branch = requiredEnvironment("POLARIS_SALES_GATE_BRANCH");
  assert.match(branch, gateBranchPattern);
  const adminUrl = requiredEnvironment("POLARIS_SALES_GATE_DATABASE_URL");
  const parsedAdminUrl = new URL(adminUrl);
  assert.match(parsedAdminUrl.hostname, disposableHostPattern);
  assert.doesNotMatch(parsedAdminUrl.hostname, poolerPattern);

  const admin = createDatabase(adminUrl, { maxConnections: 2 });
  let runtime: RuntimeDatabase | undefined;
  let concurrent: RuntimeDatabase | undefined;
  let loginRole: string | undefined;
  let loginRoleCreated = false;
  let guardDisabled = false;
  const tests: string[] = [];

  try {
    const server = await admin.pool.query<{
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
    tests.push("disposable direct Neon connection is PostgreSQL 18");

    const migrations = await admin.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations"
    );
    assert.equal(Number(migrations.rows[0]?.count), journalMigrationCount());
    tests.push(
      "migrations 0000-0035 (and any later ones) were replayed from scratch"
    );

    const tenantA = await createTenantFixture(admin.pool, "A");
    const tenantB = await createTenantFixture(admin.pool, "B");
    const outsider = await createTenantFixture(admin.pool, "outsider");
    const tenantD = await createTenantFixture(admin.pool, "D");
    const loginSuffix = randomUUID().replaceAll("-", "");
    loginRole = `polaris_link_gate_${loginSuffix}`;
    const loginPassword = randomBytes(24).toString("hex");
    await admin.pool.query(
      `CREATE ROLE "${loginRole}" WITH LOGIN INHERIT PASSWORD '${loginPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`
    );
    loginRoleCreated = true;
    await admin.pool.query(`GRANT "${runtimeRole}" TO "${loginRole}"`);
    const runtimeUrl = temporaryRuntimeUrl(adminUrl, loginRole, loginPassword);
    const runtimeDatabase = createDatabase(runtimeUrl, { maxConnections: 1 });
    runtime = runtimeDatabase;
    const concurrentDatabase = createDatabase(runtimeUrl, {
      maxConnections: 10,
    });
    concurrent = concurrentDatabase;

    // ---------------------------------------------------------------- helpers
    async function newCustomer(tenant: TenantFixture, label: string) {
      return await withTenantAs(
        runtimeDatabase.db,
        tenant,
        "customer:update",
        (transaction, identity) =>
          createCustomer(transaction, identity, {
            name: `Cliente ${label}`,
            phone: `+55 11 9${Math.floor(Math.random() * 1e8)}`,
            requestId: randomUUID(),
          })
      );
    }

    interface SaleShape {
      adjustments?: {
        amount: string;
        kind: "discount" | "freight" | "payment_surcharge" | "surcharge";
      }[];
      lines?: { price: string; quantity: number }[];
    }

    async function newSale(
      tenant: TenantFixture,
      label: string,
      hoursAgo = 3,
      shape: SaleShape = {}
    ) {
      const lines = shape.lines ?? [{ price: "19.90", quantity: 2 }];
      const adjustments = shape.adjustments ?? [
        { amount: "5", kind: "freight" },
      ];
      const items: {
        chargedUnitPrice: string;
        listedUnitPrice: string;
        quantity: number;
        variantId: string;
      }[] = [];
      for (const [index, line] of lines.entries()) {
        // biome-ignore lint/performance/noAwaitInLoops: each line is its own product and stock receipt
        const product = await withTenantAs(
          runtimeDatabase.db,
          tenant,
          "product:create",
          (transaction, identity) =>
            createProduct(transaction, identity, {
              name: `Produto ${label} ${index}`,
              requestId: randomUUID(),
            })
        );
        const variant = await admin.pool.query<{ id: string }>(
          "SELECT id FROM public.product_variants WHERE organization_id = $1 AND product_id = $2",
          [tenant.organizationId, product.id]
        );
        const variantId = variant.rows[0]?.id;
        assert.ok(variantId);
        await withTenantAs(
          runtimeDatabase.db,
          tenant,
          "inventory:adjust",
          async (transaction, identity) => {
            await receiveStock(transaction, identity, {
              commandId: randomUUID(),
              commandVersion: 1,
              occurredOn: "2026-10-01",
              quantity: 50,
              unitCost: "5.00",
              variantId,
            });
          }
        );
        items.push({
          chargedUnitPrice: line.price,
          listedUnitPrice: line.price,
          quantity: line.quantity,
          variantId,
        });
      }
      const sale = await withTenantAs(
        runtimeDatabase.db,
        tenant,
        "sale:create",
        (transaction, identity) =>
          confirmSale(transaction, identity, {
            adjustments: adjustments.map((adjustment) => ({
              kind: adjustment.kind,
              value: { amount: adjustment.amount, type: "fixed" as const },
            })),
            commandId: randomUUID(),
            commandVersion: 1,
            items,
            occurredAt: recentInstant(hoursAgo),
            payment: { anticipationRequested: false, method: "pix" },
            paymentProfile: null,
            requestId: randomUUID(),
          })
      );
      return sale.sale.id;
    }

    const returnUnits = (
      tenant: TenantFixture,
      saleId: string,
      items: { position: number; returnedQuantity: number }[]
    ) =>
      withTenantAs(
        runtimeDatabase.db,
        tenant,
        "sale:return",
        (transaction, identity) =>
          createSaleReturn(transaction, identity, {
            commandId: randomUUID(),
            commandVersion: 1,
            items: items.map((item) => ({ ...item, restockedQuantity: 0 })),
            saleId,
          })
      );

    const change = (
      tenant: TenantFixture,
      input: Omit<ChangeSaleCustomerLinkInput, "requestId"> & {
        requestId?: string;
      },
      database: RuntimeDatabase = runtimeDatabase
    ) =>
      withTenantAs(
        database.db,
        tenant,
        linkCapability,
        (transaction, identity) =>
          changeSaleCustomerLink(transaction, identity, input)
      );

    const read = (tenant: TenantFixture, saleId: string) =>
      withTenantAs(
        runtimeDatabase.db,
        tenant,
        linkCapability,
        (transaction, identity) =>
          getSaleCustomerLink(transaction, identity, saleId)
      );

    /** Everything economic about a sale: header, items, adjustments, payment, ledger. */
    async function economicSnapshot(tenant: TenantFixture, saleId: string) {
      const result = await admin.pool.query<{ snapshot: string }>(
        `SELECT concat_ws('|',
          (SELECT row_to_json(s)::text FROM public.sales s WHERE s.id = $2 AND s.organization_id = $1),
          (SELECT COALESCE(json_agg(i ORDER BY i.position)::text, '') FROM public.sale_items i WHERE i.sale_id = $2 AND i.organization_id = $1),
          (SELECT COALESCE(json_agg(a ORDER BY a.position)::text, '') FROM public.sale_adjustments a WHERE a.sale_id = $2 AND a.organization_id = $1),
          (SELECT COALESCE(json_agg(p)::text, '') FROM public.sale_payments p WHERE p.sale_id = $2 AND p.organization_id = $1),
          (SELECT COALESCE(json_agg(m ORDER BY m.command_index)::text, '') FROM public.stock_movements m WHERE m.organization_id = $1 AND m.command_id = (SELECT command_id FROM public.sales WHERE id = $2 AND organization_id = $1)),
          (SELECT COALESCE(json_agg(b ORDER BY b.variant_id)::text, '') FROM public.inventory_balances b WHERE b.organization_id = $1)
        ) AS snapshot`,
        [tenant.organizationId, saleId]
      );
      return result.rows[0]?.snapshot;
    }

    const auditCount = async (tenant: TenantFixture, requestId: string) => {
      const result = await admin.pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM public.tenant_audit_event WHERE organization_id = $1 AND request_id = $2",
        [tenant.organizationId, requestId]
      );
      return Number(result.rows[0]?.count);
    };

    const rowCount = async (saleId: string) => {
      const result = await admin.pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM public.sale_customer_links WHERE sale_id = $1",
        [saleId]
      );
      return Number(result.rows[0]?.count);
    };

    async function expectRejected(
      operation: () => Promise<unknown>,
      expected: ErrorClass,
      label: string
    ) {
      await assert.rejects(operation, expected, label);
    }

    // --------------------------------------------------------------- fixtures
    const saleOne = await newSale(tenantA, "S1");
    const saleTwo = await newSale(tenantA, "S2");
    const saleThree = await newSale(tenantA, "S3");
    const saleFour = await newSale(tenantA, "S4");
    const saleFive = await newSale(tenantA, "S5");
    const saleSix = await newSale(tenantA, "S6");
    const saleSeven = await newSale(tenantA, "S7");
    const saleOfB = await newSale(tenantB, "SB");
    const saleOfD = await newSale(tenantD, "SD");
    const customerOne = await newCustomer(tenantA, "Um");
    const customerTwo = await newCustomer(tenantA, "Dois");
    const customerThree = await newCustomer(tenantA, "Três");
    const customerOfB = await newCustomer(tenantB, "B");
    const customerOfD = await newCustomer(tenantD, "D");

    // ----------------------------------------------------- 1. initial state
    const initial = await read(tenantA, saleOne);
    assert.deepEqual(initial, {
      current: { customerId: null, version: 0 },
      history: [],
      saleId: saleOne,
    });
    await expectRejected(
      () => read(tenantA, randomUUID()),
      SaleNotFoundError,
      "an unknown sale is not found"
    );
    await expectRejected(
      () => read(tenantA, saleOfB),
      SaleNotFoundError,
      "another organization's sale is not found"
    );
    tests.push(
      "a sale with no attribution reads as version 0 without a customer; unknown and cross-organization sales are not found"
    );

    // -------------------------------------- 2. assign / reassign / unassign
    const economyBefore = await economicSnapshot(tenantA, saleOne);
    assert.ok(economyBefore?.includes(saleOne));
    const assignRequest = randomUUID();
    const assigned = await change(tenantA, {
      action: "assign",
      customerId: customerOne.id,
      expectedVersion: 0,
      requestId: assignRequest,
      saleId: saleOne,
    });
    assert.equal(assigned.changed, true);
    assert.deepEqual(assigned.link.current, {
      customerId: customerOne.id,
      version: 1,
    });
    assert.equal(assigned.link.history.length, 1);
    assert.equal(assigned.link.history[0]?.action, "assign");
    assert.equal(await auditCount(tenantA, assignRequest), 1);
    const assignAudit = await admin.pool.query<{
      entity_type: string;
      event_type: string;
    }>(
      "SELECT entity_type, event_type FROM public.tenant_audit_event WHERE organization_id = $1 AND request_id = $2",
      [tenantA.organizationId, assignRequest]
    );
    assert.deepEqual(assignAudit.rows, [
      {
        entity_type: "sale_customer_link",
        event_type: "sale_customer_link.assigned",
      },
    ]);

    const noOpRequest = randomUUID();
    const noOpAssign = await change(tenantA, {
      action: "assign",
      customerId: customerOne.id,
      expectedVersion: 1,
      requestId: noOpRequest,
      saleId: saleOne,
    });
    assert.equal(noOpAssign.changed, false);
    assert.equal(
      await auditCount(tenantA, noOpRequest),
      0,
      "a no-op writes no audit event"
    );
    assert.equal(await rowCount(saleOne), 1);
    await expectRejected(
      () =>
        change(tenantA, {
          action: "assign",
          customerId: customerTwo.id,
          expectedVersion: 1,
          saleId: saleOne,
        }),
      SaleCustomerLinkStateError,
      "assign cannot replace an existing customer"
    );
    await expectRejected(
      () =>
        change(tenantA, {
          action: "reassign",
          customerId: customerTwo.id,
          expectedVersion: 0,
          saleId: saleOne,
        }),
      SaleCustomerLinkVersionConflictError,
      "a stale expected version conflicts"
    );

    const reassigned = await change(tenantA, {
      action: "reassign",
      customerId: customerTwo.id,
      expectedVersion: 1,
      requestId: randomUUID(),
      saleId: saleOne,
    });
    assert.equal(reassigned.changed, true);
    assert.deepEqual(reassigned.link.current, {
      customerId: customerTwo.id,
      version: 2,
    });
    assert.equal(
      (
        await change(tenantA, {
          action: "reassign",
          customerId: customerTwo.id,
          expectedVersion: 2,
          saleId: saleOne,
        })
      ).changed,
      false
    );
    const unassigned = await change(tenantA, {
      action: "unassign",
      expectedVersion: 2,
      requestId: randomUUID(),
      saleId: saleOne,
    });
    assert.equal(unassigned.changed, true);
    assert.deepEqual(unassigned.link.current, { customerId: null, version: 3 });
    assert.equal(
      (
        await change(tenantA, {
          action: "unassign",
          expectedVersion: 3,
          saleId: saleOne,
        })
      ).changed,
      false
    );
    await expectRejected(
      () =>
        change(tenantA, {
          action: "reassign",
          customerId: customerOne.id,
          expectedVersion: 3,
          saleId: saleOne,
        }),
      SaleCustomerLinkStateError,
      "reassign needs an existing customer"
    );
    const assignedAgain = await change(tenantA, {
      action: "assign",
      customerId: customerThree.id,
      expectedVersion: 3,
      requestId: randomUUID(),
      saleId: saleOne,
    });
    assert.deepEqual(assignedAgain.link.current, {
      customerId: customerThree.id,
      version: 4,
    });
    assert.deepEqual(
      assignedAgain.link.history.map((entry) => [
        entry.version,
        entry.action,
        entry.customerId,
      ]),
      [
        [1, "assign", customerOne.id],
        [2, "reassign", customerTwo.id],
        [3, "unassign", null],
        [4, "assign", customerThree.id],
      ]
    );
    assert.equal(await rowCount(saleOne), 4);
    const kinds = await admin.pool.query<{ event_type: string }>(
      "SELECT event_type FROM public.tenant_audit_event WHERE organization_id = $1 AND event_type LIKE 'sale_customer_link.%' ORDER BY created_at, event_type",
      [tenantA.organizationId]
    );
    assert.equal(kinds.rows.length, 4);
    assert.deepEqual(await economicSnapshot(tenantA, saleOne), economyBefore);
    tests.push(
      "assign, reassign, and unassign append versions and one audit event each; repeating a held action is a no-op; stale versions and wrong-state actions are rejected"
    );
    tests.push(
      "the sale's header, items, adjustments, payment, ledger movements, and balances are byte-identical after four attribution changes"
    );

    // ------------------------------------------------- 3. customer lifecycle
    const archivedBefore = await newCustomer(tenantA, "Arquivado");
    await withTenantAs(
      runtimeDatabase.db,
      tenantA,
      "customer:update",
      (transaction, identity) =>
        archiveCustomer(transaction, identity, {
          expectedVersion: archivedBefore.version,
          id: archivedBefore.id,
        })
    );
    await expectRejected(
      () =>
        change(tenantA, {
          action: "assign",
          customerId: archivedBefore.id,
          expectedVersion: 0,
          saleId: saleTwo,
        }),
      SaleCustomerArchivedError,
      "an archived customer cannot be newly linked"
    );
    assert.equal(await rowCount(saleTwo), 0);

    const toArchiveLater = await newCustomer(tenantA, "Arquivar depois");
    await change(tenantA, {
      action: "assign",
      customerId: toArchiveLater.id,
      expectedVersion: 0,
      saleId: saleTwo,
    });
    await withTenantAs(
      runtimeDatabase.db,
      tenantA,
      "customer:update",
      (transaction, identity) =>
        archiveCustomer(transaction, identity, {
          expectedVersion: toArchiveLater.version,
          id: toArchiveLater.id,
        })
    );
    const stillLinked = await read(tenantA, saleTwo);
    assert.equal(stillLinked.current.customerId, toArchiveLater.id);
    await expectRejected(
      () =>
        change(tenantA, {
          action: "reassign",
          customerId: archivedBefore.id,
          expectedVersion: 1,
          saleId: saleTwo,
        }),
      SaleCustomerArchivedError,
      "an archived customer cannot replace the current one"
    );
    const replacedActive = await change(tenantA, {
      action: "reassign",
      customerId: customerOne.id,
      expectedVersion: 1,
      saleId: saleTwo,
    });
    assert.equal(replacedActive.link.current.customerId, customerOne.id);
    await expectRejected(
      () =>
        change(tenantA, {
          action: "assign",
          customerId: randomUUID(),
          expectedVersion: 2,
          saleId: saleThree,
        }),
      SaleCustomerLinkVersionConflictError,
      "version is checked before the customer"
    );
    await expectRejected(
      () =>
        change(tenantA, {
          action: "assign",
          customerId: randomUUID(),
          expectedVersion: 0,
          saleId: saleThree,
        }),
      CustomerNotFoundError,
      "an unknown customer is not found"
    );
    await expectRejected(
      () =>
        change(tenantA, {
          action: "assign",
          customerId: customerOfB.id,
          expectedVersion: 0,
          saleId: saleThree,
        }),
      CustomerNotFoundError,
      "another organization's customer is not found"
    );
    await expectRejected(
      () =>
        change(tenantA, {
          action: "assign",
          customerId: customerOne.id,
          expectedVersion: 0,
          saleId: saleOfB,
        }),
      SaleNotFoundError,
      "another organization's sale cannot be attributed"
    );
    assert.equal(await rowCount(saleThree), 0);
    tests.push(
      "an archived customer cannot be newly linked, an already-linked customer stays visible after archiving, and unknown or cross-organization customers and sales are rejected without writes"
    );

    // ------------------------------------------- 4. identity and capability
    await assert.rejects(
      () =>
        withTenantAs(
          runtimeDatabase.db,
          tenantA,
          "sale:create",
          (transaction, identity) =>
            changeSaleCustomerLink(transaction, identity, {
              action: "assign",
              customerId: customerOne.id,
              expectedVersion: 0,
              saleId: saleThree,
            })
        ),
      (error: unknown) =>
        error instanceof TenantAuthorizationError &&
        error.code === "capability_denied"
    );
    await assert.rejects(
      () =>
        withTenantAs(
          runtimeDatabase.db,
          { organizationId: tenantA.organizationId, userId: outsider.userId },
          linkCapability,
          (transaction, identity) =>
            getSaleCustomerLink(transaction, identity, saleThree)
        ),
      (error: unknown) =>
        error instanceof TenantAuthorizationError &&
        error.code === "tenant_access_denied"
    );
    assert.equal(await rowCount(saleThree), 0);
    tests.push(
      "attribution needs the dedicated capability and an active membership in the organization"
    );

    // ------------------------------------------------------- 5. concurrency
    const contenders = [customerOne, customerTwo, customerThree];
    // The racers share-lock the customer they link: the holder keeps all three
    // locked, so the six changes are released together and meet at the unique
    // version index (concurrency-support.ts).
    const rounds = await eachRound(async (round) => {
      const raceSale =
        round === 0 ? saleThree : await newSale(tenantA, `race ${round}`);
      const { results: race } = await raceBehindLock({
        adminUrl,
        hold: [
          lockRow(
            "customers",
            "id",
            contenders.map((customer) => customer.id)
          ),
        ],
        label: "six assignments of one sale over the same version",
        racers: Array.from(
          { length: 6 },
          (_, index) => () =>
            change(
              tenantA,
              {
                action: "assign",
                customerId: (
                  contenders[index % contenders.length] ?? customerOne
                ).id,
                expectedVersion: 0,
                saleId: raceSale,
              },
              concurrentDatabase
            )
        ),
      });
      assert.equal(
        fulfilled(race).length,
        1,
        "exactly one concurrent change wins"
      );
      assert.equal(rejections(race).length, 5, "the five others lose");
      assert.ok(
        rejections(race).every(
          (reason) => reason instanceof SaleCustomerLinkVersionConflictError
        ),
        "the others see a stale version, not a database error"
      );
      assert.equal(await rowCount(raceSale), 1);
    });
    tests.push(
      `six concurrent assignments against the same version produce exactly one new version; the rest conflict cleanly (${rounds} round(s), released from a barrier with the racers seen blocked on a lock)`
    );

    // ------------------- 5b. deterministic interleavings and rollbacks
    const barrier = () => {
      let release: () => void = () => undefined;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      return { release, released };
    };
    const pause = (ms: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, ms));

    // (a) The other change is still uncommitted: this insert waits on the unique
    // version index and fails with 23505 once the other commits.
    const uncommitted = barrier();
    const holderInserted = barrier();
    const holder = withTenantAs(
      concurrentDatabase.db,
      tenantA,
      linkCapability,
      async (transaction, identity) => {
        await changeSaleCustomerLink(transaction, identity, {
          action: "assign",
          customerId: customerOne.id,
          expectedVersion: 0,
          saleId: saleFive,
        });
        holderInserted.release();
        await uncommitted.released;
      }
    );
    await holderInserted.released;
    const waiter = change(
      tenantA,
      {
        action: "assign",
        customerId: customerTwo.id,
        expectedVersion: 0,
        saleId: saleFive,
      },
      concurrentDatabase
    );
    const waiterOutcome = waiter.then(
      () => "committed",
      (error: unknown) => error
    );
    await pause(400);
    uncommitted.release();
    await holder;
    assert.ok(
      (await waiterOutcome) instanceof SaleCustomerLinkVersionConflictError,
      "an insert that waited on the unique version index conflicts cleanly"
    );
    assert.equal(await rowCount(saleFive), 1);

    // (b) The other change committed after this one read its state but before
    // its insert: the sequence guard rejects it (23514) and it maps to conflict.
    const staleRead = barrier();
    const staleResume = barrier();
    let hooked = false;
    const staleAttempt = withTenantAs(
      concurrentDatabase.db,
      tenantA,
      linkCapability,
      (transaction, identity) => {
        // Drizzle builders run lazily when awaited: delay only that execution
        // for the first insert, so the state read before it can go stale.
        const delayExecution = (builder: object): object =>
          new Proxy(builder, {
            get(target, property) {
              const value = Reflect.get(target, property, target);
              if (property === "then" && typeof value === "function") {
                return (
                  resolve: (value: unknown) => void,
                  reject: (reason: unknown) => void
                ) => {
                  staleRead.release();
                  return staleResume.released.then(() =>
                    value.call(target, resolve, reject)
                  );
                };
              }
              if (typeof value === "function") {
                return (...args: unknown[]) => {
                  const result = value.apply(target, args);
                  return typeof result === "object" && result !== null
                    ? delayExecution(result)
                    : result;
                };
              }
              return value;
            },
          });
        const delayed = new Proxy(transaction, {
          get(target, property) {
            const value = Reflect.get(target, property, target);
            if (property === "insert" && typeof value === "function") {
              return (...args: unknown[]) => {
                const builder = value.apply(target, args);
                if (hooked) {
                  return builder;
                }
                hooked = true;
                return delayExecution(builder);
              };
            }
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        return changeSaleCustomerLink(delayed, identity, {
          action: "assign",
          customerId: customerOne.id,
          expectedVersion: 0,
          saleId: saleSix,
        });
      }
    );
    const staleOutcome = staleAttempt.then(
      () => "committed",
      (error: unknown) => error
    );
    await staleRead.released;
    await change(tenantA, {
      action: "assign",
      customerId: customerTwo.id,
      expectedVersion: 0,
      saleId: saleSix,
    });
    staleResume.release();
    const staleResult = await staleOutcome;
    assert.ok(
      staleResult instanceof SaleCustomerLinkVersionConflictError,
      `an insert whose state went stale before it ran conflicts cleanly (got ${staleResult instanceof Error ? redactedFailure(staleResult).split("\n")[0] : String(staleResult)})`
    );
    assert.equal(await rowCount(saleSix), 1);
    assert.equal(
      (await read(tenantA, saleSix)).current.customerId,
      customerTwo.id
    );

    // (c) Archiving a customer while another transaction links it: the link
    // waits for the archive (FOR SHARE vs FOR UPDATE) and then sees it archived.
    const racer = await newCustomer(tenantA, "Corrida de arquivo");
    const archiveOpen = barrier();
    const archiveDone = barrier();
    const archiver = withTenantAs(
      concurrentDatabase.db,
      tenantA,
      "customer:update",
      async (transaction, identity) => {
        await archiveCustomer(transaction, identity, {
          expectedVersion: racer.version,
          id: racer.id,
        });
        archiveDone.release();
        await archiveOpen.released;
      }
    );
    await archiveDone.released;
    const linkVsArchive = change(
      tenantA,
      {
        action: "assign",
        customerId: racer.id,
        expectedVersion: 0,
        saleId: saleSeven,
      },
      concurrentDatabase
    ).then(
      () => "committed",
      (error: unknown) => error
    );
    await pause(400);
    archiveOpen.release();
    await archiver;
    assert.ok(
      (await linkVsArchive) instanceof SaleCustomerArchivedError,
      "a customer archived concurrently is never newly linked"
    );
    assert.equal(await rowCount(saleSeven), 0);

    // (d) A failing audit event rolls the new version back with it.
    await assert.rejects(
      () =>
        change(tenantA, {
          action: "assign",
          customerId: customerOne.id,
          expectedVersion: 0,
          requestId: "not-a-uuid",
          saleId: saleSeven,
        }),
      TenantAuditEventError
    );
    assert.equal(await rowCount(saleSeven), 0);
    assert.deepEqual((await read(tenantA, saleSeven)).current, {
      customerId: null,
      version: 0,
    });
    tests.push(
      "deterministic interleavings: an insert waiting on the unique version index and an insert gone stale before it runs both conflict cleanly; a customer archived concurrently is never newly linked; a failing audit event rolls the version back"
    );
    // --------------------------------------------- 6. database-level guards
    const insertLink = (
      tenant: TenantFixture,
      values: {
        action: string;
        customerId: string | null;
        orgId?: string;
        saleId: string;
        version: number;
      }
    ) =>
      withRuntimeSqlContext(runtimeUrl, tenant, (client) =>
        client.query(
          "INSERT INTO public.sale_customer_links (organization_id, sale_id, customer_id, action, version) VALUES ($1, $2, $3, $4, $5)",
          [
            values.orgId ?? tenant.organizationId,
            values.saleId,
            values.customerId,
            values.action,
            values.version,
          ]
        )
      );
    const current = await read(tenantA, saleOne);
    assert.equal(current.current.version, 4);
    await expectSqlState(
      () =>
        insertLink(tenantA, {
          action: "reassign",
          customerId: customerOne.id,
          saleId: saleOne,
          version: 9,
        }),
      "23514",
      "a version gap is rejected",
      "sale_customer_links_version_sequence"
    );
    await expectSqlState(
      () =>
        insertLink(tenantA, {
          action: "assign",
          customerId: customerOne.id,
          saleId: saleOne,
          version: 5,
        }),
      "23514",
      "assign over an existing customer is rejected",
      "sale_customer_links_transition_valid"
    );
    await expectSqlState(
      () =>
        insertLink(tenantA, {
          action: "reassign",
          customerId: customerThree.id,
          saleId: saleOne,
          version: 5,
        }),
      "23514",
      "reassign to the same customer is rejected",
      "sale_customer_links_transition_valid"
    );
    await expectSqlState(
      () =>
        insertLink(tenantA, {
          action: "unassign",
          customerId: null,
          saleId: saleFour,
          version: 1,
        }),
      "23514",
      "the first version must assign",
      "sale_customer_links_transition_valid"
    );
    await expectSqlState(
      () =>
        insertLink(tenantA, {
          action: "unassign",
          customerId: customerOne.id,
          saleId: saleOne,
          version: 5,
        }),
      "23514",
      "unassign cannot name a customer",
      "sale_customer_links_customer_matches_action"
    );
    await expectSqlState(
      () =>
        insertLink(tenantA, {
          action: "reassign",
          customerId: archivedBefore.id,
          saleId: saleOne,
          version: 5,
        }),
      "23514",
      "the database refuses to link an archived customer",
      "sale_customer_links_customer_active"
    );
    await expectSqlState(
      () =>
        insertLink(tenantA, {
          action: "reassign",
          customerId: customerOfB.id,
          saleId: saleOne,
          version: 5,
        }),
      "23514",
      "a customer of another organization cannot be linked",
      "sale_customer_links_customer_active"
    );
    await expectSqlState(
      () =>
        insertLink(tenantA, {
          action: "assign",
          customerId: customerOfB.id,
          orgId: tenantB.organizationId,
          saleId: saleOfB,
          version: 1,
        }),
      "23514",
      "INSERT cannot claim another organization (the guard rejects before RLS WITH CHECK)",
      "sale_customer_links_customer_active"
    );
    assert.equal(await rowCount(saleOne), 4);
    // The guard fires before RLS, so prove the INSERT policy on its own with the
    // guard disabled (restored in the finally block below).
    await admin.pool.query(
      "ALTER TABLE public.sale_customer_links DISABLE TRIGGER sale_customer_links_transition_guard"
    );
    guardDisabled = true;
    try {
      await expectSqlState(
        () =>
          insertLink(tenantA, {
            action: "assign",
            customerId: customerOfB.id,
            orgId: tenantB.organizationId,
            saleId: saleOfB,
            version: 1,
          }),
        "42501",
        "RLS alone rejects an INSERT that claims another organization"
      );
      await expectSqlState(
        () =>
          insertLink(
            { organizationId: tenantA.organizationId, userId: outsider.userId },
            {
              action: "assign",
              customerId: customerOne.id,
              saleId: saleFour,
              version: 1,
            }
          ),
        "42501",
        "RLS alone rejects a user without an active membership"
      );
      await admin.pool.query(
        "UPDATE public.organizations SET status = 'suspended' WHERE id = $1",
        [tenantD.organizationId]
      );
      await expectSqlState(
        () =>
          insertLink(tenantD, {
            action: "assign",
            customerId: customerOfD.id,
            saleId: saleOfD,
            version: 1,
          }),
        "42501",
        "RLS alone rejects an INSERT for a suspended organization"
      );
      await admin.pool.query(
        "UPDATE public.organizations SET status = 'active' WHERE id = $1",
        [tenantD.organizationId]
      );
      await insertLink(tenantD, {
        action: "assign",
        customerId: customerOfD.id,
        saleId: saleOfD,
        version: 1,
      });
      assert.equal(await rowCount(saleOfD), 1);
    } finally {
      await admin.pool.query(
        "UPDATE public.organizations SET status = 'active' WHERE id = $1",
        [tenantD.organizationId]
      );
      await admin.pool.query(
        "ALTER TABLE public.sale_customer_links ENABLE TRIGGER sale_customer_links_transition_guard"
      );
      guardDisabled = false;
    }
    assert.equal(await rowCount(saleFour), 0);
    tests.push(
      "the INSERT policy independently rejects cross-organization claims, users without membership, and suspended organizations (guard disabled for the probe, restored after)"
    );
    for (const statement of [
      "UPDATE public.sale_customer_links SET action = 'assign'",
      "DELETE FROM public.sale_customer_links",
      "TRUNCATE public.sale_customer_links",
      "UPDATE public.sales SET currency = 'BRL'",
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: each denial is its own probe and must not run concurrently
      await expectSqlState(
        () =>
          withRuntimeSqlContext(runtimeUrl, tenantA, (client) =>
            client.query(statement)
          ),
        "42501",
        `runtime cannot run: ${statement}`
      );
    }
    const visibleToB = await withRuntimeSqlContext(
      runtimeUrl,
      tenantB,
      (client) => client.query("SELECT sale_id FROM public.sale_customer_links")
    );
    assert.deepEqual(visibleToB.rows, []);
    const privileges = await admin.pool.query<{
      can_delete: boolean;
      can_insert: boolean;
      can_select: boolean;
      can_update: boolean;
      force_rls: boolean;
    }>(
      "SELECT has_table_privilege($1, 'public.sale_customer_links', 'SELECT') AS can_select, has_table_privilege($1, 'public.sale_customer_links', 'INSERT') AS can_insert, has_table_privilege($1, 'public.sale_customer_links', 'UPDATE') AS can_update, has_table_privilege($1, 'public.sale_customer_links', 'DELETE') AS can_delete, (SELECT relforcerowsecurity FROM pg_class WHERE oid = 'public.sale_customer_links'::regclass) AS force_rls",
      [runtimeRole]
    );
    assert.deepEqual(privileges.rows, [
      {
        can_delete: false,
        can_insert: true,
        can_select: true,
        can_update: false,
        force_rls: true,
      },
    ]);
    const guardAcl = await admin.pool.query<{ can_execute: boolean }>(
      "SELECT has_function_privilege('public', 'public.guard_sale_customer_link_transition()', 'EXECUTE') AS can_execute"
    );
    assert.equal(guardAcl.rows[0]?.can_execute, false);
    tests.push(
      "PostgreSQL itself rejects version gaps, invalid transitions, first-version unassign, archived or foreign customers, cross-organization inserts; runtime has SELECT+INSERT only under FORCE RLS, no UPDATE/DELETE/TRUNCATE, and other tenants see nothing"
    );

    // ------------------------------------------- what a customer bought, in the read that names the customer
    const buyer = await newCustomer(tenantA, "Comprador");
    const other = await newCustomer(tenantA, "Outro");
    const idle = await newCustomer(tenantA, "Sem compra");
    const onlyReturned = await newCustomer(tenantA, "Só devolveu");
    const buyerOfB = await newCustomer(tenantB, "Comprador de B");
    const kept = await newSale(tenantA, "P1");
    const keptReturned = await newSale(tenantA, "P2");
    const cancelledSale = await newSale(tenantA, "P3");
    const moved = await newSale(tenantA, "P4");
    const received = await newSale(tenantA, "P5");
    const older = await newSale(tenantA, "P7", 96);
    const removed = await newSale(tenantA, "P8");
    const discounted = await newSale(tenantA, "P9", 3, {
      adjustments: [
        { amount: "5.00", kind: "discount" },
        { amount: "3.00", kind: "freight" },
      ],
      lines: [
        { price: "10.00", quantity: 3 },
        { price: "7.33", quantity: 2 },
      ],
    });
    const twoReturns = await newSale(tenantA, "P10", 3, {
      adjustments: [
        { amount: "4.01", kind: "discount" },
        { amount: "1.25", kind: "surcharge" },
        { amount: "0.40", kind: "payment_surcharge" },
      ],
      lines: [
        { price: "10.00", quantity: 2 },
        { price: "3.33", quantity: 3 },
      ],
    });
    const fullyReturned = await newSale(tenantA, "P11", 3, {
      adjustments: [
        { amount: "2.00", kind: "discount" },
        { amount: "1.50", kind: "freight" },
      ],
      lines: [
        { price: "9.99", quantity: 1 },
        { price: "4.50", quantity: 2 },
      ],
    });
    const saleOfBuyerB = await newSale(tenantB, "P6");
    const returnedAlone = await newSale(tenantA, "P12");
    for (const [tenant, saleId, customerId] of [
      [tenantA, kept, buyer.id],
      [tenantA, keptReturned, buyer.id],
      [tenantA, cancelledSale, buyer.id],
      [tenantA, moved, buyer.id],
      [tenantA, received, other.id],
      [tenantA, older, buyer.id],
      [tenantA, removed, buyer.id],
      [tenantA, discounted, buyer.id],
      [tenantA, twoReturns, buyer.id],
      [tenantA, fullyReturned, buyer.id],
      [tenantA, returnedAlone, onlyReturned.id],
      [tenantB, saleOfBuyerB, buyerOfB.id],
    ] as const) {
      // biome-ignore lint/performance/noAwaitInLoops: each assignment is its own version history
      await change(tenant, {
        action: "assign",
        customerId,
        expectedVersion: 0,
        saleId,
      });
    }
    await change(tenantA, {
      action: "reassign",
      customerId: other.id,
      expectedVersion: 1,
      saleId: moved,
    });
    await change(tenantA, {
      action: "reassign",
      customerId: buyer.id,
      expectedVersion: 1,
      saleId: received,
    });
    await change(tenantA, {
      action: "unassign",
      expectedVersion: 1,
      saleId: removed,
    });
    await withTenantAs(
      runtimeDatabase.db,
      tenantA,
      "sale:cancel",
      (transaction, identity) =>
        cancelSale(transaction, identity, {
          commandId: randomUUID(),
          commandVersion: 1,
          saleId: cancelledSale,
        })
    );
    await withTenantAs(
      runtimeDatabase.db,
      tenantA,
      "sale:return",
      (transaction, identity) =>
        createSaleReturn(transaction, identity, {
          commandId: randomUUID(),
          commandVersion: 1,
          items: [{ position: 0, restockedQuantity: 1, returnedQuantity: 1 }],
          saleId: keptReturned,
        })
    );
    await returnUnits(tenantA, discounted, [
      { position: 0, returnedQuantity: 1 },
      { position: 1, returnedQuantity: 1 },
    ]);
    await returnUnits(tenantA, twoReturns, [
      { position: 0, returnedQuantity: 1 },
    ]);
    await returnUnits(tenantA, twoReturns, [
      { position: 0, returnedQuantity: 1 },
      { position: 1, returnedQuantity: 1 },
    ]);
    await returnUnits(tenantA, fullyReturned, [
      { position: 0, returnedQuantity: 1 },
      { position: 1, returnedQuantity: 1 },
    ]);
    await returnUnits(tenantA, fullyReturned, [
      { position: 1, returnedQuantity: 1 },
    ]);
    await returnUnits(tenantA, returnedAlone, [
      { position: 0, returnedQuantity: 2 },
    ]);

    const sentStatements: string[] = [];
    const originalQuery = Client.prototype.query;
    Client.prototype.query = function recordedQuery(
      this: Client,
      ...args: unknown[]
    ) {
      const [first] = args;
      sentStatements.push(
        typeof first === "string"
          ? first
          : String((first as { text?: string }).text)
      );
      return (originalQuery as (...inner: unknown[]) => unknown).apply(
        this,
        args
      );
    } as typeof Client.prototype.query;
    let overhead = 0;
    let listCount = 0;
    let getCount = 0;
    let listed: Awaited<ReturnType<typeof listCustomers>>;
    let summarized: Awaited<ReturnType<typeof getCustomer>>;
    try {
      await withTenantAs(runtimeDatabase.db, tenantA, "customer:update", () =>
        Promise.resolve()
      );
      overhead = sentStatements.length;
      sentStatements.length = 0;
      listed = await withTenantAs(
        runtimeDatabase.db,
        tenantA,
        "customer:update",
        (transaction, identity) =>
          listCustomers(transaction, identity, { status: "all" })
      );
      listCount = sentStatements.length;
      sentStatements.length = 0;
      summarized = await withTenantAs(
        runtimeDatabase.db,
        tenantA,
        "customer:update",
        (transaction, identity) => getCustomer(transaction, identity, buyer.id)
      );
      getCount = sentStatements.length;
    } finally {
      Client.prototype.query = originalQuery;
    }
    assert.ok(overhead > 0);
    assert.equal(
      listCount,
      overhead + 1,
      "customer.list stays one statement beyond the entry of the tenant transaction"
    );
    assert.equal(
      getCount,
      overhead + 1,
      "customer.get stays one statement beyond the entry of the tenant transaction"
    );

    const countedDays = await admin.pool.query<{ last: string }>(
      "SELECT max(occurred_on)::text AS last FROM public.sales WHERE id = ANY($1::uuid[])",
      [[kept, keptReturned, received, older]]
    );
    const lastDay = countedDays.rows[0]?.last;
    assert.ok(lastDay);
    const olderDay = await admin.pool.query<{ day: string }>(
      "SELECT occurred_on::text AS day FROM public.sales WHERE id = $1",
      [older]
    );
    assert.ok((olderDay.rows[0]?.day ?? lastDay) < lastDay);
    // the report's own rule, worked out by the economics engine from the facts of every sale of the store: the net
    // sales of a counted sale plus its commercial surcharges, which is the total due minus what its returns gave back
    const toCents = (amount: string) => {
      const [whole = "0", fraction = ""] = amount.split(".");
      return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
    };
    const toReais = (cents: bigint) =>
      `${cents / 100n}.${String(cents % 100n).padStart(2, "0")}`;
    const storeSales = await admin.pool.query<{
      id: string;
      occurred_on: string;
    }>(
      "SELECT id, occurred_on::text AS occurred_on FROM public.sales WHERE organization_id = $1 ORDER BY occurred_on, id",
      [tenantA.organizationId]
    );
    const firstDay = storeSales.rows[0]?.occurred_on;
    const lastStoreDay = storeSales.rows.at(-1)?.occurred_on;
    assert.ok(firstDay && lastStoreDay);
    const reportFacts = await withAuthorizedTenantTransaction(
      runtimeDatabase.db,
      {
        authenticatedUserId: tenantA.userId,
        capability: "report:read",
        isolationLevel: "repeatable read",
        requestedOrganizationId: tenantA.organizationId,
        requireLegalAcceptance: false,
      },
      (transaction, identity) =>
        readPeriodFacts(transaction, identity, {
          from: firstDay,
          to: lastStoreDay,
        })
    );
    assert.equal(reportFacts.sales.length, storeSales.rows.length);
    const reportNet = new Map<string, { counted: boolean; net: bigint }>();
    for (const [index, row] of storeSales.rows.entries()) {
      const fact = reportFacts.sales[index];
      assert.ok(fact);
      assert.equal(fact.occurredOn, row.occurred_on);
      const economics = saleEconomics(fact);
      reportNet.set(row.id, {
        counted: economics.counted && economics.unitsSold > 0,
        net:
          toCents(economics.netSales) + toCents(economics.commercialSurcharges),
      });
    }
    const reportTotal = (saleIds: string[]) =>
      toReais(
        saleIds.reduce((total, id) => {
          const entry = reportNet.get(id);
          assert.ok(entry);
          return entry.counted ? total + entry.net : total;
        }, 0n)
      );
    const netOf = (saleId: string) => reportTotal([saleId]);
    // two items of 19.90 and a freight of 5.00 are 44.80 due; one unit returned gives 19.90 back
    assert.equal(netOf(kept), "44.80");
    assert.equal(netOf(keptReturned), "24.90");
    // 30.00 + 14.66 with a discount of 5.00 split by value (3.36 and 1.64) and a freight of 3.00: 42.66 due, and the
    // returns give back 8.88 and 6.51
    assert.equal(netOf(discounted), "27.27");
    for (const id of [
      kept,
      keptReturned,
      received,
      older,
      discounted,
      twoReturns,
    ]) {
      assert.equal(reportNet.get(id)?.counted, true);
    }
    assert.equal(reportNet.get(cancelledSale)?.counted, false);
    assert.equal(reportNet.get(fullyReturned)?.counted, false);
    const buyerSales = [
      kept,
      keptReturned,
      received,
      older,
      discounted,
      twoReturns,
    ];
    assert.deepEqual(summarized.summary, {
      lastPurchaseOn: lastDay,
      purchaseCount: 6,
      totalSpent: reportTotal(buyerSales),
    });
    assert.notEqual(
      summarized.summary.totalSpent,
      "0",
      "the comparison with the report is not between two zeros"
    );
    const rowOf = (id: string) => listed.find((row) => row.id === id);
    assert.equal(rowOf(buyer.id)?.lastPurchaseOn, lastDay);
    assert.equal(rowOf(other.id)?.lastPurchaseOn, lastDay);
    assert.equal(rowOf(idle.id)?.lastPurchaseOn, null);
    assert.equal(
      rowOf(onlyReturned.id)?.lastPurchaseOn,
      null,
      "a customer whose only sale was returned in full has no last purchase"
    );
    assert.equal(
      listed.some((row) => row.id === buyerOfB.id),
      false
    );
    const alone = await withTenantAs(
      runtimeDatabase.db,
      tenantA,
      "customer:update",
      (transaction, identity) => getCustomer(transaction, identity, idle.id)
    );
    assert.deepEqual(alone.summary, {
      lastPurchaseOn: null,
      purchaseCount: 0,
      totalSpent: "0",
    });
    const ofReturned = await withTenantAs(
      runtimeDatabase.db,
      tenantA,
      "customer:update",
      (transaction, identity) =>
        getCustomer(transaction, identity, onlyReturned.id)
    );
    assert.deepEqual(ofReturned.summary, alone.summary);
    const ofOther = await withTenantAs(
      runtimeDatabase.db,
      tenantA,
      "customer:update",
      (transaction, identity) => getCustomer(transaction, identity, other.id)
    );
    assert.equal(ofOther.summary.purchaseCount, 1);
    assert.equal(ofOther.summary.totalSpent, "44.80");
    const ofB = await withTenantAs(
      runtimeDatabase.db,
      tenantB,
      "customer:update",
      (transaction, identity) => getCustomer(transaction, identity, buyerOfB.id)
    );
    assert.equal(ofB.summary.purchaseCount, 1);
    assert.equal(ofB.summary.totalSpent, "44.80");
    await assert.rejects(
      () =>
        withTenantAs(
          runtimeDatabase.db,
          tenantB,
          "customer:update",
          (transaction, identity) =>
            getCustomer(transaction, identity, buyer.id)
        ),
      CustomerNotFoundError
    );
    tests.push(
      "customer.list and customer.get answer the last purchase and the summary in one statement each: only confirmed sales that were not cancelled or returned in full and whose current attribution is the customer count, and the total is the net sale the report uses (discount, partial return with its share of the discount, a sale returned in two steps), and another store neither sees nor adds to them"
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
    if (guardDisabled) {
      await admin.pool.query(
        "ALTER TABLE public.sale_customer_links ENABLE TRIGGER sale_customer_links_transition_guard"
      );
    }
    if (runtime) {
      await runtime.pool.end();
    }
    if (concurrent) {
      await concurrent.pool.end();
    }
    if (loginRole && loginRoleCreated) {
      await admin.pool.query(`DROP ROLE "${loginRole}"`);
    }
    await admin.pool.end();
  }
}

run().catch((error: unknown) => {
  console.error(
    `Sale customer link PostgreSQL gate failed (${redactedFailure(error)})`
  );
  process.exitCode = 1;
});
