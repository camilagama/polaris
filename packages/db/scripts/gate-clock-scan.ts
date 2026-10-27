/**
 * What reads the time of day in a TypeScript source (t438): `Date.now`, `new Date()` (also `new Date`, `new
 * Date(undefined)`), `Date()` without `new`, `Date["now"]`, the alias `= Date;` and `Temporal.Now`. Comments, the text
 * of strings and templates and regular expressions are blanked first, so the words in prose do not count; the code in
 * a `${}` stays. The rule that uses it is `gate-loose-clock.test.ts`.
 */
const LOOSE_CLOCK = [
  /\bDate\s*\.\s*now\b/g,
  /\bnew\s+Date\s*\(\s*(?:undefined|void\s+0)?\s*\)/g,
  /\bnew\s+Date\b(?!\s*\()/g,
  /(?<!new\s+)(?<![.\w])Date\s*\(\s*\)/g,
  /\bDate\s*\[/g,
  /[=]\s*(?:globalThis\s*\.\s*)?Date\s*[;,]/g,
  /\bTemporal\s*\.\s*Now\b/g,
];

const NOT_NEWLINE = /[^\n]/g;
// after these a `/` opens a regular expression; after anything else (a name, `)`, `]`, a number) it divides
const REGEX_AFTER = new Set([..."(,=:[!&|?{};+-*%<>~^"]);
const KEYWORD_BEFORE_REGEX = /\b(?:return|typeof)$/;

const blank = (text: string) => text.replace(NOT_NEWLINE, " ");

function endOfQuoted(source: string, from: number, quote: string): number {
  let stop = from + 1;
  while (stop < source.length && source[stop] !== quote) {
    stop += source[stop] === "\\" ? 2 : 1;
  }
  return stop;
}

function endOfRegex(source: string, from: number): number {
  let stop = from + 1;
  let inClass = false;
  while (stop < source.length && source[stop] !== "\n") {
    const here = source[stop];
    if (here === "\\") {
      stop += 2;
      continue;
    }
    if (here === "[") {
      inClass = true;
    } else if (here === "]") {
      inClass = false;
    } else if (here === "/" && !inClass) {
      break;
    }
    stop += 1;
  }
  return stop;
}

function opensRegex(before: string): boolean {
  const last = before.trimEnd();
  return (
    last === "" ||
    REGEX_AFTER.has(last.slice(-1)) ||
    KEYWORD_BEFORE_REGEX.test(last)
  );
}

interface Step {
  next: number;
  text: string;
}

/** The state that outlives a step: one entry per open `${`, with how many `{` of the code inside it are still open. */
type TemplateParts = number[];

function commentStep(source: string, index: number): Step | null {
  const pair = source.slice(index, index + 2);
  if (pair !== "//" && pair !== "/*") {
    return null;
  }
  const end = source.indexOf(pair === "//" ? "\n" : "*/", index + 2);
  const next = end === -1 ? source.length : end + (pair === "//" ? 0 : 2);
  return { next, text: blank(source.slice(index, next)) };
}

function quotedStep(source: string, index: number): Step | null {
  const char = source[index] ?? "";
  if (char !== "'" && char !== '"') {
    return null;
  }
  const stop = endOfQuoted(source, index, char);
  return {
    next: stop + 1,
    text: char + blank(source.slice(index + 1, stop)) + char,
  };
}

/** The static text of a template, from its opening quote or from the `}` that closes a `${`, up to the next `${` or the end. */
function templateStep(
  source: string,
  index: number,
  parts: TemplateParts
): Step | null {
  const char = source[index] ?? "";
  const closesPart = char === "}" && parts.at(-1) === 0;
  if (char !== "`" && !closesPart) {
    return null;
  }
  if (closesPart) {
    parts.pop();
  }
  let stop = index + 1;
  while (
    stop < source.length &&
    source[stop] !== "`" &&
    !(source[stop] === "$" && source[stop + 1] === "{")
  ) {
    stop += source[stop] === "\\" ? 2 : 1;
  }
  const text = char + blank(source.slice(index + 1, stop));
  if (source[stop] === "$") {
    parts.push(0);
    return { next: stop + 2, text: `${text}\${` };
  }
  return { next: stop + 1, text: `${text}\`` };
}

function regexStep(source: string, index: number, before: string): Step | null {
  if (source[index] !== "/" || !opensRegex(before)) {
    return null;
  }
  const stop = endOfRegex(source, index);
  return { next: stop + 1, text: `/${blank(source.slice(index + 1, stop))}/` };
}

function trackBraces(char: string, parts: TemplateParts): void {
  const last = parts.length - 1;
  if (last < 0) {
    return;
  }
  if (char === "{") {
    parts[last] = (parts[last] ?? 0) + 1;
  } else if (char === "}") {
    parts[last] = (parts[last] ?? 1) - 1;
  }
}

/** The source with comments, strings, template text and regular expressions blanked (same length, same lines). */
function codeOnly(source: string): string {
  let out = "";
  let index = 0;
  const parts: TemplateParts = [];
  while (index < source.length) {
    const step =
      commentStep(source, index) ??
      quotedStep(source, index) ??
      templateStep(source, index, parts) ??
      regexStep(source, index, out);
    if (step) {
      out += step.text;
      index = step.next;
    } else {
      const char = source[index] ?? "";
      trackBraces(char, parts);
      out += char;
      index += 1;
    }
  }
  return out;
}

export function countLooseClock(source: string): number {
  const code = codeOnly(source);
  return LOOSE_CLOCK.reduce(
    (count, pattern) => count + [...code.matchAll(pattern)].length,
    0
  );
}
