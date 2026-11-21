import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Comments say why the code is the way it is. Who asked, which task, which review round or which
 * day belong to git, the pull request and the ADR: left in a comment they age, and the next reader
 * takes a one-off fix for a general rule. This check reads only comments (`//`, block and JSDoc in
 * source files, `#` in YAML), never string contents, and fails on task ids, team names, review vocabulary, pull request numbers
 * and dates (dd/mm and yyyy-mm-dd). `ADR 0NNN`, `PRnnn` of the plan, `AC-n`, `GHSA-…`, links and a
 * date between quotes or backticks stay allowed. It walks every source file of the repository except
 * dependencies, build output and generated files, so a new folder is covered without a list to update.
 */
const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const sourceSuffix = /\.(?:ts|tsx|mjs|js)$/;
const yamlSuffix = /\.ya?ml$/;
// Dependencies, build output, generated files and local state: nobody writes a comment there.
export const IGNORED_FOLDERS = new Set([
  ".codex-worktrees",
  ".e2e-state",
  ".git",
  ".turbo",
  ".wrangler",
  "coverage",
  "dist",
  "dist-bare",
  "dist-e2e",
  "dist-fixture",
  "drizzle",
  "generated",
  "node_modules",
  "playwright-report",
  "test-results",
  "worktrees",
]);

export const ADVICE =
  "Deixe só o porquê técnico; autoria e histórico ficam no git, no PR ou no ADR.";

const word = (source) =>
  new RegExp(`(?<![\\p{L}\\p{N}_])(?:${source})(?![\\p{L}\\p{N}_])`, "u");

// The name list is the team and its bots; a name is a capitalized word, so the match is case-sensitive.
const rules = [
  { kind: "id de tarefa", pattern: /\bt\d{3,4}\b/i },
  { kind: "número de PR", pattern: /\bPR\s+#?\d{3,}\b|\bPR\s*#\d+/ },
  {
    kind: "número de PR",
    pattern: /\bpull\s+requests?\s+(?:n[º°o.]\s*)?#?\d+|\bPRs\s+#?\d{3,}\b/i,
  },
  {
    kind: "número de PR",
    ignoreQuoted: true,
    // "#374" alone; #000 and #123456 are colors, so a repeated digit and a run longer than four digits pass
    pattern: /(?<![\p{L}\p{N}_&#/])#(?!(\d)\1{2})\d{3,4}(?![\p{L}\p{N}_])/u,
  },
  {
    kind: "nome de pessoa ou bot",
    pattern: word(
      "Léo|Leo Moura|Rodrigo|Filipe|Petković|Petkovic|Everton|Diego|Arrascaeta|Juan|Bruno|Adriano|Jorginho"
    ),
  },
  { kind: "vocabulário de revisão", pattern: /\brodada\s+\d+/i },
  { kind: "vocabulário de revisão", pattern: /\bvale corrigir\b/i },
  {
    kind: "vocabulário de revisão",
    // the verdict, not the verb: the word as a tag (in brackets, backticks or bold, or opening the comment
    // before a colon) or aimed at the pull request; "o lock bloqueia a entrega" is a reason
    pattern:
      /[[(`*]\s*bloqueia\s*[\])`*]|^\s*(?:\*\s*)?bloqueia\s*[:—–-]|\bbloqueia\s+(?:o\s+)?(?:PR|pull request)\b|\bbloqueia\s+o\s+merge(?=\s*(?:[.,;:)\]]|$)|\s+d[oa]\s+(?:PR|pull request)\b)/i,
  },
  { kind: "vocabulário de revisão", pattern: /\bmenor\s+\d+/i },
  { kind: "vocabulário de revisão", pattern: /\bVC\d+/ },
  { kind: "vocabulário de revisão", pattern: /\bPR-\d+/ },
  { kind: "vocabulário de revisão", pattern: /\bachado do\b/i },
  {
    kind: "data",
    ignoreQuoted: true,
    // yyyy-mm-dd, as in "2026-10-28"; a year and month alone ("2026-10") is a period
    pattern:
      /(?<![\d-])\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])(?![\d-])/,
  },
  {
    kind: "data",
    ignoreQuoted: true,
    // dd/mm with two digits each, or d/m/yy(yy): a bare "24/7" or "3/4" is a ratio, not a day
    pattern:
      /(?<![\d/.])(?:(?:0[1-9]|[12]\d|3[01])\/(?:0[1-9]|1[0-2])(?:\/(?:\d{4}|\d{2}))?|(?:[1-9]|[12]\d|3[01])\/(?:[1-9]|1[0-2])\/(?:\d{4}|\d{2}))(?![\d/])/,
  },
];

const urlPattern = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi;
// A date between quotes or backticks is a value being discussed ("24/10/2026" in a label), not a mark of when.
const quotedPattern = /"[^"]*"|`[^`]*`|“[^”]*”/g;

/** Rules a comment line breaks; links are removed first because they carry paths and dates legitimately. */
export function findViolations(commentText) {
  const text = commentText.replace(urlPattern, " ");
  const found = [];
  const unquoted = text.replace(quotedPattern, " ");
  for (const { kind, pattern, ignoreQuoted } of rules) {
    const match = pattern.exec(ignoreQuoted ? unquoted : text);
    if (match) {
      found.push({ kind, match: match[0] });
    }
  }
  return found;
}

const identifierChar = /[\p{L}\p{N}_$]/u;
const trailingWord = /[\p{L}\p{N}_$]+$/u;
const whitespace = /\s/;
const regexAfterWord = new Set([
  "return",
  "typeof",
  "case",
  "in",
  "of",
  "delete",
  "void",
  "throw",
  "new",
  "else",
  "do",
  "yield",
  "await",
]);
const regexAfterPunctuation = "(,=:[!&|?{};*%~^";

/**
 * Walks a source once and collects its comments. Strings, template literals (with nested `${}`) and
 * regex literals are skipped, so a task id inside a string is not a comment. A quoted string ends at the
 * line break: an apostrophe in JSX text then cannot swallow the rest of the file.
 */
class CommentScanner {
  constructor(source) {
    this.source = source;
    this.comments = [];
    this.ranges = []; // [start, end) offsets of every comment, to cut them out of the source
    this.templateBraces = []; // brace depth at which each open `${` resumes its template
    this.index = 0;
    this.line = 1;
    this.braceDepth = 0;
    this.previous = ""; // last significant character, to tell a regex from a division
  }

  scan() {
    while (this.index < this.source.length) {
      this.step();
    }
    return this;
  }

  step() {
    const char = this.source[this.index];
    const next = this.source[this.index + 1];
    if (char === "\n") {
      this.line += 1;
      this.index += 1;
    } else if (char === "/" && next === "/") {
      this.lineComment();
    } else if (char === "/" && next === "*") {
      this.blockComment();
    } else if ((char === '"' || char === "'") && !this.afterWord()) {
      this.quoted(char);
    } else if (char === "`") {
      this.index += 1;
      this.template();
    } else if (char === "/" && this.regexAllowed()) {
      this.regex();
    } else {
      this.punctuation(char);
    }
  }

  lineComment() {
    const end = this.source.indexOf("\n", this.index);
    const stop = end === -1 ? this.source.length : end;
    this.ranges.push([this.index, stop]);
    this.comments.push({
      line: this.line,
      text: this.source.slice(this.index + 2, stop),
    });
    this.index = stop;
  }

  blockComment() {
    const end = this.source.indexOf("*/", this.index + 2);
    const stop = end === -1 ? this.source.length : end;
    const parts = this.source.slice(this.index + 2, stop).split("\n");
    this.ranges.push([this.index, end === -1 ? stop : end + 2]);
    for (const [offset, text] of parts.entries()) {
      this.comments.push({ line: this.line + offset, text });
    }
    this.line += parts.length - 1;
    this.index = end === -1 ? this.source.length : end + 2;
  }

  // A quote glued to a word is an apostrophe of JSX text ("Don't"), never the start of a string.
  afterWord() {
    return identifierChar.test(this.source[this.index - 1] ?? "");
  }

  quoted(quote) {
    this.index += 1;
    while (this.index < this.source.length) {
      const char = this.source[this.index];
      if (char === "\n") {
        break;
      }
      if (char === "\\" && this.source[this.index + 1] === "\n") {
        this.line += 1;
      }
      this.index += char === "\\" ? 2 : 1;
      if (char === quote) {
        break;
      }
    }
    this.previous = quote;
  }

  // Positioned after the opening backtick, or after the `}` that closes a `${`.
  template() {
    while (this.index < this.source.length) {
      const char = this.source[this.index];
      if (char === "`") {
        this.index += 1;
        this.previous = "`";
        return;
      }
      if (char === "$" && this.source[this.index + 1] === "{") {
        this.index += 2;
        this.templateBraces.push(this.braceDepth);
        this.braceDepth += 1;
        this.previous = "{";
        return;
      }
      const skipped = char === "\\" ? 2 : 1;
      this.line +=
        this.source.slice(this.index, this.index + skipped).split("\n").length -
        1;
      this.index += skipped;
    }
  }

  regex() {
    let inClass = false;
    this.index += 1;
    while (
      this.index < this.source.length &&
      this.source[this.index] !== "\n"
    ) {
      const char = this.source[this.index];
      if (char === "\\") {
        this.index += 2;
        continue;
      }
      if (char === "/" && !inClass) {
        this.index += 1;
        this.skipFlags();
        break;
      }
      if (char === "[") {
        inClass = true;
      } else if (char === "]") {
        inClass = false;
      }
      this.index += 1;
    }
    this.previous = "/";
  }

  skipFlags() {
    while (
      this.index < this.source.length &&
      identifierChar.test(this.source[this.index])
    ) {
      this.index += 1;
    }
  }

  regexAllowed() {
    if (this.previous === "" || regexAfterPunctuation.includes(this.previous)) {
      return true;
    }
    if (this.previous === ">") {
      return this.source.slice(0, this.index).trimEnd().endsWith("=>");
    }
    if (!identifierChar.test(this.previous)) {
      return false;
    }
    const before = this.source.slice(0, this.index).trimEnd();
    return regexAfterWord.has(trailingWord.exec(before)?.[0] ?? "");
  }

  punctuation(char) {
    this.index += 1;
    if (char === "{") {
      this.braceDepth += 1;
    } else if (char === "}") {
      this.braceDepth -= 1;
      if (this.templateBraces.at(-1) === this.braceDepth) {
        this.templateBraces.pop();
        this.template();
        return;
      }
    }
    if (!whitespace.test(char)) {
      this.previous = char;
    }
  }
}

/** Comments of a TS/TSX/JS source as `{ line, text }`, one entry per physical line. */
export function extractComments(source) {
  return new CommentScanner(source).scan().comments;
}

/** The source without its comments: what must stay identical when a comment is only reworded. */
export function stripComments(source) {
  let code = "";
  let from = 0;
  for (const [start, end] of new CommentScanner(source).scan().ranges) {
    code += source.slice(from, start);
    from = end;
  }
  return code + source.slice(from);
}

const blockScalarHeader = /(?:^|[:?-])\s+(?:[&!]\S+\s+)*[|>][+-]?\d?[+-]?\s*$/;
const sequenceItemPrefix = /^\s*(?:[-?]\s+)*/;
const keylessHeader = /^(?:[&!]\S+\s+)*[|>]/;
const quoteChars = "\"'";
const yamlValueOpeners = ":-,[{?";

/**
 * Comments of a YAML file as `{ line, text }`. A `#` starts a comment only at the start of a line or after
 * whitespace and outside quotes; the lines of a block scalar (`|`, `>`) and the text of a quoted scalar,
 * even one that spans lines, are string contents and never read.
 */
export function extractYamlComments(source) {
  const comments = [];
  let blockIndent = -1;
  let openQuote = "";
  for (const [offset, line] of source.split("\n").entries()) {
    if (blockIndent >= 0) {
      if (line.trim() === "" || indentOf(line) > blockIndent) {
        continue;
      }
      blockIndent = -1;
    }
    const scan = scanYamlLine(line, openQuote);
    ({ openQuote } = scan);
    if (scan.comment !== null) {
      comments.push({ line: offset + 1, text: scan.comment });
    }
    if (openQuote === "" && blockScalarHeader.test(scan.content)) {
      blockIndent = keyIndentOf(scan.content);
    }
  }
  return comments;
}

function indentOf(line) {
  return line.length - line.trimStart().length;
}

// A block scalar's lines sit deeper than its key, or than the last `-`/`?` indicator when the header has no key.
function keyIndentOf(content) {
  const prefix = sequenceItemPrefix.exec(content)?.[0] ?? "";
  return keylessHeader.test(content.slice(prefix.length))
    ? Math.max(prefix.trimEnd().length - 1, 0)
    : prefix.length;
}

function scanYamlLine(line, quoteAtStart) {
  let quote = quoteAtStart;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote !== "") {
      if (
        (quote === '"' && char === "\\") ||
        (quote === "'" && char === "'" && line[index + 1] === "'")
      ) {
        index += 1;
      } else if (char === quote) {
        quote = "";
      }
    } else if (
      char === "#" &&
      (index === 0 || whitespace.test(line[index - 1]))
    ) {
      return {
        comment: line.slice(index + 1),
        content: line.slice(0, index),
        openQuote: "",
      };
    } else if ((char === '"' || char === "'") && opensYamlValue(line, index)) {
      quote = char;
    }
  }
  return { comment: null, content: line, openQuote: quote };
}

// A quote starts a scalar only where a value can start; the apostrophe of a plain "don't" does not.
function opensYamlValue(line, index) {
  const before = line.slice(0, index).trimEnd();
  if (before === "") {
    return true;
  }
  const last = before.at(-1);
  if (!yamlValueOpeners.includes(last)) {
    return false;
  }
  return (
    last === "," ||
    last === "[" ||
    last === "{" ||
    before.length < index ||
    (last === ":" && quoteChars.includes(before.at(-2) ?? ""))
  );
}

/** Violations of one file as `{ line, kind, match }`; `.yml` and `.yaml` are read as YAML. */
export function checkSource(source, file = "") {
  const violations = [];
  const comments = yamlSuffix.test(file)
    ? extractYamlComments(source)
    : extractComments(source);
  for (const { line, text } of comments) {
    for (const { kind, match } of findViolations(text)) {
      violations.push({ kind, line, match });
    }
  }
  return violations;
}

function walk(directory, found) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORED_FOLDERS.has(entry.name)) {
        walk(full, found);
      }
    } else if (
      entry.isFile() &&
      (sourceSuffix.test(entry.name) || yamlSuffix.test(entry.name)) &&
      !entry.name.endsWith(".d.ts")
    ) {
      found.push(full);
    }
  }
}

/** Every source and YAML file under `base` (the repository root), tests, e2e, scripts and configs included. */
export function collectFiles(base = root) {
  const found = [];
  walk(base, found);
  return found.sort();
}

export function checkRepository(base = root) {
  const failures = [];
  for (const file of collectFiles(base)) {
    for (const violation of checkSource(readFileSync(file, "utf8"), file)) {
      failures.push({ file: path.relative(base, file), ...violation });
    }
  }
  return failures;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const failures = checkRepository();
  if (failures.length > 0) {
    for (const { file, line, kind, match } of failures) {
      console.error(
        `${file}:${line}: ${kind} em comentário ("${match}"). ${ADVICE}`
      );
    }
    console.error(`\n${failures.length} comentário(s) com histórico.`);
    process.exit(1);
  }
  console.log("Nenhum comentário com histórico.");
}
