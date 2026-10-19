import { describe, expect, it, vi } from "vitest";

const reader = vi.hoisted(() => ({
  describeDataset: vi.fn(),
  readDatasetPage: vi.fn(),
  readImagePage: vi.fn(),
}));

vi.mock("@polaris/db/export-datasets", () => ({
  EXPORT_DATASETS: [
    { name: "alfa", table: "alfa_table" },
    { name: "beta", omit: ["segredo"], table: "beta_table" },
  ],
}));
vi.mock("@polaris/db/export-reader", () => reader);

const { buildDataArchive, collectExport, ExportTooLargeError } = await import(
  "./data-export-build"
);

const transaction = {} as never;
const decoder = new TextDecoder();

function shapeOf(columns: string[]) {
  return {
    columns,
    keyColumns: [{ name: "id", type: "text" }],
    readable: [...columns, "segredo"],
    select: "",
  };
}

function setUp(pagesPerTable = 2) {
  reader.describeDataset.mockImplementation(
    (_tx: unknown, dataset: { table: string }) =>
      Promise.resolve(
        shapeOf(
          dataset.table === "beta_table" ? ["id", "nome"] : ["id", "nome"]
        )
      )
  );
  const served = new Map<string, number>();
  reader.readDatasetPage.mockImplementation(
    (
      _tx: unknown,
      _org: string,
      dataset: { table: string },
      _shape: unknown,
      after: unknown[] | null
    ) => {
      const count = (served.get(dataset.table) ?? 0) + 1;
      served.set(dataset.table, count);
      const last = count >= pagesPerTable;
      return Promise.resolve({
        after,
        next: last ? null : [`k${count}`],
        rows: [
          {
            id: `${dataset.table}-${count}`,
            nome: `=Nome ${count}`,
            segredo: "NUNCA",
          },
        ],
      });
    }
  );
}

describe("collecting an export", () => {
  it("writes each table into the files asked for, across pages, without the columns left out", async () => {
    setUp();
    const collected = await collectExport(transaction, "org_1", [
      "json",
      "csv",
    ]);
    expect(collected.entries.map((entry) => entry.name)).toEqual([
      "data/alfa.json",
      "csv/alfa.csv",
      "data/beta.json",
      "csv/beta.csv",
    ]);
    expect(collected.summaries).toEqual([
      { columns: ["id", "nome"], name: "alfa", rows: 2 },
      { columns: ["id", "nome"], name: "beta", rows: 2 },
    ]);
    const json = decoder.decode(collected.entries[0]?.bytes);
    expect(JSON.parse(json)).toEqual([
      { id: "alfa_table-1", nome: "=Nome 1" },
      { id: "alfa_table-2", nome: "=Nome 2" },
    ]);
    const csvBytes = collected.entries[1]?.bytes ?? new Uint8Array();
    // the byte-order mark is kept (decoding with the default options would drop it)
    expect(Array.from(csvBytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    const csv = decoder.decode(csvBytes);
    expect(csv.startsWith("id,nome\r\n")).toBe(true);
    // a formula typed by a customer is neutralised in the spreadsheet, and kept as it is in the JSON
    expect(csv).toContain("alfa_table-1,'=Nome 1\r\n");
    for (const entry of collected.entries) {
      expect(decoder.decode(entry.bytes)).not.toContain("NUNCA");
    }
  });

  it("builds only the JSON when only JSON was asked, and only the CSV when only the CSV was", async () => {
    setUp(1);
    const json = await collectExport(transaction, "org_1", ["json"]);
    expect(json.entries.map((entry) => entry.name)).toEqual([
      "data/alfa.json",
      "data/beta.json",
    ]);
    setUp(1);
    const csv = await collectExport(transaction, "org_1", ["csv"]);
    expect(csv.entries.map((entry) => entry.name)).toEqual([
      "csv/alfa.csv",
      "csv/beta.csv",
    ]);
  });

  it("reads no table at all for an images-only copy, so the data ceiling cannot fail it", async () => {
    setUp();
    reader.readImagePage.mockResolvedValueOnce([
      { assetId: "a1", byteSize: 3, storageKey: "media/a1.webp" },
    ]);
    const collected = await collectExport(transaction, "org_1", ["images"]);
    expect(reader.describeDataset).not.toHaveBeenCalled();
    expect(collected.entries).toEqual([]);
    expect(collected.summaries).toEqual([]);
    expect(collected.images).toEqual([
      { assetId: "a1", byteSize: 3, storageKey: "media/a1.webp" },
    ]);
  });

  it("fails for good when the data does not fit", async () => {
    setUp();
    reader.readDatasetPage.mockResolvedValue({
      next: null,
      rows: [{ id: "x", nome: "a".repeat(17 * 1024 * 1024) }],
    });
    await expect(
      collectExport(transaction, "org_1", ["json"])
    ).rejects.toBeInstanceOf(ExportTooLargeError);
  });

  it("fails for good, before any work, when there are more images than a run can read", async () => {
    setUp();
    reader.readImagePage.mockResolvedValue(
      Array.from({ length: 500 }, (_, index) => ({
        assetId: `a${index}`,
        byteSize: 1,
        storageKey: `media/a${index}.webp`,
      }))
    );
    await expect(
      collectExport(transaction, "org_1", ["images"])
    ).rejects.toBeInstanceOf(ExportTooLargeError);
  });
});

describe("the data archive", () => {
  it("holds the explanation, the manifest and the files, and says how many images the copy had", async () => {
    setUp(1);
    const collected = await collectExport(transaction, "org_1", ["json"]);
    const bytes = buildDataArchive({
      collected: { ...collected, images: [] },
      exportId: "0199c2d0-0000-7000-8000-0000000000aa",
      formats: ["json"],
      generatedAt: new Date("2026-10-17T12:00:00.000Z"),
      organizationId: "org_1",
    });
    const text = new TextDecoder("latin1").decode(bytes);
    for (const name of ["LEIA-ME.txt", "manifest.json", "data/alfa.json"]) {
      expect(text).toContain(name);
    }
    expect(text).toContain('"version": 1');
    expect(text).toContain('"images": null');
  });
});
