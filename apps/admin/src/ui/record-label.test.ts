import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RECORD_LABEL } from "../../ui/record-label";

const VIEWS = fileURLToPath(new URL("../../ui/views", import.meta.url));

const UNDO_THEN_RECORD =
  /\[\s*"Dá para desfazer"\s*,[^\]]*\]\s*,\s*\[\s*("[^"]*"|[A-Za-z_]+)\s*,/g;
const HAND_WRITTEN = /\[\s*"Fica (na auditoria|no registro)"/;
const QUOTES = /"/g;
const UNDO_ROW = /"Dá para desfazer"/g;
const LOCAL_DECLARATION = /\b(const|let|var|function)\s+RECORD_LABEL\b/;

const recordLabelsIn = (source: string): string[] =>
  [...source.matchAll(UNDO_THEN_RECORD)].map((match) => {
    const token = match[1] ?? "";
    return token === "RECORD_LABEL" ? RECORD_LABEL : token.replace(QUOTES, "");
  });

const EXPECTED: readonly (readonly [string, number])[] = [
  ["access.ts", 1],
  ["billing-actions.ts", 1],
  ["case.ts", 1],
  ["closure-notice.ts", 2],
  ["entitlements.ts", 1],
  ["privacy-case.ts", 1],
  ["purge.ts", 4],
  ["store-actions.ts", 1],
];

const viewFiles = () =>
  readdirSync(VIEWS)
    .filter((name) => name.endsWith(".ts"))
    .sort();

const confirmationsByFile = () =>
  viewFiles()
    .map((name): [string, string[]] => [
      name,
      recordLabelsIn(readFileSync(join(VIEWS, name), "utf8")),
    ])
    .filter(([, labels]) => labels.length > 0);

describe("rótulo único das confirmações do Admin", () => {
  it("o rótulo é Fica registrado", () => {
    expect(RECORD_LABEL).toBe("Fica registrado");
  });

  it("as 12 confirmações das 8 telas usam o mesmo rótulo", () => {
    const byFile = confirmationsByFile();
    expect(byFile.map(([name, list]) => [name, list.length])).toEqual(EXPECTED);
    const all = byFile.flatMap(([, list]) => list);
    expect(all).toHaveLength(12);
    expect([...new Set(all)]).toEqual([RECORD_LABEL]);
  });

  it("toda linha Dá para desfazer das telas foi contada", () => {
    const counted = confirmationsByFile().flatMap(([, list]) => list).length;
    const present = viewFiles()
      .map(
        (name) =>
          readFileSync(join(VIEWS, name), "utf8").match(UNDO_ROW)?.length ?? 0
      )
      .reduce((sum, n) => sum + n, 0);
    expect(present).toBe(counted);
  });

  it("nenhuma tela declara o próprio RECORD_LABEL", () => {
    for (const name of viewFiles()) {
      expect(readFileSync(join(VIEWS, name), "utf8"), name).not.toMatch(
        LOCAL_DECLARATION
      );
    }
  });

  it("nenhuma tela escreve o rótulo antigo à mão", () => {
    for (const name of viewFiles()) {
      expect(readFileSync(join(VIEWS, name), "utf8"), name).not.toMatch(
        HAND_WRITTEN
      );
    }
  });

  describe("controles: o exame enxerga rótulo diferente", () => {
    const row = (label: string) =>
      `["Dá para desfazer", UNDO],\n      [${label}, RECORD],`;

    it("lê a constante e o texto literal", () => {
      expect(recordLabelsIn(row("RECORD_LABEL"))).toEqual([RECORD_LABEL]);
      expect(recordLabelsIn(row('"Fica na auditoria"'))).toEqual([
        "Fica na auditoria",
      ]);
      expect(recordLabelsIn(row('"Fica no registro"'))).toEqual([
        "Fica no registro",
      ]);
    });

    it("dois rótulos diferentes dão dois valores", () => {
      const mixed = [
        ...recordLabelsIn(row("RECORD_LABEL")),
        ...recordLabelsIn(row('"Fica no registro"')),
      ];
      expect(new Set(mixed).size).toBe(2);
    });

    it("uma linha fora da forma esperada não é contada e a contagem total a acusa", () => {
      const escaped = `["Dá para desfazer", UNDO],\n      someRow,\n      [RECORD_LABEL, X],`;
      expect(recordLabelsIn(escaped)).toEqual([]);
      expect(escaped.match(UNDO_ROW)).toHaveLength(1);
    });

    it("uma declaração local do rótulo é pega", () => {
      expect('const RECORD_LABEL = "Fica no registro";').toMatch(
        LOCAL_DECLARATION
      );
    });

    it("o rótulo antigo escrito à mão é pego", () => {
      expect(row('"Fica no registro"')).toMatch(HAND_WRITTEN);
      expect(row("RECORD_LABEL")).not.toMatch(HAND_WRITTEN);
    });
  });
});
