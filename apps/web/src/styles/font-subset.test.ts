import { readdirSync, readFileSync, statSync } from "node:fs";
import { brotliDecompressSync } from "node:zlib";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The app serves only the latin subset of Geist (`@font-face "Geist Variable"` in `styles/index.css`), and the
 * face declares what it covers in `unicode-range`. A character of the screen text outside that range (`→`, `✓`,
 * `≥`) is drawn by the fallback font, with another metric and weight, and nothing fails: it only shows on the
 * screen. This test reads the range from the CSS (not a copy of it), sweeps the text literals of `src/` and
 * requires every non-ASCII character to be inside the range or in `EXCEPTIONS`, with its reason. It also reads the
 * characters that a `→` escape or an `&rarr;` entity produces, which the raw source does not show.
 *
 * Out of the sweep: tests, comments, and the two folders that are no screen of the shop: the labs (`offline-poc/`)
 * and the character sample page (`ui-gallery/`, which lists the glyphs on purpose). Geist Mono has its own subset
 * and is checked on its own at the end (the characters of the display). `server/` is swept too: nothing there needs the exceptions today, and a character that
 * the e-mails or the logs need and Geist lacks is one more line of `EXCEPTIONS`, with its reason.
 */
const src = fileURLToPath(new URL("..", import.meta.url));
const CSS = join(src, "styles/index.css");
const FACE_FAMILY = "Geist Variable";
const SKIPPED_DIRECTORIES = ["offline-poc/", "ui-gallery/"];
const TEST_FILE = /\.test\.tsx?$/;
const SOURCE_FILE = /\.tsx?$/;

type Range = readonly [number, number];

interface Exception {
  readonly codePoint: number;
  readonly file: string;
  readonly reason: string;
}

/** A character allowed outside the range, in one file, with why the fallback font is acceptable there. */
const EXCEPTIONS: readonly Exception[] = [];

/** The named entities the sources may write; a name not here fails, so the table is the thing to grow. */
const ENTITIES: Readonly<Record<string, number>> = {
  amp: 0x26,
  apos: 0x27,
  bull: 0x20_22,
  check: 0x27_13,
  copy: 0xa9,
  euro: 0x20_ac,
  ge: 0x22_65,
  gt: 0x3e,
  harr: 0x21_94,
  hellip: 0x20_26,
  larr: 0x21_90,
  le: 0x22_64,
  lt: 0x3c,
  mdash: 0x20_14,
  middot: 0xb7,
  minus: 0x22_12,
  nbsp: 0xa0,
  ndash: 0x20_13,
  ne: 0x22_60,
  quot: 0x22,
  rarr: 0x21_92,
  reg: 0xae,
  times: 0xd7,
  trade: 0x21_22,
};

const FONT_FACE = /@font-face\s*\{[^}]*\}/g;
const UNICODE_RANGE = /unicode-range:\s*([^;]+);/;
const RANGE_ITEM = /^U\+([0-9A-Fa-f]+)(?:-([0-9A-Fa-f]+))?$/;
const WHITESPACE = /\s/;
const LOWERCASE = /[a-z]/;
const BEFORE_REGEX = "=(,:[!&|?;>";

const fmt = (codePoint: number) =>
  `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;

/** The ranges of the `unicode-range` of every `@font-face` of the family (one per subset), read from the CSS text. */
function faceRanges(css: string, family: string): Range[] {
  const faces = css.match(FONT_FACE) ?? [];
  const declarations = faces
    .filter((block) => new RegExp(`font-family:\\s*"${family}"`).test(block))
    .map((block) => block.match(UNICODE_RANGE)?.[1])
    .filter((declaration) => declaration !== undefined);
  if (declarations.length === 0) {
    throw new Error(`@font-face "${family}" sem unicode-range em index.css`);
  }
  return declarations
    .flatMap((declaration) => declaration.split(","))
    .map((item): Range => {
      const match = item.trim().match(RANGE_ITEM);
      if (match === null) {
        throw new Error(`unicode-range ilegível: "${item.trim()}"`);
      }
      const from = Number.parseInt(match[1] ?? "", 16);
      return [
        from,
        match[2] === undefined ? from : Number.parseInt(match[2], 16),
      ];
    });
}

const inRanges = (codePoint: number, covered: readonly Range[]) =>
  covered.some(([from, to]) => codePoint >= from && codePoint <= to);

/** Where the regex literal that starts at `start` ends (after its flags), or -1 when it is not one. */
function regexEnd(text: string, start: number): number {
  let inClass = false;
  for (let index = start + 1; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\n") {
      return -1;
    }
    if (char === "\\") {
      index += 1;
    } else if (char === "[") {
      inClass = true;
    } else if (char === "]") {
      inClass = false;
    } else if (char === "/" && !inClass) {
      let end = index + 1;
      while (LOWERCASE.test(text[end] ?? "")) {
        end += 1;
      }
      return end;
    }
  }
  return -1;
}

const startsRegex = (before: string) => {
  const last = before.trimEnd();
  return (
    last === "" ||
    BEFORE_REGEX.includes(last.at(-1) ?? "") ||
    last.endsWith("return")
  );
};

/**
 * The text without its comments and its regex literals (their `\u` escapes are no screen text). A comment marker inside a string stays (`"http://x"`); a quote ends at the line
 * end, so the apostrophe of a JSX text does not swallow what follows. A `//` starts a comment only at the line
 * start or after a space, as the other source rules of the repository do.
 */
function withoutComments(text: string): string {
  let out = "";
  let quote = "";
  let index = 0;
  while (index < text.length) {
    const char = text[index] ?? "";
    const next = text[index + 1];
    if (quote !== "") {
      out += char;
      if (char === "\\" && next !== undefined) {
        out += next;
        index += 2;
        continue;
      }
      if (char === quote || (char === "\n" && quote !== "`")) {
        quote = "";
      }
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      const end = text.indexOf("*/", index + 2);
      index = end === -1 ? text.length : end + 2;
      continue;
    }
    if (char === "/" && next !== ">" && next !== "/" && startsRegex(out)) {
      const end = regexEnd(text, index);
      if (end !== -1) {
        out += " ";
        index = end;
        continue;
      }
    }
    if (
      char === "/" &&
      next === "/" &&
      (out === "" || WHITESPACE.test(out.at(-1) ?? ""))
    ) {
      const end = text.indexOf("\n", index);
      index = end === -1 ? text.length : end;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
    }
    out += char;
    index += 1;
  }
  return out;
}

const ESCAPE = /\\u\{([0-9A-Fa-f]+)\}|\\u([0-9A-Fa-f]{4})|\\x([0-9A-Fa-f]{2})/g;
const ENTITY = /&(?:#(\d+)|#[xX]([0-9A-Fa-f]+)|([A-Za-z][A-Za-z0-9]*));/g;

/** What the text puts on the screen beyond ASCII: raw characters, `\u` escapes and entities (`&rarr;`, `&#8594;`). */
function visibleCodePoints(text: string): number[] {
  const found: number[] = [];
  for (const char of text) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (codePoint > 0x7f) {
      found.push(codePoint);
    }
  }
  for (const match of text.matchAll(ESCAPE)) {
    found.push(Number.parseInt(match[1] ?? match[2] ?? match[3] ?? "", 16));
  }
  for (const match of text.matchAll(ENTITY)) {
    if (match[3] === undefined) {
      found.push(
        match[1] === undefined
          ? Number.parseInt(match[2] ?? "", 16)
          : Number.parseInt(match[1], 10)
      );
      continue;
    }
    const named = ENTITIES[match[3]];
    if (named === undefined) {
      throw new Error(
        `entidade &${match[3]}; fora da tabela ENTITIES do font-subset.test.ts: acrescente o caractere dela`
      );
    }
    found.push(named);
  }
  return found.filter((codePoint) => codePoint > 0x7f);
}

/** One message per character outside the range and outside the exceptions of the file: file, character and code. */
function subsetFaults(
  file: string,
  text: string,
  covered: readonly Range[],
  exceptions: readonly Exception[]
): string[] {
  const faults = new Set<string>();
  for (const codePoint of visibleCodePoints(withoutComments(text))) {
    const allowed = exceptions.some(
      (exception) =>
        exception.file === file && exception.codePoint === codePoint
    );
    if (!(allowed || inRanges(codePoint, covered))) {
      faults.add(
        `${file}: "${String.fromCodePoint(codePoint)}" ${fmt(codePoint)} fora do unicode-range da Geist`
      );
    }
  }
  return [...faults];
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(path);
    }
    const file = relative(src, path).split(sep).join("/");
    const swept =
      SOURCE_FILE.test(entry.name) &&
      !TEST_FILE.test(entry.name) &&
      !SKIPPED_DIRECTORIES.some((skipped) => file.startsWith(skipped));
    return swept ? [file] : [];
  });
}

const GEIST_RANGES = faceRanges(readFileSync(CSS, "utf8"), FACE_FAMILY);

describe("texto da interface x unicode-range da Geist embutida", () => {
  it("lê o alcance do index.css", () => {
    expect(inRanges(0x22_12, GEIST_RANGES)).toBe(true);
    expect(inRanges(0x21_92, GEIST_RANGES)).toBe(false);
  });

  it("todo caractere não ASCII dos textos de src/ está no alcance ou numa exceção", () => {
    const files = sourceFiles(src);
    expect(files.length).toBeGreaterThan(300);
    expect(files.some((file) => file.startsWith("dashboard/"))).toBe(true);
    const faults = files.flatMap((file) =>
      subsetFaults(
        file,
        readFileSync(join(src, file), "utf8"),
        GEIST_RANGES,
        EXCEPTIONS
      )
    );
    expect(faults).toEqual([]);
  });

  it("as duas pastas fora da varredura existem e nenhum arquivo delas entra", () => {
    const files = sourceFiles(src);
    for (const skipped of SKIPPED_DIRECTORIES) {
      expect(statSync(join(src, skipped)).isDirectory()).toBe(true);
      expect(files.filter((file) => file.startsWith(skipped))).toEqual([]);
    }
    expect(files.filter((file) => TEST_FILE.test(file))).toEqual([]);
  });

  it("cada exceção aponta um arquivo que existe, usa o caractere e tem motivo", () => {
    const files = new Set(sourceFiles(src));
    for (const exception of EXCEPTIONS) {
      expect(files.has(exception.file)).toBe(true);
      expect(exception.reason.trim()).not.toBe("");
      expect(inRanges(exception.codePoint, GEIST_RANGES)).toBe(false);
      const uses = visibleCodePoints(
        withoutComments(readFileSync(join(src, exception.file), "utf8"))
      );
      expect(uses).toContain(exception.codePoint);
    }
  });

  describe("controles plantados", () => {
    const file = "controle/total.tsx";
    const fault = (text: string, exceptions: readonly Exception[] = []) =>
      subsetFaults(file, text, GEIST_RANGES, exceptions);

    it("reprova a seta em texto de JSX, aspas simples e template multilinha", () => {
      expect(fault("<p>Total →</p>")).toHaveLength(1);
      expect(fault("<p>Não é d'água →</p>")).toHaveLength(1);
      expect(fault("const a = 'Total ✓';")).toHaveLength(1);
      const template = [
        "const a = `linha\nTotal $",
        "{x} ≥ $",
        "{`y`} fim`;",
      ].join("");
      expect(fault(template)).toHaveLength(1);
    });

    it("reprova uma seta num literal, com arquivo, caractere e código", () => {
      expect(fault('const label = "Total →";')).toEqual([
        `${file}: "→" U+2192 fora do unicode-range da Geist`,
      ]);
    });

    it("passa o sinal de menos U+2212 e o ASCII", () => {
      expect(fault('const label = "Saldo −R$ 10,00";')).toEqual([]);
      expect(fault('const label = "Não há vendas · hoje";')).toEqual([]);
    });

    it("passa o mesmo caractere numa exceção com motivo, só no arquivo dela", () => {
      const exception = {
        codePoint: 0x21_92,
        file,
        reason: "controle do teste",
      };
      expect(fault('const label = "Total →";', [exception])).toEqual([]);
      expect(
        subsetFaults("outro.tsx", 'const a = "→";', GEIST_RANGES, [exception])
      ).toHaveLength(1);
    });

    it("reprova o que uma entidade ou um escape produz", () => {
      expect(fault("<p>Total &rarr;</p>")).toHaveLength(1);
      expect(fault("<p>Total &#8594;</p>")).toHaveLength(1);
      expect(fault("<p>Total &#x2713;</p>")).toHaveLength(1);
      expect(fault('const mark = "\\u2713";')).toHaveLength(1);
      expect(fault('const mark = "\\u{2265}";')).toHaveLength(1);
      expect(fault("<p>Total &amp; mais&nbsp;um</p>")).toEqual([]);
    });

    it("reprova entidade com nome fora da tabela em vez de deixar passar", () => {
      expect(() => fault("<p>&zigzag;</p>")).toThrow("ENTITIES");
    });

    it("ignora comentário, mas não um // dentro de um texto", () => {
      expect(fault("// vai → depois\nconst a = 1;")).toEqual([]);
      expect(fault("/* ✓ */ const a = 1;")).toEqual([]);
      expect(fault('const a = "http://x/→";')).toHaveLength(1);
      expect(fault("<p>Total</p> {/* ✓ */}")).toEqual([]);
      expect(fault("const a = /[\\u2192]/u;")).toEqual([]);
      expect(fault("const f = (c) => /[\\u0300]/.test(c);")).toEqual([]);
      expect(fault('const a = "→"; const b = x / 2;')).toHaveLength(1);
    });
  });

  describe("alcance lido do CSS", () => {
    const css = (range: string) =>
      `@font-face {\n font-family: "Geist Variable";\n unicode-range: ${range};\n}`;

    it("tirar o trecho do U+2212 faz o sinal de menos reprovar", () => {
      const without = faceRanges(css("U+0000-00FF, U+2000-2211"), FACE_FAMILY);
      expect(
        subsetFaults("controle/menos.ts", 'const a = "−";', without, EXCEPTIONS)
      ).toHaveLength(1);
    });

    it("junta o alcance de dois @font-face da mesma família", () => {
      const both = faceRanges(
        `${css("U+0000-00FF")}\n${css("U+2190-2193")}\n@font-face { font-family: "Outra"; unicode-range: U+2713; }`,
        FACE_FAMILY
      );
      expect(inRanges(0x21_92, both)).toBe(true);
      expect(inRanges(0x27_13, both)).toBe(false);
    });

    it("recusa um @font-face sem o alcance", () => {
      expect(() =>
        faceRanges('@font-face { font-family: "Geist Variable"; }', FACE_FAMILY)
      ).toThrow("unicode-range");
    });
  });
});

/*
 * Geist Mono sets the display of the app (the figure of the KPI cards and the percents). A character the file does not
 * have is drawn by another font, with another advance, and the figure loses the one thing the face is there for. The
 * `unicode-range` only says what the face declares, so this reads what the woff2 file holds: its `cmap`, out of the
 * brotli stream (the `cmap` is never transformed).
 */
const MONO_FAMILY = "Geist Mono Variable";
const MONO_FILE = fileURLToPath(
  new URL(
    "../../node_modules/@fontsource-variable/geist-mono/files/geist-mono-latin-wght-normal.woff2",
    import.meta.url
  )
);

const DISPLAY_CHARACTERS = "R$0123456789.,%+\u2212-\u2022\u2014\u00d7 ";

const WOFF2_TAGS = [
  "cmap",
  "head",
  "hhea",
  "hmtx",
  "maxp",
  "name",
  "OS/2",
  "post",
  "cvt ",
  "fpgm",
  "glyf",
  "loca",
  "prep",
];
const GLYF_AND_LOCA = new Set(["glyf", "loca"]);
const CONTINUATION = 128;
const TAG_INDEX_RANGE = 64;
const GLYPH_RANGE = 0x1_00_00;
const ALL_TAGS = 63;

function base128(view: DataView, at: number): [number, number] {
  let value = 0;
  for (let index = 0; index < 5; index += 1) {
    const byte = view.getUint8(at + index);
    value = value * CONTINUATION + (byte % CONTINUATION);
    if (byte < CONTINUATION) {
      return [value, at + index + 1];
    }
  }
  throw new Error("woff2: UIntBase128 longo demais");
}

function woff2Cmap(file: Buffer): Buffer {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  if (view.getUint32(0) !== 0x77_4f_46_32) {
    throw new Error("não é woff2");
  }
  const count = view.getUint16(12);
  const compressedSize = view.getUint32(20);
  let at = 48;
  const sizes: { stored: number; tag: string }[] = [];
  for (let index = 0; index < count; index += 1) {
    const flags = view.getUint8(at);
    at += 1;
    const known = flags % TAG_INDEX_RANGE;
    let tag = WOFF2_TAGS[known] ?? `#${known}`;
    if (known === ALL_TAGS) {
      tag = file.toString("latin1", at, at + 4);
      at += 4;
    }
    const version = Math.floor(flags / TAG_INDEX_RANGE);
    const [original, afterOriginal] = base128(view, at);
    at = afterOriginal;
    const transformed = GLYF_AND_LOCA.has(tag) ? version === 0 : version !== 0;
    let stored = original;
    if (transformed) {
      [stored, at] = base128(view, at);
    }
    sizes.push({ stored, tag });
  }
  const tables = brotliDecompressSync(file.subarray(at, at + compressedSize));
  let offset = 0;
  for (const { stored, tag } of sizes) {
    if (tag === "cmap") {
      return tables.subarray(offset, offset + stored);
    }
    offset += stored;
  }
  throw new Error("woff2 sem cmap");
}

/** Reads the subtables of format 4 and 12 of the Windows and Unicode platforms; .notdef does not count. */
function cmapCovers(cmap: Buffer): (codePoint: number) => boolean {
  const view = new DataView(cmap.buffer, cmap.byteOffset, cmap.byteLength);
  const records = view.getUint16(2);
  const subtables: number[] = [];
  for (let index = 0; index < records; index += 1) {
    const platform = view.getUint16(4 + index * 8);
    if (platform === 0 || platform === 3) {
      subtables.push(view.getUint32(4 + index * 8 + 4));
    }
  }
  const glyphIn4 = (base: number, codePoint: number): number => {
    const segments = view.getUint16(base + 6) / 2;
    const ends = base + 14;
    const starts = ends + segments * 2 + 2;
    const deltas = starts + segments * 2;
    const ranges = deltas + segments * 2;
    for (let segment = 0; segment < segments; segment += 1) {
      if (codePoint > view.getUint16(ends + segment * 2)) {
        continue;
      }
      const start = view.getUint16(starts + segment * 2);
      if (codePoint < start) {
        return 0;
      }
      const delta = view.getInt16(deltas + segment * 2);
      const range = view.getUint16(ranges + segment * 2);
      if (range === 0) {
        return (codePoint + delta + GLYPH_RANGE) % GLYPH_RANGE;
      }
      const glyph = view.getUint16(
        ranges + segment * 2 + range + (codePoint - start) * 2
      );
      return glyph === 0 ? 0 : (glyph + delta + GLYPH_RANGE) % GLYPH_RANGE;
    }
    return 0;
  };
  const glyphIn12 = (base: number, codePoint: number): number => {
    const groups = view.getUint32(base + 12);
    for (let group = 0; group < groups; group += 1) {
      const at = base + 16 + group * 12;
      const start = view.getUint32(at);
      if (codePoint >= start && codePoint <= view.getUint32(at + 4)) {
        return view.getUint32(at + 8) + codePoint - start;
      }
    }
    return 0;
  };
  return (codePoint) =>
    subtables.some((base) => {
      const format = view.getUint16(base);
      if (format === 4) {
        return glyphIn4(base, codePoint) !== 0;
      }
      return format === 12 && glyphIn12(base, codePoint) !== 0;
    });
}

describe("Geist Mono do visor", () => {
  const characters = [...DISPLAY_CHARACTERS].map(
    (char) => char.codePointAt(0) ?? 0
  );
  const monoRanges = faceRanges(readFileSync(CSS, "utf8"), MONO_FAMILY);
  const covers = cmapCovers(woff2Cmap(readFileSync(MONO_FILE)));

  it("o unicode-range da face declara os caracteres do visor", () => {
    const missing = characters.filter((code) => !inRanges(code, monoRanges));
    expect(missing.map(fmt)).toEqual([]);
  });

  it("o arquivo da fonte tem um glifo para cada um deles", () => {
    const missing = characters.filter((code) => !covers(code));
    expect(missing.map(fmt)).toEqual([]);
  });

  it("controle plantado: o leitor do cmap reprova um caractere que a fonte não tem", () => {
    expect(covers(0x27_13)).toBe(false);
    expect(covers(0x4e_00)).toBe(false);
    expect(covers("5".codePointAt(0) ?? 0)).toBe(true);
  });
});
