import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { authSchema } from "./schema/auth";
import { categories } from "./schema/category";
import { customers } from "./schema/customer";
import { devices, offlineGrants } from "./schema/device";
import { expenseCategories, expenses } from "./schema/expense";
import { syncChanges, syncCursors } from "./schema/sync";
import { syncCommands } from "./schema/sync-command";
import { inventoryBalances, stockMovements } from "./schema/inventory";
import { mediaAssets, productMedia, variantMedia } from "./schema/media";
import { mediaCleanupClaims } from "./schema/media-cleanup";
import { organizationSchema } from "./schema/organization";
import { paymentProfileRules, paymentProfiles } from "./schema/payment-profile";
import { dbPocOperations } from "./schema/poc";
import { saleAdjustments, saleItems, salePayments, sales } from "./schema/sale";
import { authSecurityAuditEvents } from "./schema/security-audit";
import { tenantAuditEvents } from "./schema/tenant-audit";

const databaseSchema = {
  ...authSchema,
  ...organizationSchema,
  authSecurityAuditEvents,
  categories,
  customers,
  dbPocOperations,
  devices,
  expenseCategories,
  expenses,
  inventoryBalances,
  mediaAssets,
  mediaCleanupClaims,
  offlineGrants,
  paymentProfileRules,
  paymentProfiles,
  productMedia,
  saleAdjustments,
  saleItems,
  salePayments,
  sales,
  stockMovements,
  syncChanges,
  syncCommands,
  syncCursors,
  tenantAuditEvents,
  variantMedia,
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
