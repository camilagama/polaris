import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { VITEST_SHUFFLE_LIST } from "./verify-vitest-shuffle.list.mjs";
import { stripComments } from "./verify-no-history-comments.mjs";

/**
 * Random test order is the only thing that shows a test leaning on state another test left behind, and
 * dropping it turns no test red: the suite just goes back to a fixed order. This check keeps it on in every
 * config of `verify-vitest-shuffle.list.mjs`.
 *
 * The config text is read, not run, after comments are dropped and the content of strings and template literals is
 * emptied. A config passes when the `sequence: { ... }` blocks of its own text (outside the objects of `projects: [...]`)
 * set `shuffle: true` (files and tests) or `shuffle: { files: true, tests: true }` with every key the list asks for to
 * the literal `true`; the keys of the blocks of one project add up, at any depth. An object of `projects: [...]` is a
 * project of its own. Without `extends: true` its own `sequence` has to turn `tests` on. With `extends: true` it
 * inherits the root's order, because Vitest merges the `sequence` of the project into the root's key by key (`mergeConfig`
 * in its project resolution): `sequence: { seed: 1 }` keeps the root's `shuffle`. An object `shuffle` in the project
 * does not: when the root's is the boolean `true`, the merge replaces it by the project's object, and Vitest reads a
 * missing `tests` as off. Only the forms known to keep the tests order are accepted: no `shuffle` in the project's
 * `sequence` blocks, `shuffle: true`, or `shuffle: { ... }` whose only keys are `files` (a literal) and `tests: true`,
 * the latter always written out. A `true` counts only when it stands alone up to the next comma or the end of the
 * object: `true ? ...`, `true && ...` and `true || ...` are refused, and so is an object followed by
 * an operator (`{ tests: true } && off`). In the object form every value is the literal
 * `true` or `false` and no key repeats. Anything else (`shuffle: false`, `tests: false`, a variable, also in `files`, an
 * expression, a spread, a quoted key, a nested object) is refused.
 * Not caught: a `shuffle` built in a variable or a spread outside an `extends: true` project, a `shuffle` repeated in
 * one root `sequence` (only the first is read), `projects` that is not an
 * array literal (a variable, a spread) or is nested in another project, a regular expression literal with a quote in it,
 * an order switched off from the command line.
 * Quoted keys (`"sequence":`) are not recognised: in the root they fail loudly (the key is missing), in an `extends: true`
 * project the quoted `sequence` is not seen, so its block is ignored and the project inherits.
 */
const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

export const LIST_FILE = "scripts/verify-vitest-shuffle.list.mjs";

export const ADVICE =
  "Religue `sequence: { shuffle: { files: true, tests: true } }` neste config (`{ tests: true }` num projeto que só ordena os testes); " +
  "um projeto carregado de arquivo não herda o `sequence` da raiz e precisa do seu. " +
  `Se o config deixou de ter ordem aleatória por decisão, tire a entrada de ${LIST_FILE} com o motivo no PR.`;

const PROJECTS_OPENER = /\bprojects\s*:\s*\[/g;
const EXTENDS_TRUE = /\bextends\s*:\s*true\b/;
const QUOTES = "\"'`";
const SEQUENCE_OPENER = /\bsequence\s*:\s*\{/g;
const SHUFFLE_VALUE =
  /\bshuffle\s*:\s*(true(?=\s*(?:,|$))|\{([^{}]*)\}(?=\s*(?:,|$)))/;
const SHUFFLE_WORD = /\bshuffle\b/g;
const SHUFFLE_KEY_START = /^\s*:\s*/;
const QUOTED_KEY = /(""|''|``)\s*:/;
const SPREAD = /\.\.\./;
const VALUE_END = /^\s*(?:,|$)/;
const TRUE_VALUE = /^true\s*(?:,|$)/;
const SHUFFLE_ENTRY = /^(files|tests)\s*:\s*(true|false)$/;

function objectBody(code, openIndex) {
  let depth = 0;
  for (let index = openIndex; index < code.length; index += 1) {
    if (code[index] === "{") {
      depth += 1;
    } else if (code[index] === "}") {
      depth -= 1;
      if (depth === 0) {
        return code.slice(openIndex + 1, index);
      }
    }
  }
  return code.slice(openIndex + 1);
}

function skipString(code, openIndex) {
  const quote = code[openIndex];
  let index = openIndex + 1;
  while (index < code.length && code[index] !== quote) {
    if (code[index] === "\\") {
      index += 2;
    } else if (quote === "`" && code.startsWith("${", index)) {
      index = skipTemplateExpression(code, index + 2);
    } else {
      index += 1;
    }
  }
  return index + 1;
}

function skipTemplateExpression(code, from) {
  let depth = 1;
  let index = from;
  while (index < code.length && depth > 0) {
    if (QUOTES.includes(code[index])) {
      index = skipString(code, index);
      continue;
    }
    if (code[index] === "{") {
      depth += 1;
    } else if (code[index] === "}") {
      depth -= 1;
    }
    index += 1;
  }
  return index;
}

/** The code with the content of every string and template literal emptied, so text inside one is never read as code. */
export function blankStrings(code) {
  let out = "";
  let index = 0;
  while (index < code.length) {
    if (QUOTES.includes(code[index])) {
      out += code[index] + code[index];
      index = skipString(code, index);
    } else {
      out += code[index];
      index += 1;
    }
  }
  return out;
}

function closeIndex(code, openIndex, open, close) {
  let depth = 0;
  for (let index = openIndex; index < code.length; index += 1) {
    if (code[index] === open) {
      depth += 1;
    } else if (code[index] === close) {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return code.length - 1;
}

function inlineProjectRanges(code) {
  const ranges = [];
  for (const opener of code.matchAll(PROJECTS_OPENER)) {
    const open = opener.index + opener[0].length - 1;
    if (ranges.some(([from, to]) => open > from && open < to)) {
      continue;
    }
    const end = closeIndex(code, open, "[", "]");
    for (let index = open + 1; index < end; index += 1) {
      if (code[index] === "{") {
        const objectEnd = closeIndex(code, index, "{", "}");
        ranges.push([index, objectEnd + 1]);
        index = objectEnd;
      }
    }
  }
  return ranges.sort((a, b) => a[0] - b[0]);
}

function shuffleFlags(inner) {
  const flags = new Map();
  for (const entry of inner.split(",")) {
    const text = entry.trim();
    if (text === "") {
      continue;
    }
    const match = SHUFFLE_ENTRY.exec(text);
    if (match === null || flags.has(match[1])) {
      return null;
    }
    flags.set(match[1], match[2] === "true");
  }
  return flags;
}

function keysOfBlocks(code) {
  const keys = new Set();
  for (const opener of code.matchAll(SEQUENCE_OPENER)) {
    const body = objectBody(code, opener.index + opener[0].length - 1);
    const shuffle = SHUFFLE_VALUE.exec(body);
    if (shuffle === null) {
      continue;
    }
    if (shuffle[1] === "true") {
      keys.add("files");
      keys.add("tests");
      continue;
    }
    const flags = shuffleFlags(shuffle[2] ?? "");
    for (const key of ["files", "tests"]) {
      if (flags?.get(key) === true) {
        keys.add(key);
      }
    }
  }
  return keys;
}

function shuffleValueKeepsTests(value) {
  if (TRUE_VALUE.test(value)) {
    return true;
  }
  if (!value.startsWith("{")) {
    return false;
  }
  const end = closeIndex(value, 0, "{", "}");
  return (
    VALUE_END.test(value.slice(end + 1)) &&
    shuffleFlags(value.slice(1, end))?.get("tests") === true
  );
}

function sequenceBodyKeepsTests(body) {
  if (QUOTED_KEY.test(body) || SPREAD.test(body)) {
    return false;
  }
  for (const word of body.matchAll(SHUFFLE_WORD)) {
    const rest = body.slice(word.index + word[0].length);
    const colon = SHUFFLE_KEY_START.exec(rest);
    if (
      colon === null ||
      !shuffleValueKeepsTests(rest.slice(colon[0].length))
    ) {
      return false;
    }
  }
  return true;
}

function keepsTestsShuffle(code) {
  return [...code.matchAll(SEQUENCE_OPENER)].every((opener) =>
    sequenceBodyKeepsTests(
      objectBody(code, opener.index + opener[0].length - 1)
    )
  );
}

/**
 * The places a config orders tests: its own text first (`inline: 0`), then each object of `projects: [...]`
 * (`inline: 1, 2, ...`), with the `shuffle` keys each turns on and whether it inherits the root's order.
 */
export function shuffleUnits(source) {
  const code = blankStrings(stripComments(source));
  const ranges = inlineProjectRanges(code);
  let rootText = code;
  for (const [from, to] of ranges) {
    rootText =
      rootText.slice(0, from) + " ".repeat(to - from) + rootText.slice(to);
  }
  const projects = ranges.map(([from, to], index) => {
    const text = code.slice(from, to);
    return {
      inherits: EXTENDS_TRUE.test(text) && keepsTestsShuffle(text),
      inline: index + 1,
      keys: keysOfBlocks(text),
    };
  });
  return [
    { inherits: false, inline: 0, keys: keysOfBlocks(rootText) },
    ...projects,
  ];
}

/** The `shuffle` keys the config turns on in its own text, outside its inline projects. */
export function shuffledKeys(source) {
  return shuffleUnits(source)[0].keys;
}

export function shuffleProblems(sources, list = VITEST_SHUFFLE_LIST) {
  const problems = [];
  for (const [file, { needs }] of Object.entries(list)) {
    const source = sources[file];
    if (source === undefined) {
      problems.push(
        `${file}: o config da lista não existe. Se ele foi renomeado ou apagado, atualize a entrada em ${LIST_FILE}; se não, restaure-o.`
      );
      continue;
    }
    for (const unit of shuffleUnits(source)) {
      const wanted =
        unit.inline === 0 ? needs : needs.filter((key) => key === "tests");
      const missing = unit.inherits
        ? []
        : wanted.filter((key) => !unit.keys.has(key));
      if (missing.length > 0) {
        const where =
          unit.inline === 0 ? "" : `projeto inline ${unit.inline}: `;
        problems.push(
          `${file}: ${where}falta ${missing.map((key) => `\`${key}: true\``).join(" e ")} em \`sequence: { shuffle: ... }\`. ${ADVICE}`
        );
      }
    }
  }
  return problems;
}

export function checkRepository(base = root, list = VITEST_SHUFFLE_LIST) {
  const sources = {};
  for (const file of Object.keys(list)) {
    const full = path.join(base, file);
    if (existsSync(full)) {
      sources[file] = readFileSync(full, "utf8");
    }
  }
  return shuffleProblems(sources, list);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const problems = checkRepository(process.argv[2] ?? root);
  for (const problem of problems) {
    console.error(problem);
  }
  if (problems.length > 0) {
    console.error(
      `\n${problems.length} config(s) sem ordem aleatória do Vitest.`
    );
    process.exit(1);
  }
  console.log(
    `Ordem aleatória do Vitest ligada nos ${Object.keys(VITEST_SHUFFLE_LIST).length} configs da lista.`
  );
}
