import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { PendingWork } from "../../pwa/update-model";
import { pendingWorkOf } from "./offline-runtime";

const RUNTIME_FILE = join(
  dirname(fileURLToPath(import.meta.url)),
  "offline-runtime.ts"
);

const COMMENTS = /\/\*[\s\S]*?\*\/|(^|[^:\\])\/\/[^\n]*/g;
const FIELD_FROM_QUEUE =
  /\b(?:pending|rejected|sending)\s*:\s*[\w.]+\.(?:pending|rejected|sending)\b/g;
const DESTRUCTURED_QUEUE =
  /\{\s*(?:pending|rejected|sending)\s*,[^}]*\}\s*=\s*(?:await\s+)?[\w.]*snapshot\(\)/g;

function conversionProblems(source: string): string[] {
  const code = source.replace(COMMENTS, "$1");
  const header = "export function pendingWorkOf(";
  const start = code.indexOf(header);
  const end = start === -1 ? -1 : code.indexOf("\n}\n", start);
  const outside =
    start === -1 || end === -1
      ? code
      : code.slice(0, start) + code.slice(end + 3);
  const problems: string[] = [];
  if (start === -1) {
    problems.push("pendingWorkOf ausente");
  }
  if (start !== -1 && !code.slice(start, end).match(FIELD_FROM_QUEUE)) {
    problems.push("pendingWorkOf não monta o PendingWork");
  }
  for (const found of outside.match(FIELD_FROM_QUEUE) ?? []) {
    problems.push(`conversão da fila fora de pendingWorkOf: ${found}`);
  }
  for (const found of outside.match(DESTRUCTURED_QUEUE) ?? []) {
    problems.push(`conversão da fila fora de pendingWorkOf: ${found}`);
  }
  return problems;
}

describe("pendingWorkOf", () => {
  it("devolve pendentes, recusados e enviando, sem os outros campos da fila", () => {
    const queue = {
      commands: [{ id: "a" }, { id: "b" }],
      pending: 3,
      rejected: 2,
      sending: 1,
    };
    const work: PendingWork = pendingWorkOf(queue);
    expect(work).toEqual({ pending: 3, rejected: 2, sending: 1 });
    expect(work).not.toBe(queue);
  });

  it("fila vazia vira zeros", () => {
    expect(pendingWorkOf({ pending: 0, rejected: 0, sending: 0 })).toEqual({
      pending: 0,
      rejected: 0,
      sending: 0,
    });
  });
});

describe("a conversão da fila em PendingWork fica só em pendingWorkOf", () => {
  const real = readFileSync(RUNTIME_FILE, "utf8");

  it("offline-runtime.ts não monta PendingWork do snapshot em outro lugar", () => {
    expect(conversionProblems(real)).toEqual([]);
  });

  const inlineObject = `${real}\nconst x = { pending: queue.pending, rejected: queue.rejected, sending: queue.sending };\n`;
  const inlineDestructure = `${real}\nasync function y(s) { const { pending, rejected, sending } = await s.outbox.snapshot(); return { pending, rejected, sending }; }\n`;
  const commented = `${real}\n// pending: queue.pending\n/* rejected: q.rejected */\n`;

  it.each([
    ["objeto inline", inlineObject],
    ["desestruturação do snapshot", inlineDestructure],
  ])("controle plantado reprova: %s", (_name, source) => {
    expect(conversionProblems(source)).not.toEqual([]);
  });

  it("controle plantado: a função sumir reprova", () => {
    expect(
      conversionProblems(
        real.replace("export function pendingWorkOf(", "function other(")
      )
    ).toContain("pendingWorkOf ausente");
  });

  it("comentário com o padrão não reprova", () => {
    expect(conversionProblems(commented)).toEqual([]);
  });
});
