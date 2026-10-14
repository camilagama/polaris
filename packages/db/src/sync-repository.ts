import { and, asc, eq, gt, sql } from "drizzle-orm";
import { syncChanges } from "./schema/sync";
import type {
  TenantRequestIdentity,
  TenantRequestTransaction,
} from "./tenant-transaction";

export const SYNC_PULL_DEFAULT_LIMIT = 200;
export const SYNC_PULL_MAX_LIMIT = 500;
const MAX_CURSOR = Number.MAX_SAFE_INTEGER;
const cursorTextPattern = /^\d{1,16}$/;

export type SyncEntityType =
  | "category"
  | "customer"
  | "inventory_balance"
  | "payment_profile"
  | "product"
  | "sale";

export class InvalidSyncCursorError extends Error {
  constructor() {
    super("invalid_sync_cursor");
    this.name = "InvalidSyncCursorError";
  }
}

export interface SyncChange {
  entityId: string;
  entityType: SyncEntityType;
  /** The sequence of the latest change of this entity within the page. */
  seq: number;
}

export interface SyncPullResult {
  changes: SyncChange[];
  hasMore: boolean;
  /** Where the next pull continues; the page's last sequence, or the input cursor. */
  nextCursor: number;
}

/** A cursor is a non-negative integer sequence; anything else is refused. */
export function parseSyncCursor(cursor: string | number | null | undefined) {
  if (cursor === null || cursor === undefined || cursor === "") {
    return 0;
  }
  const value = typeof cursor === "number" ? cursor : Number(cursor);
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_CURSOR ||
    (typeof cursor === "string" && !cursorTextPattern.test(cursor))
  ) {
    throw new InvalidSyncCursorError();
  }
  return value;
}

/**
 * The latest committed sequence of the organization. A device records it
 * BEFORE reading a snapshot, then pulls from it: changes that land while the
 * snapshot is read are applied again, idempotently, and none is missed.
 */
export async function getSyncCursor(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity
): Promise<number> {
  const [row] = await transaction
    .select({ last: sql<number>`coalesce(max(${syncChanges.seq}), 0)::float8` })
    .from(syncChanges)
    .where(eq(syncChanges.organizationId, identity.organizationId));
  return Number(row?.last ?? 0);
}

/**
 * The changes after a cursor, in sequence order. Entities changed several times
 * in the page appear once, at their latest sequence; the cursor still advances
 * to the page's last sequence. Because sequences are assigned in commit order,
 * a page always continues exactly where the previous one stopped.
 */
export async function pullSyncChanges(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  input: { cursor?: string | number | null; limit?: number }
): Promise<SyncPullResult> {
  const cursor = parseSyncCursor(input.cursor);
  const limit = input.limit ?? SYNC_PULL_DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > SYNC_PULL_MAX_LIMIT) {
    throw new RangeError("invalid_sync_pull_limit");
  }
  const rows = await transaction
    .select({
      entityId: syncChanges.entityId,
      entityType: syncChanges.entityType,
      seq: syncChanges.seq,
    })
    .from(syncChanges)
    .where(
      and(
        eq(syncChanges.organizationId, identity.organizationId),
        gt(syncChanges.seq, cursor)
      )
    )
    .orderBy(asc(syncChanges.seq))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const latest = new Map<string, SyncChange>();
  for (const row of page) {
    if (row.seq === null) {
      throw new Error("sync_change_without_sequence");
    }
    const key = `${row.entityType}:${row.entityId}`;
    latest.delete(key);
    latest.set(key, {
      entityId: row.entityId,
      entityType: row.entityType as SyncEntityType,
      seq: row.seq,
    });
  }
  const last = page.at(-1);
  return {
    changes: [...latest.values()],
    hasMore,
    nextCursor: last?.seq ?? cursor,
  };
}
