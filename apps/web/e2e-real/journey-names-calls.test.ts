import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = import.meta.dirname;
const OWN_FILES = new Set(["journey-names.ts", "journey-names.test.ts"]);
const CALL = /\bjourneyName\(/g;
const SOURCE_FILE = /\.(?:ts|tsx|mjs|js)$/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "node_modules" ? [] : sourceFiles(path);
    }
    return SOURCE_FILE.test(entry.name) &&
      !OWN_FILES.has(entry.name) &&
      entry.name !== "journey-names-calls.test.ts"
      ? [path]
      : [];
  });
}

const REGEX_KEYWORD =
  /\b(?:return|typeof|case|throw|void|delete|yield|await|in|of)$/;

/** A `/` after one of these (or at the start) opens a regular expression, not a division. */
function startsRegex(codeBefore: string): boolean {
  const last = codeBefore.trimEnd().slice(-1);
  return (
    last === "" ||
    "(,=:[!&|?{};+-*%>~^".includes(last) ||
    REGEX_KEYWORD.test(codeBefore.trimEnd())
  );
}

/** A template literal from its opening backtick: the text blanked, the `${...}` expressions kept as code. */
function readTemplate(
  source: string,
  start: number
): { code: string; end: number } {
  let code = "`";
  let index = start + 1;
  while (index < source.length && source[index] !== "`") {
    if (source[index] === "$" && source[index + 1] === "{") {
      const expression = scanCode(source, index + 2, true);
      code += `\${${expression.code}}`;
      index = expression.end + 1;
    } else {
      const step = source[index] === "\\" ? 2 : 1;
      code += "_".repeat(step);
      index += step;
    }
  }
  return { code: `${code}\``, end: index + 1 };
}

/**
 * Reads code from `start`, blanking comments and the inside of string and template literals (same length). With
 * `untilBrace` it stops at the `}` that closes the enclosing `${`, counting only braces that are code, and `end` is
 * that brace's index.
 */
function scanCode(
  source: string,
  start: number,
  untilBrace: boolean
): { code: string; end: number } {
  let out = "";
  let index = start;
  let depth = 0;
  while (index < source.length) {
    const char = source[index] as string;
    const next = source[index + 1];
    if (char === "}" && untilBrace && depth === 0) {
      break;
    }
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
    }
    if (char === "/" && next === "/") {
      const stop = source.indexOf("\n", index);
      const end = stop === -1 ? source.length : stop;
      out += " ".repeat(end - index);
      index = end;
    } else if (char === "/" && next === "*") {
      const stop = source.indexOf("*/", index + 2);
      const end = stop === -1 ? source.length : stop + 2;
      out += source.slice(index, end).replace(/[^\n]/g, " ");
      index = end;
    } else if (char === "/" && startsRegex(out)) {
      let end = index + 1;
      let inClass = false;
      while (end < source.length && (inClass || source[end] !== "/")) {
        if (source[end] === "\\") {
          end += 1;
        } else if (source[end] === "[") {
          inClass = true;
        } else if (source[end] === "]") {
          inClass = false;
        }
        end += 1;
      }
      out += `/${"_".repeat(Math.max(0, end - index - 1))}/`;
      index = end + 1;
    } else if (char === "`") {
      const template = readTemplate(source, index);
      out += template.code;
      index = template.end;
    } else if (char === '"' || char === "'") {
      let end = index + 1;
      while (end < source.length && source[end] !== char) {
        end += source[end] === "\\" ? 2 : 1;
      }
      out += `${char}${"_".repeat(Math.max(0, end - index - 1))}${char}`;
      index = end + 1;
    } else {
      out += char;
      index += 1;
    }
  }
  return { code: out, end: index };
}

/**
 * The source with comments and the inside of string and template literals blanked (same length), so a `journeyName(`
 * or a comma that only appears in a comment or a string is never read as code.
 */
function codeOnly(source: string): string {
  return scanCode(source, 0, false).code.slice(0, source.length);
}

/** The arguments of each `journeyName(` call in code (comments and literals blanked), split at the top level. */
function journeyNameCalls(source: string): string[][] {
  const code = codeOnly(source);
  const calls: string[][] = [];
  for (const match of code.matchAll(CALL)) {
    let depth = 1;
    let index = match.index + match[0].length;
    let current = "";
    const args: string[] = [];
    while (index < code.length && depth > 0) {
      const char = code[index] as string;
      if ("([{".includes(char)) {
        depth += 1;
      } else if (")]}".includes(char)) {
        depth -= 1;
      }
      if (char === "," && depth === 1) {
        args.push(current.trim());
        current = "";
      } else if (depth > 0) {
        current += char;
      }
      index += 1;
    }
    if (current.trim() !== "") {
      args.push(current.trim());
    }
    calls.push(args);
  }
  return calls;
}

const REPETITION_INDEX_POSITION = 3;
const REPETITION_INDEX = /^(?:\w+\.)*repeatEachIndex$/;

const lacksRepetition = (args: string[]) =>
  args.length !== REPETITION_INDEX_POSITION + 1 ||
  !REPETITION_INDEX.test(args[REPETITION_INDEX_POSITION] as string);

describe("journeyName calls in the e2e suites", () => {
  it("pass the repetition index, or --repeat-each inserts the same user twice", () => {
    const offenders = sourceFiles(ROOT).flatMap((file) =>
      journeyNameCalls(readFileSync(file, "utf8"))
        .filter(lacksRepetition)
        .map((args) => `${file.slice(ROOT.length + 1)}: ${args.join(", ")}`)
    );
    expect(offenders).toEqual([]);
  });

  it("sees the calls it must judge (the scan is not empty)", () => {
    const total = sourceFiles(ROOT).flatMap((file) =>
      journeyNameCalls(readFileSync(file, "utf8"))
    ).length;
    expect(total).toBeGreaterThanOrEqual(10);
  });

  it("rejects a call without the index and accepts one with it, nested parentheses included", () => {
    const bad = 'x(journeyName("pilha", "a", testInfo.retry))';
    const good =
      'x(journeyName(f("pilha"), "a", testInfo.retry, testInfo.repeatEachIndex))';
    expect(journeyNameCalls(bad).filter(lacksRepetition)).toHaveLength(1);
    expect(journeyNameCalls(good).filter(lacksRepetition)).toHaveLength(0);
  });

  it("accepts the index with a trailing comma and across lines", () => {
    const good = `journeyName(
      "pilha",
      "a",
      testInfo.retry,
      testInfo.repeatEachIndex,
    )`;
    expect(journeyNameCalls(good)).toHaveLength(1);
    expect(journeyNameCalls(good).filter(lacksRepetition)).toHaveLength(0);
  });

  it("rejects the index in the wrong position", () => {
    const swapped =
      'journeyName("pilha", "a", testInfo.repeatEachIndex, testInfo.retry)';
    const early = 'journeyName("pilha", testInfo.repeatEachIndex, 0, 0)';
    const extra =
      'journeyName("pilha", "a", testInfo.retry, testInfo.repeatEachIndex, 1)';
    for (const bad of [swapped, early, extra]) {
      expect(journeyNameCalls(bad).filter(lacksRepetition)).toHaveLength(1);
    }
  });

  it("does not take the index from a comment or a string inside the call", () => {
    const inLineComment =
      'journeyName("pilha", "a", testInfo.retry, 0 // testInfo.repeatEachIndex\n)';
    const inBlockComment =
      'journeyName("pilha", "a", testInfo.retry, /* testInfo.repeatEachIndex */ 0)';
    const inString =
      'journeyName("pilha", "a", testInfo.retry, "testInfo.repeatEachIndex")';
    const commas = 'journeyName("a, b", "c", testInfo.retry)';
    for (const bad of [inLineComment, inBlockComment, inString, commas]) {
      expect(journeyNameCalls(bad).filter(lacksRepetition)).toHaveLength(1);
    }
  });

  it("is not thrown off by a quote inside a regular expression before the call", () => {
    const good = `const re = /src="([^"]+)"/;
      journeyName("pilha", "a", testInfo.retry, testInfo.repeatEachIndex)`;
    const bad = `const re = /src="([^"]+)"/;
      journeyName("pilha", "a", testInfo.retry)`;
    expect(journeyNameCalls(good).filter(lacksRepetition)).toHaveLength(0);
    expect(journeyNameCalls(bad).filter(lacksRepetition)).toHaveLength(1);
  });

  it("reads a call inside a template expression and still skips the template text", () => {
    const open = ["$", "{"].join("");
    const bad = `const email = \`${open}journeyName("a", "b", 0)}@x.com\`;`;
    const good = `const email = \`${open}journeyName("a", "b", 0, testInfo.repeatEachIndex)}@x.com\`;`;
    const text = `const note = \`journeyName(1) and ${open}"x"}\`;`;
    expect(journeyNameCalls(bad).filter(lacksRepetition)).toHaveLength(1);
    expect(journeyNameCalls(good).filter(lacksRepetition)).toHaveLength(0);
    expect(journeyNameCalls(text)).toHaveLength(0);
  });

  it("tells a regular expression after a keyword and a division apart", () => {
    const afterKeyword = `function f() { return /"/.test(x); }
      journeyName("a", "b", 0)`;
    const division = `const half = (a + b) / 2; const s = "x";
      journeyName("a", "b", 0)`;
    expect(journeyNameCalls(afterKeyword).filter(lacksRepetition)).toHaveLength(
      1
    );
    expect(journeyNameCalls(division).filter(lacksRepetition)).toHaveLength(1);
  });

  it("finds the end of a template expression past a brace inside a string, a nested template or a comment", () => {
    const open = ["$", "{"].join("");
    const call = 'journeyName("a", "b", retry)';
    const expressions = [
      'f("}")',
      "f('}')",
      "f('{')",
      'f("{")',
      "f(`{`)",
      "f(`}`)",
      `f(\`x ${open}g("}")} y\`)`,
      "f(/* } */ 1)",
      "f(1 // }\n)",
      'f("\\"}")',
    ];
    for (const expression of expressions) {
      const sameExpression = `const s = \`${open}[${expression}, ${call}]}\`;`;
      const nextExpression = `const s = \`${open}${expression}} ${open}${call}}\`;`;
      for (const source of [sameExpression, nextExpression]) {
        expect(journeyNameCalls(source), source).toHaveLength(1);
        expect(
          journeyNameCalls(source).filter(lacksRepetition),
          source
        ).toHaveLength(1);
      }
    }
  });

  it("keeps the template text after an expression with an open brace in a string as text", () => {
    const open = ["$", "{"].join("");
    for (const expression of ["f('{')", 'f("{")', "f(`{`)"]) {
      const source = `const s = \`${open}${expression}} journeyName(1)\`;`;
      expect(journeyNameCalls(source), expression).toHaveLength(0);
    }
  });

  it("still accepts a call with the index after a template expression with a brace in a string", () => {
    const open = ["$", "{"].join("");
    const good = `const s = \`${open}f("}")} ${open}journeyName("a", "b", retry, testInfo.repeatEachIndex)}\`;`;
    expect(journeyNameCalls(good)).toHaveLength(1);
    expect(journeyNameCalls(good).filter(lacksRepetition)).toHaveLength(0);
  });

  it("reads a template without an expression and one with an empty expression as before", () => {
    const open = ["$", "{"].join("");
    const plain = `const s = \`journeyName("a") { } \`; journeyName("a", "b", 0)`;
    const empty = `const s = \`${open}} journeyName("a")\`; journeyName("a", "b", 0)`;
    expect(journeyNameCalls(plain)).toHaveLength(1);
    expect(journeyNameCalls(empty)).toHaveLength(1);
  });

  it("ignores a call that is itself commented out", () => {
    const line = '// journeyName("pilha", "a", testInfo.retry)\nconst x = 1;';
    const block = '/* journeyName("pilha", "a", testInfo.retry) */';
    const quoted = 'const x = "journeyName(1)";';
    for (const source of [line, block, quoted]) {
      expect(journeyNameCalls(source)).toHaveLength(0);
    }
  });
});
