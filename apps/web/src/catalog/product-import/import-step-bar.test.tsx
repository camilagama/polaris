import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  IMPORT_STEP_COUNT,
  ImportStepBar,
  importStepText,
} from "./import-frame";
import type { ImportStep } from "./use-product-import";

const KINDS = [
  "file",
  "preview",
  "running",
  "paused",
  "paused_busy",
  "result",
] as const satisfies readonly ImportStep["kind"][];

const PASSO = /Passo (\d) de/;
const FILLED = /data-filled="(true|false)"/g;
const CLASSES = /class="([^"]*)"/g;
const TEXT_NODE = />[^<>]+</;
const MOTION = /transition|duration|animate/;

const draw = (kind: ImportStep["kind"]) =>
  renderToStaticMarkup(<ImportStepBar kind={kind} />);

const filledOf = (markup: string) =>
  [...markup.matchAll(FILLED)].map((m) => m[1]);

const EXPECTED_STEP: Record<ImportStep["kind"], number> = {
  file: 1,
  paused: 3,
  paused_busy: 3,
  preview: 2,
  result: 4,
  running: 3,
};

describe("ImportStepBar", () => {
  it.each(KINDS)("%s: the full segments are the N of the text", (kind) => {
    const n = EXPECTED_STEP[kind];
    expect(PASSO.exec(importStepText(kind))?.[1]).toBe(String(n));
    expect(filledOf(draw(kind))).toEqual(
      Array.from({ length: IMPORT_STEP_COUNT }, (_, i) => String(i < n))
    );
  });

  it("says 4 in the text for every state", () => {
    for (const kind of KINDS) {
      expect(importStepText(kind)).toContain(`de ${IMPORT_STEP_COUNT} ·`);
    }
    expect(importStepText("paused_busy")).toBe("Passo 3 de 4 · Importando");
  });

  it("is decoration: hidden from the reader, with no text", () => {
    const markup = draw("preview");
    expect(markup.startsWith('<div aria-hidden="true"')).toBe(true);
    expect(TEXT_NODE.test(markup)).toBe(false);
  });

  it("moves only where the interface moves", () => {
    const classes = [...draw("file").matchAll(CLASSES)].flatMap((m) =>
      (m[1] ?? "").split(" ")
    );
    const moving = classes.filter((c) => MOTION.test(c));
    expect(moving.length).toBeGreaterThan(0);
    expect(moving.every((c) => c.startsWith("motion-full:"))).toBe(true);
  });
});
