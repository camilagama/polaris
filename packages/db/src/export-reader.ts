import { sql } from "drizzle-orm";
import {
  type ExportDataset,
  ORGANIZATION_TABLE,
  quoteIdentifier,
} from "./export-datasets";
import type { TenantRequestTransaction } from "./tenant-transaction";

/**
 * Reads the tables of a data export (plan PR104, ADR 0078). It runs inside a tenant transaction of
 * the person who asked, so row-level security and the column grants of the tenant role decide what
 * is read: the export can never hold more than that person could read through the application.
 * Which columns exist is asked of the catalog (and narrowed to those the role may read), so a
 * column added by a migration is exported without a code change, and a table is read in pages by its
 * primary key so memory does not grow with the table.
 */

export interface DatasetShape {
  /** What is written: the readable columns, minus the ones the dataset leaves out. */
  columns: string[];
  /** What is read: every readable column, because the keyset needs the key. */
  keyColumns: { name: string; type: string }[];
  readable: string[];
  /** The select list: every readable column, instants written as ISO 8601 in UTC. */
  select: string;
}

export type ExportRow = Record<string, unknown>;

const INSTANT_TYPE = "timestamp with time zone";
const ISO_UTC = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"';
const TYPE_NAME = /^[a-z][a-z0-9 ]*(\([0-9]+(,[0-9]+)?\))?$/;

function rowsOf<T>(result: unknown): T[] {
  const candidate = result as { rows?: T[] } | T[];
  return Array.isArray(candidate) ? candidate : (candidate.rows ?? []);
}

/** The columns of a table the current role may read, and its primary key. */
export async function describeDataset(
  transaction: TenantRequestTransaction,
  dataset: ExportDataset
): Promise<DatasetShape> {
  quoteIdentifier(dataset.table);
  const columnRows = rowsOf<{ name: string; type: string }>(
    await transaction.execute(sql`
      SELECT attribute.attname AS name, pg_catalog.format_type(attribute.atttypid, attribute.atttypmod) AS type
        FROM pg_catalog.pg_attribute AS attribute
       WHERE attribute.attrelid = ${`public.${dataset.table}`}::regclass
         AND attribute.attnum > 0
         AND NOT attribute.attisdropped
         AND pg_catalog.has_column_privilege(attribute.attrelid, attribute.attnum, 'SELECT')
       ORDER BY attribute.attnum
    `)
  );
  const keyRows = rowsOf<{ name: string; type: string }>(
    await transaction.execute(sql`
      SELECT attribute.attname AS name, pg_catalog.format_type(attribute.atttypid, attribute.atttypmod) AS type
        FROM pg_catalog.pg_index AS index_row
        CROSS JOIN LATERAL pg_catalog.unnest(index_row.indkey) WITH ORDINALITY AS key_column(attnum, position)
        JOIN pg_catalog.pg_attribute AS attribute
          ON attribute.attrelid = index_row.indrelid AND attribute.attnum = key_column.attnum
       WHERE index_row.indrelid = ${`public.${dataset.table}`}::regclass
         AND index_row.indisprimary
       ORDER BY key_column.position
    `)
  );
  const readable = columnRows.map((column) => column.name);
  if (readable.length === 0) {
    throw new Error(`export_dataset_unreadable:${dataset.table}`);
  }
  if (keyRows.length === 0) {
    throw new Error(`export_dataset_without_primary_key:${dataset.table}`);
  }
  for (const key of keyRows) {
    if (!(readable.includes(key.name) && TYPE_NAME.test(key.type))) {
      throw new Error(`export_dataset_key_unreadable:${dataset.table}`);
    }
  }
  const omitted = new Set(dataset.omit ?? []);
  // an instant is written the same way in every file (the session's own time zone would change it), and the
  // key columns keep their cast back from this text exactly
  const select = columnRows
    .map((column) =>
      column.type === INSTANT_TYPE
        ? `to_char(${quoteIdentifier(column.name)} AT TIME ZONE 'UTC', '${ISO_UTC}') AS ${quoteIdentifier(column.name)}`
        : quoteIdentifier(column.name)
    )
    .join(", ");
  return {
    columns: readable.filter((name) => !omitted.has(name)),
    keyColumns: keyRows,
    readable,
    select,
  };
}

/**
 * One page of a table, after the given key. The rows of one organization only (the filter is the
 * request's own; row-level security is the guarantee), ordered by the primary key.
 */
export async function readDatasetPage(
  transaction: TenantRequestTransaction,
  organizationId: string,
  dataset: ExportDataset,
  shape: DatasetShape,
  after: unknown[] | null,
  pageRows: number
): Promise<{ next: unknown[] | null; rows: ExportRow[] }> {
  const table = sql.raw(`public.${quoteIdentifier(dataset.table)}`);
  const selected = sql.raw(shape.select);
  const keyList = sql.raw(
    shape.keyColumns.map((key) => quoteIdentifier(key.name)).join(", ")
  );
  const scope =
    dataset.table === ORGANIZATION_TABLE
      ? sql`"id" = ${organizationId}`
      : sql`"organization_id" = ${organizationId}`;
  const keyset =
    after === null
      ? sql``
      : sql` AND (${keyList}) > (${sql.join(
          shape.keyColumns.map(
            (key, index) => sql`${after[index]}::${sql.raw(key.type)}`
          ),
          sql`, `
        )})`;
  const result = await transaction.execute(
    sql`SELECT ${selected} FROM ${table} WHERE ${scope}${keyset} ORDER BY ${keyList} LIMIT ${pageRows}`
  );
  const rows = rowsOf<ExportRow>(result);
  const last = rows.at(-1);
  return {
    next:
      rows.length < pageRows || !last
        ? null
        : shape.keyColumns.map((key) => last[key.name]),
    rows,
  };
}

/** The tables that hold an organization's data, from the catalog: what the registry must account for. */
export async function listOrganizationTables(
  transaction: TenantRequestTransaction
): Promise<string[]> {
  const result = await transaction.execute(sql`
    SELECT class.relname AS name
      FROM pg_catalog.pg_class AS class
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = class.relnamespace
     WHERE namespace.nspname = 'public'
       AND class.relkind IN ('r', 'p')
       AND EXISTS (
         SELECT 1 FROM pg_catalog.pg_attribute AS attribute
          WHERE attribute.attrelid = class.oid AND attribute.attname = 'organization_id'
            AND attribute.attnum > 0 AND NOT attribute.attisdropped
       )
     ORDER BY class.relname
  `);
  return rowsOf<{ name: string }>(result).map((row) => row.name);
}

/** An image of the organization: the object to copy into the archive. */
export interface ExportImage {
  assetId: string;
  byteSize: number;
  storageKey: string;
}

/** The images the organization has, oldest first, after the given asset ID. */
export async function readImagePage(
  transaction: TenantRequestTransaction,
  organizationId: string,
  afterAssetId: string | null,
  pageRows: number
): Promise<ExportImage[]> {
  const result = await transaction.execute(sql`
    SELECT id, byte_size, storage_key
      FROM public.media_assets
     WHERE organization_id = ${organizationId}
       AND (${afterAssetId}::uuid IS NULL OR id > ${afterAssetId}::uuid)
     ORDER BY id
     LIMIT ${pageRows}
  `);
  return rowsOf<{ byte_size: number; id: string; storage_key: string }>(
    result
  ).map((row) => ({
    assetId: row.id,
    byteSize: Number(row.byte_size),
    storageKey: row.storage_key,
  }));
}
