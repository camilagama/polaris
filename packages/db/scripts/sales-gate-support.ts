import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { Client } from "pg";
import type { createDatabase } from "../src/client";
import { createProduct } from "../src/product-repository";
import { productVariants } from "../src/schema/product";
import {
  type TenantRequestIdentity,
  type TenantRequestTransaction,
  withAuthorizedTenantTransaction,
} from "../src/tenant-transaction";

export const runtimeRole = "polaris_pr11_runtime";
export const poolerPattern = /pooler/i;
export const disposableHostPattern =
  /^ep-[a-z-]+-[a-z0-9]+\.c-2\.sa-east-1\.aws\.neon\.tech$/;
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

export async function createTenantFixture(
  adminPool: AdminPool,
  label: string
): Promise<TenantFixture> {
  const userId = randomUUID();
  const organizationId = randomUUID();
  await adminPool.query(
    'INSERT INTO public."user" (id, name, email, email_verified) VALUES ($1, $2, $3, true)',
    [userId, `PR43 sales gate ${label}`, `pr43-${userId}@example.invalid`]
  );
  await adminPool.query(
    "INSERT INTO public.organizations (id, name, timezone) VALUES ($1, $2, $3)",
    [organizationId, `PR43 sales gate ${label}`, "America/Sao_Paulo"]
  );
  await adminPool.query(
    "INSERT INTO public.memberships (organization_id, user_id, role, status) VALUES ($1, $2, 'owner', 'active')",
    [organizationId, userId]
  );
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
