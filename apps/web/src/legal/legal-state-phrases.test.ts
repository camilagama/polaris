import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { closeGate, OTHER_DEVICES_TEXT } from "../organization/closure-model";
import { currentLegalText } from "./legal-content";

const checklist = readFileSync(
  new URL("../../../../docs/runbooks/release-checklist.md", import.meta.url),
  "utf8"
);

const documents = {
  privacidade: currentLegalText("privacy"),
  termos: currentLegalText("terms"),
} as const;

type DocumentName = keyof typeof documents;

interface StateRow {
  falsewhen: string;
  file: string;
  number: number;
  owner: string;
  phrase: string;
}

const flat = (text: string) => text.replaceAll("**", "").replaceAll("\n", " ");
const stateMarkers = /ainda não|não estiver/gi;
const tableBlock =
  /<!-- legal-state-phrases:start -->([\s\S]*?)<!-- legal-state-phrases:end -->/;
const tableRow = /^\| \d+ \|/;
const codeFence = /^`|`$/g;
const EXPECTED_ROWS = [
  "1 termos",
  "1 privacidade",
  "2 termos",
  "3 termos",
  "4 termos",
  "4 privacidade",
  "4 privacidade",
  "5 privacidade",
  "6 termos",
  "7 termos",
  "8 termos",
];

function stateRows(): StateRow[] {
  const block = tableBlock.exec(checklist);
  if (!block?.[1]) {
    throw new Error(
      "A tabela de frases de estado não está no release-checklist."
    );
  }
  return block[1]
    .split("\n")
    .filter((line) => tableRow.test(line))
    .map((line) => {
      const cells = line
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.trim());
      if (cells.length !== 5) {
        throw new Error(`Linha da tabela com ${cells.length} colunas: ${line}`);
      }
      const [number = "", file = "", phrase = "", falsewhen = "", owner = ""] =
        cells;
      return {
        falsewhen,
        file,
        number: Number(number),
        owner,
        phrase: phrase.replace(codeFence, ""),
      };
    });
}

describe("the table of state phrases in the release checklist (AC-1)", () => {
  const rows = stateRows();

  it("lists the eight phrases, each with the condition that makes it false and who swaps it", () => {
    expect(rows.map((row) => `${row.number} ${row.file}`)).toEqual(
      EXPECTED_ROWS
    );
    for (const row of rows) {
      expect(row.phrase.length).toBeGreaterThan(10);
      expect(row.falsewhen.length).toBeGreaterThan(0);
      expect(row.owner.length).toBeGreaterThan(0);
    }
  });

  it.each(
    stateRows().map((row) => [`${row.number} (${row.file})`, row] as const)
  )("phrase %s is, word for word, in its text", (_name, row) => {
    expect(Object.keys(documents)).toContain(row.file);
    expect(flat(documents[row.file as DocumentName])).toContain(row.phrase);
  });

  it.each(Object.keys(documents) as DocumentName[])(
    "%s has no state phrase left out of the table",
    (file) => {
      const text = flat(documents[file]);
      const inText = text.match(stateMarkers)?.length ?? 0;
      const inTable = rows
        .filter((row) => row.file === file)
        .reduce(
          (total, row) => total + (row.phrase.match(stateMarkers)?.length ?? 0),
          0
        );
      expect(inTable).toBe(inText);
    }
  );
});

describe("the phrase about the other devices (AC-2)", () => {
  it.each(Object.keys(documents) as DocumentName[])(
    "%s says the same as the closing screen: checks this device, not the others, which must be opened with internet",
    (file) => {
      const text = flat(documents[file]);
      expect(text).toContain("confere o que está guardado neste aparelho");
      expect(text).toContain("não deixa encerrar");
      expect(text).toContain("ele não confere os outros aparelhos");
      expect(text).toContain(OTHER_DEVICES_TEXT);
      expect(text).not.toContain("ainda não confere");
    }
  );

  it("still holds the closing while this device has anything kept, which is what the texts promise", () => {
    const counted = (pending: number, rejected = 0) => ({
      counts: { pending, rejected, sending: 0 },
      kind: "counted" as const,
    });
    for (const queue of [counted(1), counted(0, 1)]) {
      expect(
        closeGate({
          online: true,
          queue,
          storeName: "Loja da Ana",
          typed: "Loja da Ana",
        })
      ).toEqual({ enabled: false, reason: "queue" });
    }
  });

  it("is the same words the closing screen shows for the other devices", () => {
    expect(OTHER_DEVICES_TEXT).toBe(
      "Se você usa o Polaris em outros aparelhos, abra-os com internet e envie o que estiver guardado antes de encerrar."
    );
  });
});

describe("the closed stores the browser remembers (privacy policy)", () => {
  it("are listed with the other browser storage, with when they are erased", () => {
    expect(flat(documents.privacidade)).toContain(
      "- no navegador, o nome das suas lojas encerradas, para mostrar o aviso e o atalho para vê-las (é apagado quando você sai, quando a sessão termina e quando você abre a tela de entrada);"
    );
  });
});
