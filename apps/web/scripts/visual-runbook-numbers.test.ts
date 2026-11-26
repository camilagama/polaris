import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * O runbook de testes de tela diz quantos estados o `ui-visual.e2e.ts` compara e quantas imagens a pasta de baselines
 * tem. A prosa não é lida por nenhum outro teste, então um estado novo sem a frase atualizada passaria em silêncio.
 * O spec é lido como texto: importar dele puxaria o `@playwright/test` para o vitest.
 */
const web = fileURLToPath(new URL("..", import.meta.url));
const repo = join(web, "..", "..");

const RUNBOOK = join(repo, "docs", "runbooks", "testes-de-tela.md");
const SPEC = join(web, "e2e-pwa", "ui-visual.e2e.ts");
const SNAPSHOTS = join(web, "e2e-pwa", "ui-visual.e2e.ts-snapshots");

const NO_PHRASE = /não achei a frase/;
const NO_BLOCK = /não achei o bloco VISUAL_STATES/;
const NO_SECTION = /não achei a seção/;
const NEXT_SECTION = /^## /m;
const ENTRY = /^ {2}\[/;

const SECTION = "## Regressão visual";
const FIX =
  "atualize a frase de `docs/runbooks/testes-de-tela.md` (seção Regressão visual)";

const section = (markdown: string): string => {
  const start = markdown.indexOf(`\n${SECTION}\n`);
  if (start === -1) {
    return "";
  }
  const body = markdown.slice(start + SECTION.length + 2);
  const next = body.search(NEXT_SECTION);
  return next === -1 ? body : body.slice(0, next);
};

const claimedNumbers = (text: string, noun: string, lead: string) => {
  const phrase = `${lead}N ${noun}`;
  const found = [...text.matchAll(new RegExp(`${lead}(\\d+) ${noun}\\b`, "g"))];
  if (found.length !== 1) {
    throw new Error(
      `não achei a frase "${phrase}" uma única vez na seção Regressão visual (achei ${found.length}): ${FIX}`
    );
  }
  return Number(found[0]?.[1]);
};

const countStates = (spec: string): number => {
  const start = spec.indexOf("const VISUAL_STATES = [");
  const end = spec.indexOf("] as const", start);
  if (start === -1 || end === -1) {
    throw new Error("não achei o bloco VISUAL_STATES em ui-visual.e2e.ts");
  }
  return spec
    .slice(start, end)
    .split("\n")
    .filter((line) => ENTRY.test(line)).length;
};

const countImages = (names: readonly string[]): number =>
  names.filter((name) => name.endsWith(".png")).length;

const claimed = (markdown: string) => {
  const text = section(markdown);
  if (text === "") {
    throw new Error(`não achei a seção "${SECTION}" no runbook: ${FIX}`);
  }
  return {
    images: claimedNumbers(text, "imagens", ""),
    states: claimedNumbers(text, "estados", "compara "),
  };
};

describe("os números do runbook de regressão visual", () => {
  it("são os do spec e da pasta de baselines", () => {
    const { states, images } = claimed(readFileSync(RUNBOOK, "utf8"));
    const spec = countStates(readFileSync(SPEC, "utf8"));
    const folder = countImages(readdirSync(SNAPSHOTS));
    const problems = [
      states === spec ? "" : `${states} estados no runbook, ${spec} no spec`,
      images === folder
        ? ""
        : `${images} imagens no runbook, ${folder} na pasta`,
    ].filter(Boolean);
    expect(problems, `${problems.join("; ")}: ${FIX}`).toEqual([]);
  });

  describe("controles", () => {
    it("conta a entrada que o formatador quebrou em várias linhas", () => {
      const spec = `const VISUAL_STATES = [\n  ["a", "a"],\n  [\n    "um nome muito longo",\n    "b",\n  ],\n] as const;\n`;
      expect(countStates(spec)).toBe(2);
    });

    it("reprova quando o bloco VISUAL_STATES não existe", () => {
      expect(() =>
        countStates('const OUTRO = [\n  ["a"],\n] as const;\n')
      ).toThrow(NO_BLOCK);
    });

    it("conta só os .png da pasta", () => {
      expect(countImages(["a.png", "LEIAME.md", "b.png", "c.png.tmp"])).toBe(2);
    });

    const sample = (phrase: string) =>
      `# x\n\n${SECTION}\n\n${phrase}\n\n## Outra\n\nrefere 99 estados e 98 imagens\n`;

    it("lê os dois números da seção e ignora os de outras seções", () => {
      expect(claimed(sample("compara 7 estados (… 12 imagens; …)"))).toEqual({
        images: 12,
        states: 7,
      });
    });

    it("reprova quando a frase dos estados não existe", () => {
      expect(() => claimed(sample("compara 7 telas (12 imagens)"))).toThrow(
        NO_PHRASE
      );
    });

    it("reprova quando a frase das imagens não existe", () => {
      expect(() => claimed(sample("compara 7 estados (12 fotos)"))).toThrow(
        NO_PHRASE
      );
    });

    it("reprova quando a frase aparece duas vezes", () => {
      expect(() =>
        claimed(sample("compara 7 estados e compara 8 estados, 12 imagens"))
      ).toThrow(NO_PHRASE);
    });

    it("reprova quando a seção não existe", () => {
      expect(() => claimed("# x\n\ncompara 7 estados, 12 imagens\n")).toThrow(
        NO_SECTION
      );
    });

    it("conta uma entrada por linha do bloco e ignora o que vem depois dele", () => {
      const spec = `const VISUAL_STATES = [\n  ["a", "a"],\n  ["b", "b"],\n] as const;\nconst X = [\n  ["c", "c"],\n];\n`;
      expect(countStates(spec)).toBe(2);
    });
  });
});
