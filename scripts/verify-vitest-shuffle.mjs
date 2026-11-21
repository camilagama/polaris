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
 * The config text is read, not run, after comments are dropped. A config passes when some `sequence: { ... }` in it
 * has `shuffle: true` (files and tests) or `shuffle: { files: true, tests: true }` with every key the list
 * asks for set to the literal `true`; the keys of every `sequence` block in the file add up, at any depth.
 * Not caught: a `shuffle` built in a variable or a spread, `sequence` text inside a string, an order switched
 * off from the command line. Quoted keys (`"sequence":`) are not recognised and fail loudly. A config that is not in the list is not read.
 */
const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

export const LIST_FILE = "scripts/verify-vitest-shuffle.list.mjs";

export const ADVICE =
  "Religue `sequence: { shuffle: { files: true, tests: true } }` neste config (`{ tests: true }` num projeto que só ordena os testes); " +
  "um projeto carregado de arquivo não herda o `sequence` da raiz e precisa do seu. " +
  `Se o config deixou de ter ordem aleatória por decisão, tire a entrada de ${LIST_FILE} com o motivo no PR.`;

const SEQUENCE_OPENER = /\bsequence\s*:\s*\{/g;
const SHUFFLE_VALUE = /\bshuffle\s*:\s*(true\b|\{([^{}]*)\})/;
const SHUFFLE_KEY = (key) => new RegExp(String.raw`\b${key}\s*:\s*true\b`);

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

/** The `shuffle` keys a config turns on: `files` and `tests` for `shuffle: true`, those set to `true` in an object. */
export function shuffledKeys(source) {
  const code = stripComments(source);
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
    for (const key of ["files", "tests"]) {
      if (SHUFFLE_KEY(key).test(shuffle[2] ?? "")) {
        keys.add(key);
      }
    }
  }
  return keys;
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
    const keys = shuffledKeys(source);
    const missing = needs.filter((key) => !keys.has(key));
    if (missing.length > 0) {
      problems.push(
        `${file}: falta ${missing.map((key) => `\`${key}: true\``).join(" e ")} em \`sequence: { shuffle: ... }\`. ${ADVICE}`
      );
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
