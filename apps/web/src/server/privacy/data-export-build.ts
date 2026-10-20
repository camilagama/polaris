import { EXPORT_DATASETS } from "@polaris/db/export-datasets";
import {
  describeDataset,
  type ExportImage,
  readDatasetPage,
  readImagePage,
} from "@polaris/db/export-reader";
import type { TenantRequestTransaction } from "@polaris/db/tenant-transaction";
import { csvFile, csvRow } from "@polaris/domain/privacy/csv";
import {
  EXPORT_IMAGE_PART_BYTES,
  EXPORT_PAGE_ROWS,
  EXPORT_README,
  type ExportDatasetSummary,
  type ExportFormat,
  type ExportManifest,
  exportFileName,
  MAX_EXPORT_DATA_BYTES,
  MAX_EXPORT_IMAGES,
} from "@polaris/domain/privacy/data-export";
import { ZipBuilder, zipEntryOverhead } from "@polaris/domain/privacy/zip";
import type { MediaBucketBinding } from "../environment";

/** The copy is bigger than what one run can hold: it fails for good instead of half-working. */
export class ExportTooLargeError extends Error {
  readonly code = "export_too_large";

  constructor() {
    super("export_too_large");
    this.name = "ExportTooLargeError";
  }
}

export interface CollectedExport {
  /** The files of the data archive, in the order they are added. */
  entries: { bytes: Uint8Array; name: string }[];
  images: ExportImage[];
  summaries: ExportDatasetSummary[];
}

const encoder = new TextEncoder();
const IMAGE_PAGE = 500;

function jsonFile(rowsAsJson: readonly string[]): string {
  return `[\n${rowsAsJson.join(",\n")}\n]\n`;
}

interface TableRead {
  csvLines: string[];
  jsonLines: string[];
  rows: number;
  shape: Awaited<ReturnType<typeof describeDataset>>;
}

/**
 * One table, in pages, written straight into the files that were asked for: only text is kept, never
 * the rows as objects, so the memory is the size of the files. `room` is what is left of the ceiling.
 */
async function readTable(
  transaction: TenantRequestTransaction,
  organizationId: string,
  dataset: (typeof EXPORT_DATASETS)[number],
  formats: readonly ExportFormat[],
  room: number
): Promise<TableRead> {
  const shape = await describeDataset(transaction, dataset);
  const wantJson = formats.includes("json");
  const wantCsv = formats.includes("csv");
  const jsonLines: string[] = [];
  const csvLines: string[] = [];
  let rows = 0;
  let chars = 0;
  let after: unknown[] | null = null;
  do {
    // biome-ignore lint/performance/noAwaitInLoops: each page starts where the one before ended.
    const page = await readDatasetPage(
      transaction,
      organizationId,
      dataset,
      shape,
      after,
      EXPORT_PAGE_ROWS
    );
    for (const row of page.rows) {
      rows += 1;
      if (wantJson) {
        const kept: Record<string, unknown> = {};
        for (const column of shape.columns) {
          kept[column] = row[column];
        }
        const line = JSON.stringify(kept);
        jsonLines.push(line);
        chars += line.length;
      }
      if (wantCsv) {
        const line = csvRow(shape.columns.map((column) => row[column]));
        csvLines.push(line);
        chars += line.length;
      }
    }
    after = page.next;
    // what is held is bounded by the same ceiling as the files it becomes (a character is at least a byte)
    if (chars > room) {
      throw new ExportTooLargeError();
    }
  } while (after !== null);
  return { csvLines, jsonLines, rows, shape };
}

/** One page of the organization's images after the given asset ID, oldest first. */
export type ImagePageReader = (
  afterAssetId: string | null,
  pageRows: number
) => Promise<ExportImage[]>;

async function readImages(readPage: ImagePageReader): Promise<ExportImage[]> {
  const images: ExportImage[] = [];
  let afterAssetId: string | null = null;
  for (;;) {
    // biome-ignore lint/performance/noAwaitInLoops: each page starts where the one before ended.
    const page = await readPage(afterAssetId, IMAGE_PAGE);
    images.push(...page);
    // each image is a read from storage and the run has a ceiling on those: fail before any work, not in the middle
    if (images.length > MAX_EXPORT_IMAGES) {
      throw new ExportTooLargeError();
    }
    if (page.length < IMAGE_PAGE) {
      return images;
    }
    afterAssetId = page.at(-1)?.assetId ?? null;
  }
}

/**
 * Reads everything the person who asked may read, in the snapshot of the transaction the caller
 * opened, and turns each table into the JSON and CSV files that were asked for (an images-only
 * copy reads no table). Only memory work happens between queries, so the transaction stays short.
 * The images are read in the same transaction, unless the caller names another reader (a closed
 * organization's reader does not read the storage keys: the run reads them through its lease).
 */
export async function collectExport(
  transaction: TenantRequestTransaction,
  organizationId: string,
  formats: readonly ExportFormat[],
  readImagePageWith?: ImagePageReader
): Promise<CollectedExport> {
  const entries: CollectedExport["entries"] = [];
  const summaries: ExportDatasetSummary[] = [];
  let held = 0;
  const hold = (name: string, text: string) => {
    const bytes = encoder.encode(text);
    held += bytes.length;
    if (held > MAX_EXPORT_DATA_BYTES) {
      throw new ExportTooLargeError();
    }
    entries.push({ bytes, name });
  };

  const wantsTables = formats.includes("json") || formats.includes("csv");
  for (const dataset of wantsTables ? EXPORT_DATASETS : []) {
    // biome-ignore lint/performance/noAwaitInLoops: one table at a time keeps the transaction's memory flat.
    const table = await readTable(
      transaction,
      organizationId,
      dataset,
      formats,
      MAX_EXPORT_DATA_BYTES - held
    );
    summaries.push({
      columns: table.shape.columns,
      name: dataset.name,
      rows: table.rows,
    });
    if (formats.includes("json")) {
      hold(`data/${dataset.name}.json`, jsonFile(table.jsonLines));
    }
    if (formats.includes("csv")) {
      hold(
        `csv/${dataset.name}.csv`,
        csvFile(table.shape.columns, table.csvLines)
      );
    }
  }

  const images = formats.includes("images")
    ? await readImages(
        readImagePageWith ??
          ((afterAssetId, pageRows) =>
            readImagePage(transaction, organizationId, afterAssetId, pageRows))
      )
    : [];
  return { entries, images, summaries };
}

/** The data archive: what the tables hold, what the copy is, and how to read it. */
export function buildDataArchive(input: {
  collected: CollectedExport;
  exportId: string;
  formats: readonly ExportFormat[];
  generatedAt: Date;
  organizationId: string;
}): Uint8Array {
  const manifest: ExportManifest = {
    datasets: input.collected.summaries,
    exportId: input.exportId,
    formats: [...input.formats],
    generatedAt: input.generatedAt.toISOString(),
    images: input.formats.includes("images")
      ? { total: input.collected.images.length }
      : null,
    organizationId: input.organizationId,
    version: 1,
  };
  const zip = new ZipBuilder();
  zip.add("LEIA-ME.txt", encoder.encode(EXPORT_README));
  zip.add(
    "manifest.json",
    encoder.encode(`${JSON.stringify(manifest, null, 2)}\n`)
  );
  for (const entry of input.collected.entries) {
    zip.add(entry.name, entry.bytes);
  }
  return zip.finish();
}

export interface ImagePartSink {
  /** Stores one finished part (ordinal counts from 2: the data archive is the first file). */
  store: (part: {
    bytes: Uint8Array;
    name: string;
    ordinal: number;
  }) => Promise<void>;
}

/** A reserve for the part's index, so closing a part never pushes it past the ceiling. */
const INDEX_RESERVE_BYTES = 256 * 1024;

interface PartIndexEntry {
  assetId: string;
  bytes: number;
  file: string;
}

/**
 * The images, in parts that each fit in memory. An image that cannot be read from storage is left
 * out and listed in the index of the last part, never silently dropped. Returns how many parts.
 */
export async function buildImageParts(input: {
  bucket: Pick<MediaBucketBinding, "get">;
  generatedAt: Date;
  images: readonly ExportImage[];
  sink: ImagePartSink;
}): Promise<{ omitted: number; parts: number }> {
  let zip = new ZipBuilder();
  let included: PartIndexEntry[] = [];
  const omitted: { assetId: string; reason: string }[] = [];
  let parts = 0;

  const close = async (final: boolean) => {
    if (included.length === 0 && !(final && omitted.length > 0)) {
      return;
    }
    parts += 1;
    zip.add(
      "indice.json",
      encoder.encode(
        `${JSON.stringify(
          { images: included, ...(final ? { omitted } : {}), part: parts },
          null,
          2
        )}\n`
      )
    );
    await input.sink.store({
      bytes: zip.finish(),
      name: exportFileName("images", parts, input.generatedAt),
      ordinal: parts + 1,
    });
    zip = new ZipBuilder();
    included = [];
  };

  for (const image of input.images) {
    // biome-ignore lint/performance/noAwaitInLoops: one image in memory at a time.
    const object = await input.bucket.get(image.storageKey);
    if (!object) {
      omitted.push({ assetId: image.assetId, reason: "object_missing" });
      continue;
    }
    const bytes = new Uint8Array(await object.arrayBuffer());
    const file = `imagens/${image.assetId}.webp`;
    const cost = bytes.length + zipEntryOverhead(file);
    if (
      included.length > 0 &&
      zip.size + cost + INDEX_RESERVE_BYTES > EXPORT_IMAGE_PART_BYTES
    ) {
      await close(false);
    }
    zip.add(file, bytes);
    included.push({ assetId: image.assetId, bytes: bytes.length, file });
  }
  await close(true);
  return { omitted: omitted.length, parts };
}
