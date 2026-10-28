import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Comments say why the code is the way it is. Who asked, which task, which review round or which
 * day belong to git, the pull request and the ADR: left in a comment they age, and the next reader
 * takes a one-off fix for a general rule. This check reads only comments (`//`, block and JSDoc),
 * never string contents, and fails on task ids, team names, review vocabulary and dd/mm dates.
 * `ADR 0NNN`, `PRnnn` of the plan, `AC-n`, `GHSA-…` and links stay allowed.
 */
const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const sourceSuffix = /\.(?:ts|tsx|mjs)$/;
const ignoredFolders = new Set(["node_modules", "dist", ".wrangler"]);
const scannedGroups = [
  ["apps", ["src", "worker"]],
  ["packages", ["src", "scripts"]],
];

export const ADVICE =
  "Deixe só o porquê técnico; autoria e histórico ficam no git, no PR ou no ADR.";

const word = (source) =>
  new RegExp(`(?<![\\p{L}\\p{N}_])(?:${source})(?![\\p{L}\\p{N}_])`, "u");

// The name list is the team and its bots; a name is a capitalized word, so the match is case-sensitive.
const rules = [
  { kind: "id de tarefa", pattern: /\bt\d{3,4}\b/ },
  {
    kind: "nome de pessoa ou bot",
    pattern: word(
      "Léo|Leo Moura|Rodrigo|Filipe|Petković|Petkovic|Everton|Diego|Arrascaeta|Juan|Bruno|Adriano|Jorginho"
    ),
  },
  { kind: "vocabulário de revisão", pattern: /\brodada\s+\d+/i },
  { kind: "vocabulário de revisão", pattern: /\bvale corrigir\b/i },
  { kind: "vocabulário de revisão", pattern: /\bbloqueia\b/i },
  { kind: "vocabulário de revisão", pattern: /\bmenor\s+\d+/i },
  { kind: "vocabulário de revisão", pattern: /\bVC\d+/ },
  { kind: "vocabulário de revisão", pattern: /\bPR-\d+/ },
  { kind: "vocabulário de revisão", pattern: /\bachado do\b/i },
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
const regexAfterPunctuation = "(,=:[!&|?{};+-*%<>~^";

/**
 * Walks a source once and collects its comments. Strings, template literals (with nested `${}`) and
 * regex literals are skipped, so "t123" inside a string is not a comment. A quoted string ends at the
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
    } else if (char === '"' || char === "'") {
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

  quoted(quote) {
    this.index += 1;
    while (this.index < this.source.length) {
      const char = this.source[this.index];
      if (char === "\n") {
        break;
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

/** Violations of one file as `{ line, kind, match }`. */
export function checkSource(source) {
  const violations = [];
  for (const { line, text } of extractComments(source)) {
    for (const { kind, match } of findViolations(text)) {
      violations.push({ kind, line, match });
    }
  }
  return violations;
}

function walk(directory, found) {
  for (const entry of readdirSync(directory)) {
    if (ignoredFolders.has(entry)) {
      continue;
    }
    const full = path.join(directory, entry);
    if (statSync(full).isDirectory()) {
      walk(full, found);
    } else if (sourceSuffix.test(entry) && !entry.endsWith(".d.ts")) {
      found.push(full);
    }
  }
}

/** Every scanned source file under `base` (the repository root), tests included. */
export function collectFiles(base = root) {
  const found = [];
  for (const [group, folders] of scannedGroups) {
    const groupPath = path.join(base, group);
    for (const name of readdirSync(groupPath)) {
      for (const folder of folders) {
        const scanned = path.join(groupPath, name, folder);
        try {
          statSync(scanned);
        } catch {
          continue;
        }
        walk(scanned, found);
      }
    }
  }
  return found.sort();
}

export function checkRepository(base = root) {
  const failures = [];
  for (const file of collectFiles(base)) {
    for (const violation of checkSource(readFileSync(file, "utf8"))) {
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
