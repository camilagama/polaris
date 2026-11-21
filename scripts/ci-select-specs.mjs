import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { COVERAGE_MAP, SPEC_FOLDERS } from "../e2e/coverage-map.mjs";

/**
 * Which e2e specs a diff can break, from `e2e/coverage-map.mjs`.
 *
 *   node scripts/ci-select-specs.mjs <file>...        the changed paths as arguments
 *   git diff --name-only A B | node scripts/ci-select-specs.mjs
 *
 * Prints `{ "full": boolean, "specs": string[], "motivo": string }`. `full: true` means the whole suite runs and
 * `specs` is empty. The selector fails safe: an empty diff, a path that forces the whole suite and a path no pair of
 * the map names all answer `full`. The first pair of the map whose glob matches a path decides its specs; a changed
 * spec always selects itself.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const SPEC_FILE = /\.e2e\.ts$/;

/**
 * What cannot be narrowed: the dependencies, the configs that build or run the specs, the workflows, the code every
 * screen shares (shell, helpers, interface base, offline runtime, styles), the Worker, the packages the bundle takes
 * from, and the helpers and fixtures of the e2e folders (a spec is not one; a visual baseline is a snapshot, which the
 * map names).
 */
const FORCES_FULL = [
  [/(^|\/)package\.json$/, "package.json"],
  [/^bun\.lock$/, "bun.lock"],
  [/^bunfig\.toml$/, "bunfig.toml"],
  [/^\.(bun|node)-version$/, "versão de runtime"],
  [/^apps\/web\/playwright[^/]*\.config\.ts$/, "config do Playwright"],
  [/(^|\/)vite[^/]*\.(config\.)?(ts|mts|mjs|js)$/, "config do Vite"],
  [/(^|\/)tsconfig[^/]*\.json$/, "config do TypeScript"],
  [/^biome\.jsonc?$/, "config do Biome"],
  [/^\.github\//, ".github"],
  [
    /^apps\/web\/src\/(app-shell|lib|ui|offline|styles)\//,
    "código que toda tela usa",
  ],
  [/^apps\/web\/worker\//, "Worker"],
  [/^packages\/(contracts|domain)\//, "pacote contracts/domain"],
  [
    /^apps\/web\/e2e[^/]*\/(?!.*\.e2e\.ts$)(?!.*\.e2e\.ts-snapshots\/)/,
    "helper ou fixture dos e2e",
  ],
];

const compiled = new Map();

/** `**` crosses folders, `*` and `?` stay inside one. */
export function globToRegExp(glob) {
  let regExp = compiled.get(glob);
  if (!regExp) {
    regExp = compileGlob(glob);
    compiled.set(glob, regExp);
  }
  return regExp;
}

function compileGlob(glob) {
  let source = "";
  for (let index = 0; index < glob.length; index += 1) {
    const rest = glob.slice(index);
    if (rest.startsWith("**/")) {
      source += "(?:.*/)?";
      index += 2;
    } else if (rest.startsWith("**")) {
      source += ".*";
      index += 1;
    } else if (glob[index] === "*") {
      source += "[^/]*";
    } else if (glob[index] === "?") {
      source += "[^/]";
    } else {
      source += glob[index].replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

const matches = (globs, file) =>
  globs.some((glob) => globToRegExp(glob).test(file));

/** The spec files on disk: what the three Playwright configs run (`testMatch: **\/*.e2e.ts`). */
export function listSpecFiles(base = root) {
  const found = [];
  const visit = (folder) => {
    for (const entry of readdirSync(path.join(base, folder), {
      withFileTypes: true,
    })) {
      const relative = `${folder}${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") {
          visit(`${relative}/`);
        }
      } else if (SPEC_FILE.test(entry.name)) {
        found.push(relative);
      }
    }
  };
  for (const folder of SPEC_FOLDERS) {
    visit(folder);
  }
  return found.sort();
}

let specsFound;
const specsOnDisk = () => {
  specsFound ??= listSpecFiles();
  return specsFound;
};

const full = (motivo) => ({ full: true, motivo, specs: [] });

const isSpecPath = (file) =>
  SPEC_FILE.test(file) &&
  matches(
    SPEC_FOLDERS.map((folder) => `${folder}**`),
    file
  );

/**
 * What one changed path asks for: `{ reason }` when it needs the whole suite, else `{ specs }`, the specs it selects
 * (a changed spec selects itself).
 */
function selectionFor(file, map, specFiles) {
  const forcing = FORCES_FULL.find(([pattern]) => pattern.test(file));
  if (forcing) {
    return { reason: `${file} força a suíte toda (${forcing[1]})` };
  }
  const spec = isSpecPath(file);
  const pair = map.find((candidate) => matches(candidate.code, file));
  if (!(pair || spec)) {
    return { reason: `${file} está fora do mapa: a suíte toda roda` };
  }
  const specs = new Set(spec && specFiles.includes(file) ? [file] : []);
  for (const candidate of pair ? specFiles : []) {
    if (matches(pair.specs, candidate)) {
      specs.add(candidate);
    }
  }
  return { specs };
}

/**
 * `files` is the list of changed paths. `map` and `specFiles` are injected by the tests; by default they are the
 * committed map and the specs on disk.
 */
export function selectSpecs(
  files,
  { map = COVERAGE_MAP, specFiles = specsOnDisk() } = {}
) {
  const changed = [...new Set(files.map((file) => file.trim()))].filter(
    Boolean
  );
  if (changed.length === 0) {
    return full("diff vazio: sem lista de arquivos, a suíte toda roda");
  }
  const selected = new Set();
  for (const file of changed) {
    const { reason, specs } = selectionFor(file, map, specFiles);
    if (reason) {
      return full(reason);
    }
    for (const spec of specs) {
      selected.add(spec);
    }
  }
  const specs = [...selected].sort();
  const motivo =
    specs.length === 0
      ? "só texto, teste unitário ou spec apagado: nenhum spec precisa rodar"
      : `${specs.length} de ${specFiles.length} specs, pelo mapa de cobertura`;
  return { full: false, motivo, specs };
}

function main() {
  const args = process.argv.slice(2);
  const files = args.length > 0 ? args : readFileSync(0, "utf8").split("\n");
  console.log(JSON.stringify(selectSpecs(files), null, 2));
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
