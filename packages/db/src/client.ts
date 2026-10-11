import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { authSchema } from "./schema/auth";
import { categories } from "./schema/category";
import { customers } from "./schema/customer";
import { organizationSchema } from "./schema/organization";
import { dbPocOperations } from "./schema/poc";
import { saleAdjustments, saleItems, sales } from "./schema/sale";
import { authSecurityAuditEvents } from "./schema/security-audit";
import { tenantAuditEvents } from "./schema/tenant-audit";
import { inventoryBalances, stockMovements } from "./schema/inventory";
import { mediaAssets, productMedia, variantMedia } from "./schema/media";
import { mediaCleanupClaims } from "./schema/media-cleanup";

const databaseSchema = {
  ...authSchema,
  ...organizationSchema,
  authSecurityAuditEvents,
  categories,
  customers,
  dbPocOperations,
  inventoryBalances,
  mediaAssets,
  mediaCleanupClaims,
  productMedia,
  saleAdjustments,
  saleItems,
  sales,
  stockMovements,
  variantMedia,
  tenantAuditEvents,
};

export interface DatabaseOptions {
  connectionTimeoutMillis?: number;
  idleTimeoutMillis?: number;
  maxConnections?: number;
}

export function createDatabase(
  connectionString: string,
  options: DatabaseOptions = {}
) {
  const pool = new Pool({
    connectionString,
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? 5000,
    idleTimeoutMillis: options.idleTimeoutMillis ?? 30_000,
    max: options.maxConnections ?? 5,
  });

  return {
    db: drizzle({ client: pool, schema: databaseSchema }),
    pool,
  };
}
