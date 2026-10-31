import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";
import { Client } from "pg";
import type { createDatabase } from "../src/client";
import { inventoryCount, receiveStock } from "../src/inventory-repository";
import { createProduct } from "../src/product-repository";
import { type ConfirmSaleResult, confirmSale } from "../src/sale-repository";
import { productVariants } from "../src/schema/product";
import {
  type TenantRequestIdentity,
  type TenantRequestTransaction,
  withAuthorizedTenantTransaction,
} from "../src/tenant-transaction";
import { disposableHostPattern as gateHostPattern } from "./gate-hosts";

export const runtimeRole = "polaris_pr11_runtime";

/**
 * How many migrations the repository ships (the Drizzle journal). A gate
 * database replayed from scratch must have applied exactly this many, so a
 * partially replayed or stale database cannot pass a gate by accident.
 */
export function journalMigrationCount(): number {
  const journal = JSON.parse(
    readFileSync(
      fileURLToPath(new URL("../drizzle/meta/_journal.json", import.meta.url)),
      "utf8"
    )
  ) as { entries: unknown[] };
  return journal.entries.length;
}
export const poolerPattern = /pooler/i;
// Every stage runs against its own disposable branch (for example pr44-...-gate).
export const gateBranchPattern = /^pr\d+-[a-z0-9-]+-gate$/;
// the one list of hosts a gate may connect to
export const disposableHostPattern = gateHostPattern;

const sqlStatePattern = /^[0-9A-Z]{5}$/;

export type Database = ReturnType<typeof createDatabase>["db"];
export type AdminPool = ReturnType<typeof createDatabase>["pool"];

export interface TenantFixture {
  organizationId: string;
  userId: string;
}

export interface ProductFixture {
  productId: string;
  variantId: string;
}

export function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name}.`);
  }
  return value;
}

function errorField(error: unknown, field: "code" | "constraint") {
  const visited = new Set<object>();
  let current: unknown = error;
  while (typeof current === "object" && current !== null) {
    if (visited.has(current)) {
      return;
    }
    visited.add(current);
    const candidate = current as {
      cause?: unknown;
      code?: unknown;
      constraint?: unknown;
    };
    const value = candidate[field];
    if (
      typeof value === "string" &&
      (field === "constraint" || sqlStatePattern.test(value))
    ) {
      return value;
    }
    current = candidate.cause;
  }
}

export function sqlState(error: unknown): string | undefined {
  return errorField(error, "code");
}

export function sqlConstraint(error: unknown): string | undefined {
  return errorField(error, "constraint");
}

export async function expectSqlState(
  operation: () => Promise<unknown>,
  expected: string,
  label: string,
  constraint?: string
): Promise<void> {
  await assert.rejects(
    operation,
    (error: unknown) => {
      assert.equal(sqlState(error), expected, label);
      if (constraint !== undefined) {
        assert.equal(sqlConstraint(error), constraint, `${label} (constraint)`);
      }
      return true;
    },
    label
  );
}

/**
 * An instant a few hours back, always inside the retroactive window and never in
 * the future, so gates do not expire as the calendar moves on. It moves with the hour: "3 hours ago" is
 * yesterday before 03:00 in São Paulo and today after it (the economics gate). A gate that asserts the
 * day of a sale takes the instant from `storeNoon(storeDay(runClock, n))` of `gate-clock.ts` instead.
 */
export function recentInstant(hoursAgo = 3): string {
  return new Date(Date.now() - hoursAgo * 3_600_000).toISOString();
}

export async function createTenantFixture(
  adminPool: Pick<AdminPool, "query">,
  label: string,
  timezone = "America/Sao_Paulo",
  plan: "free" | "pro" = "pro"
): Promise<TenantFixture> {
  const userId = randomUUID();
  const organizationId = randomUUID();
  await adminPool.query(
    'INSERT INTO public."user" (id, name, email, email_verified) VALUES ($1, $2, $3, true)',
    [userId, `PR43 sales gate ${label}`, `pr43-${userId}@example.invalid`]
  );
  await adminPool.query(
    "INSERT INTO public.organizations (id, name, timezone) VALUES ($1, $2, $3)",
    [organizationId, `PR43 sales gate ${label}`, timezone]
  );
  await adminPool.query(
    "INSERT INTO public.memberships (organization_id, user_id, role, status) VALUES ($1, $2, 'owner', 'active')",
    [organizationId, userId]
  );
  // The gates test the domain behaviours, not the plan limits, so a fixture is a paid
  // organization unless a gate asks for the Free plan (no billing record).
  if (plan === "pro") {
    await adminPool.query(
      "INSERT INTO public.organization_billing (organization_id, state, access_ends_at) VALUES ($1, 'active', now() + interval '365 days')",
      [organizationId]
    );
  }
  return { organizationId, userId };
}

export async function withTenantAs<T>(
  database: Database,
  fixture: TenantFixture,
  capability: string,
  operation: (
    transaction: TenantRequestTransaction,
    identity: TenantRequestIdentity
  ) => Promise<T>
): Promise<T> {
  return await withAuthorizedTenantTransaction(
    database,
    {
      authenticatedUserId: fixture.userId,
      capability,
      requestedOrganizationId: fixture.organizationId,
    },
    operation
  );
}

export function withTenant<T>(
  database: Database,
  fixture: TenantFixture,
  operation: (
    transaction: TenantRequestTransaction,
    identity: TenantRequestIdentity
  ) => Promise<T>
): Promise<T> {
  return withTenantAs(database, fixture, "catalog:read", operation);
}

export async function withRuntimeSqlContext<T>(
  connectionString: string,
  fixture: TenantFixture,
  operation: (client: Client) => Promise<T>
): Promise<T> {
  const client = new Client({
    connectionString,
    connectionTimeoutMillis: 5000,
  });
  await client.connect();
  await client.query("BEGIN");
  try {
    await client.query(
      "SELECT set_config('app.organization_id', $1, true), set_config('app.user_id', $2, true)",
      [fixture.organizationId, fixture.userId]
    );
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
}

export function temporaryRuntimeUrl(
  adminUrl: string,
  role: string,
  password: string
) {
  const url = new URL(adminUrl);
  url.username = role;
  url.password = password;
  return url.toString();
}

export async function createProductFixture(
  database: Database,
  fixture: TenantFixture,
  label: string
): Promise<ProductFixture> {
  const product = await withTenant(database, fixture, (transaction, identity) =>
    createProduct(transaction, identity, {
      name: `Produto sintético ${label}`,
      requestId: randomUUID(),
    })
  );
  const [variant] = await withTenant(
    database,
    fixture,
    async (transaction) =>
      await transaction
        .select({ id: productVariants.id })
        .from(productVariants)
        .where(
          and(
            eq(productVariants.organizationId, fixture.organizationId),
            eq(productVariants.productId, product.id)
          )
        )
        .limit(1)
  );
  assert.ok(variant);
  return { productId: product.id, variantId: variant.id };
}

export function redactedFailure(error: unknown): string {
  const code = sqlState(error);
  const name = error instanceof Error ? error.name : "UnknownError";
  const message =
    error instanceof Error
      ? error.message.replace(/postgres(?:ql)?:\/\/[^\s'"]+/gi, "[redacted]")
      : "Unknown gate failure.";
  const stack =
    error instanceof Error && error.stack
      ? error.stack.replace(/postgres(?:ql)?:\/\/[^\s'"]+/gi, "[redacted]")
      : "";
  return `${name}${code ? `, ${code}` : ""}: ${message}${stack ? `\n${stack}` : ""}`;
}

export interface GateRuntime {
  adminPool: AdminPool;
  db: Database;
}

/** A catalog product with one sellable variant and an opening stock (null cost = unknown). */
export async function createSellableProduct(
  runtime: GateRuntime,
  tenant: TenantFixture,
  label: string,
  stock: { cost: string | null; quantity: number }
) {
  const product = await withTenantAs(
    runtime.db,
    tenant,
    "product:create",
    (transaction, identity) =>
      createProduct(transaction, identity, {
        name: `Produto ${label}`,
        requestId: randomUUID(),
      })
  );
  const variant = await runtime.adminPool.query<{ id: string }>(
    "SELECT id FROM public.product_variants WHERE organization_id = $1 AND product_id = $2",
    [tenant.organizationId, product.id]
  );
  const variantId = variant.rows[0]?.id;
  assert.ok(variantId);
  await withTenantAs(
    runtime.db,
    tenant,
    "inventory:adjust",
    async (transaction, identity) => {
      if (stock.cost === null) {
        await inventoryCount(transaction, identity, {
          commandId: randomUUID(),
          commandVersion: 1,
          expectedVersion: 0,
          occurredOn: "2026-10-01",
          physicalQuantity: stock.quantity,
          valuationUnitCost: null,
          variantId,
        });
      } else {
        await receiveStock(transaction, identity, {
          commandId: randomUUID(),
          commandVersion: 1,
          occurredOn: "2026-10-01",
          quantity: stock.quantity,
          unitCost: stock.cost,
          variantId,
        });
      }
    }
  );
  return { productId: product.id, variantId, version: product.version };
}

/** Confirms a plain pix sale without profile for the given variants. */
export function confirmPlainSale(
  runtime: GateRuntime,
  tenant: TenantFixture,
  items: { chargedUnitPrice?: string; quantity: number; variantId: string }[],
  options: { occurredAt?: string } = {}
): Promise<ConfirmSaleResult> {
  return withTenantAs(
    runtime.db,
    tenant,
    "sale:create",
    (transaction, identity) =>
      confirmSale(transaction, identity, {
        adjustments: [],
        commandId: randomUUID(),
        commandVersion: 1,
        items: items.map((item) => ({
          chargedUnitPrice: item.chargedUnitPrice ?? "19.90",
          listedUnitPrice: "20.00",
          quantity: item.quantity,
          variantId: item.variantId,
        })),
        occurredAt: options.occurredAt ?? recentInstant(),
        payment: { anticipationRequested: false, method: "pix" },
        paymentProfile: null,
        requestId: randomUUID(),
      })
  );
}
