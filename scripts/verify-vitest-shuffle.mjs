import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { VITEST_SHUFFLE_LIST } from "./verify-vitest-shuffle.list.mjs";
import { stripComments } from "./verify-no-history-comments.mjs";

/**
 * The random order of the Vitest tests is the only thing that shows a test leaning on state another test
 * left behind, and taking the line out of a config turns the order back to fixed with no test failing. The
 * configs listed in `verify-vitest-shuffle.list.mjs` must keep `sequence: { shuffle: ... }`, with `files` and
 * `tests` where the list asks for both.
 *
 * The config is read as text, never run, and its comments are dropped first, so the word "shuffle" in a
 * comment does not count. Read as on: `shuffle: true`, or `shuffle: { files: true, tests: true }` with each
 * half the list needs set to `true`. Only a `sequence` directly in the config's own `test` counts; every one there must say it.
 */
const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

export const LIST_FILE = "scripts/verify-vitest-shuffle.list.mjs";

const FIX =
  "religue `sequence: { shuffle: { files: true, tests: true } }` neste config (só `tests: true` num projeto carregado de arquivo): " +
  "um projeto carregado de arquivo não herda o `sequence` da raiz, então cada um liga o seu. " +
  `Se o config deixou de existir ou nunca teve a ordem aleatória, ajuste ${LIST_FILE} na mesma mudança.`;

const TEST_OPEN = /\btest\s*:\s*\{/g;
const SEQUENCE_OPEN = /\bsequence\s*:\s*\{/g;
const SHUFFLE_FALSE = /\bshuffle\s*:\s*false\b/;
const STRING_LITERAL = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g;
const SHUFFLE_TRUE = /\bshuffle\s*:\s*true\b/;
const SHUFFLE_OBJECT = /\bshuffle\s*:\s*\{/;
const FILES_TRUE = /\bfiles\s*:\s*true\b/;
const TESTS_TRUE = /\btests\s*:\s*true\b/;

function matchingBrace(code, open) {
  let depth = 0;
  for (let index = open; index < code.length; index += 1) {
    if (code[index] === "{") {
      depth += 1;
    } else if (code[index] === "}") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

function depthAt(code, position) {
  let depth = 0;
  for (let index = 0; index < position; index += 1) {
    if (code[index] === "{") {
      depth += 1;
    } else if (code[index] === "}") {
      depth -= 1;
    }
  }
  return depth;
}

/**
 * The `sequence: { ... }` bodies that sit directly in the outermost `test: { ... }`: the one the config
 * itself sets. A `sequence` of an inline project, deeper, neither stands in for it nor counts.
 */
function sequenceBlocks(code) {
  const testDepths = [...code.matchAll(TEST_OPEN)].map((match) =>
    depthAt(code, match.index)
  );
  const wanted = Math.min(...testDepths) + 1;
  const blocks = [];
  for (const match of code.matchAll(SEQUENCE_OPEN)) {
    const open = match.index + match[0].length - 1;
    const close = matchingBrace(code, open);
    if (close > open && depthAt(code, match.index) === wanted) {
      blocks.push(code.slice(open + 1, close));
    }
  }
  return blocks;
}

/** Which halves of the shuffle a `sequence` body turns on: `{ files, tests }`. */
function shuffleOf(body) {
  if (SHUFFLE_TRUE.test(body)) {
    return { files: true, tests: true };
  }
  const object = SHUFFLE_OBJECT.exec(body);
  if (!object) {
    return null;
  }
  const open = object.index + object[0].length - 1;
  const close = matchingBrace(body, open);
  const inner = close > open ? body.slice(open + 1, close) : "";
  return {
    files: FILES_TRUE.test(inner),
    tests: TESTS_TRUE.test(inner),
  };
}

/**
 * What a config lacks of the random order it must keep, as a list of words; empty when it keeps it. String
 * literals are blanked first so a brace or a `sequence` inside one is not read as code, and a
 * `shuffle: false` anywhere in the file (an inline project turning it off) is a failure too.
 */
export function missingShuffle(source, needs) {
  const code = stripComments(source).replace(STRING_LITERAL, '""');
  if (SHUFFLE_FALSE.test(code)) {
    return ["`shuffle: false` fora (ou dentro) do `sequence` do config"];
  }
  const bodies = sequenceBlocks(code);
  if (bodies.length === 0) {
    return ["`sequence`"];
  }
  const shuffles = bodies.map(shuffleOf);
  if (shuffles.some((shuffle) => shuffle === null)) {
    return ["`shuffle` dentro de `sequence`"];
  }
  return [
    ...new Set(
      shuffles.flatMap((shuffle) =>
        needs
          .filter((half) => !shuffle[half])
          .map((half) => `\`${half}: true\``)
      )
    ),
  ];
}

/** `sources` maps each file to its text, or to `undefined` when it does not exist. */
export function shuffleProblems(sources, list = VITEST_SHUFFLE_LIST) {
  const problems = [];
  for (const [file, { needs }] of Object.entries(list)) {
    const source = sources[file];
    if (source === undefined) {
      problems.push(
        `${file}: config da lista não existe. Se ele saiu ou mudou de lugar, ajuste ${LIST_FILE}; se foi apagado sem querer, restaure-o.`
      );
      continue;
    }
    const lacking = missingShuffle(source, needs);
    if (lacking.length > 0) {
      problems.push(
        `${file}: a ordem aleatória do Vitest está desligada; falta ${lacking.join(" e ")}. Para corrigir, ${FIX}`
      );
    }
  }
  return problems;
}

export function checkRepository(base = root, list = VITEST_SHUFFLE_LIST) {
  const sources = Object.fromEntries(
    Object.keys(list).map((file) => {
      const full = path.join(base, file);
      return [file, existsSync(full) ? readFileSync(full, "utf8") : undefined];
    })
  );
  return shuffleProblems(sources, list);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const problems = checkRepository(process.argv[2] ?? root);
  for (const problem of problems) {
    console.error(problem);
  }
  if (problems.length > 0) {
    console.error(
      `\n${problems.length} problema(s) na ordem aleatória do Vitest.`
    );
    process.exit(1);
  }
  console.log(
    `A ordem aleatória segue ligada nos ${Object.keys(VITEST_SHUFFLE_LIST).length} configs do Vitest da lista.`
  );
}
