import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * The offline labs and the gallery of the interface (`apps/web/src/offline-poc/`, `apps/web/src/ui-gallery/`) are
 * for the browser checks and the lab build; the production build never loads them (main.tsx reaches them only by
 * `import.meta.env.DEV`, `import.meta.env.MODE` and `VITE_OFFLINE_POC_ENABLED`, which are build constants). Nothing else proves that the
 * dead branches were dropped, so this reads the files of a built `apps/web` and fails when any of them carries a
 * lab: a chunk named after one, a route or an error message that only a lab has, or a source map that lists a lab
 * module among its sources. What a source map holds as `sourcesContent` is not read: it is the text of main.tsx,
 * which names every lab on purpose.
 */

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
export const DEFAULT_BUILD_DIR = path.join(root, "apps/web/dist");

/**
 * `build:offline-poc` writes the lab build to `dist/offline-poc`, beside the client and the Worker that the deploy
 * follows. That folder is the lab on purpose and is never deployed: it is skipped by this exact name at the top of the
 * scanned directory, and a folder of that name anywhere deeper is still scanned.
 */
export const LAB_BUILD_FOLDER = "offline-poc";

/** Paths the labs answer at (main.tsx). A route here in a production file means a lab branch survived. */
export const LAB_ROUTES = [
  "/offline-attention-lab",
  "/offline-local-lab",
  "/offline-logout-lab",
  "/offline-outbox-lab",
  "/offline-poc",
  "/offline-runtime-lab",
  "/offline-screens-lab",
  "/ui-galeria",
  "/ui-pecas-do-shell",
];

/** The file names of the labs, as a chunk, a stylesheet or a source path carries them (the bundler names a chunk after its module). */
export const LAB_MODULES = [
  "attention-lab",
  "lab-page",
  "local-collections-lab",
  "local-lab-server",
  "logout-lab",
  "notice-lab-pages",
  "offline-persistence-lab",
  "offline-poc",
  "outbox-lab",
  "products-lab-server",
  "runtime-lab",
  "sale-lab-server",
  "screens-lab",
  "ui-gallery",
];

/** Directories of lab modules whose files have names too common to search for (`runtime.ts`): a source map that lists one has a lab in it. */
export const LAB_SOURCE_DIRECTORIES = ["offline-poc", "ui-gallery"];

/** The failure screens of the lazy imports of main.tsx: text that survives minification when the branch does. */
export const LAB_MESSAGES = [
  "Carregando laboratório offline",
  "Falha ao abrir a galeria da interface",
  "Falha ao abrir as peças do shell",
  "Falha ao abrir o laboratório",
];

const SCRIPT_FILE = /\.m?js$/;
const NOT_AN_IDENTIFIER_CHARACTER = "(?<![A-Za-z0-9])";
const NOT_FOLLOWED_BY_ONE = "(?![A-Za-z0-9])";

const escapeForRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const named = (names) =>
  new RegExp(
    `${NOT_AN_IDENTIFIER_CHARACTER}(?:${names.map(escapeForRegExp).join("|")})${NOT_FOLLOWED_BY_ONE}`
  );

export const NAME_PATTERN = named([
  ...LAB_MODULES,
  ...LAB_ROUTES.map((route) => route.slice(1)),
]);
const ROUTE_PATTERN = new RegExp(
  `(?:${LAB_ROUTES.map(escapeForRegExp).join("|")})${NOT_FOLLOWED_BY_ONE}`
);
const MESSAGE_PATTERN = new RegExp(LAB_MESSAGES.map(escapeForRegExp).join("|"));
const SOURCE_DIRECTORY_PATTERN = new RegExp(
  `(?:^|[\\\\/])(?:${LAB_SOURCE_DIRECTORIES.map(escapeForRegExp).join("|")})[\\\\/]`
);

export function collectFiles(directory) {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name))
    .sort();
}

function mapProblems(relative, text) {
  let sources;
  try {
    ({ sources } = JSON.parse(text));
  } catch {
    return [
      `${relative}: source map is not valid JSON, so its sources cannot be checked`,
    ];
  }
  if (!Array.isArray(sources)) {
    return [`${relative}: source map has no "sources" list`];
  }
  return sources
    .filter(
      (source) =>
        typeof source === "string" &&
        (SOURCE_DIRECTORY_PATTERN.test(source) || NAME_PATTERN.test(source))
    )
    .map((source) => `${relative}: source map lists the lab module ${source}`);
}

function contentProblems(relative, text) {
  const problems = [];
  const route = ROUTE_PATTERN.exec(text);
  if (route) {
    problems.push(`${relative}: carries the lab route ${route[0]}`);
  }
  const message = MESSAGE_PATTERN.exec(text);
  if (message) {
    problems.push(`${relative}: carries the lab message "${message[0]}"`);
  }
  const name = NAME_PATTERN.exec(text);
  if (name && !route) {
    problems.push(`${relative}: carries the lab module name ${name[0]}`);
  }
  return problems;
}

/**
 * Problems of a built directory, empty when no file is a lab. A directory that is not a build of the web app
 * (missing, no `index.html`, no script) is a problem too: a check that scanned nothing proves nothing.
 */
export function findLabProblems(buildDirectory) {
  if (!(existsSync(buildDirectory) && statSync(buildDirectory).isDirectory())) {
    return {
      problems: [
        `${buildDirectory}: no build found (run the production build of apps/web first)`,
      ],
      scanned: 0,
    };
  }
  const files = collectFiles(buildDirectory)
    .map((file) => ({
      file,
      relative: path.relative(buildDirectory, file).split(path.sep).join("/"),
    }))
    .filter(({ relative }) => !relative.startsWith(`${LAB_BUILD_FOLDER}/`));
  const problems = [];
  if (!files.some(({ relative }) => relative.endsWith("index.html"))) {
    problems.push(
      `${buildDirectory}: no index.html, so this is not the client build of apps/web`
    );
  }
  if (!files.some(({ relative }) => SCRIPT_FILE.test(relative))) {
    problems.push(
      `${buildDirectory}: no script found, so this is not a build of apps/web`
    );
  }
  for (const { file, relative } of files) {
    const nameHit = NAME_PATTERN.exec(relative);
    if (nameHit) {
      problems.push(
        `${relative}: the file is named after the lab ${nameHit[0]}`
      );
    }
    const text = readFileSync(file, "utf8");
    problems.push(
      ...(relative.endsWith(".map")
        ? mapProblems(relative, text)
        : contentProblems(relative, text))
    );
  }
  return { problems, scanned: files.length };
}

function main() {
  const target = path.resolve(process.argv[2] ?? DEFAULT_BUILD_DIR);
  const { problems, scanned } = findLabProblems(target);
  if (problems.length > 0) {
    console.error(`Lab-free build check failed (${problems.length}):`);
    for (const problem of problems) {
      console.error(`- ${problem}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log(
    `Lab-free build check passed: ${scanned} files under ${path.relative(root, target) || "."} carry no offline lab, no gallery and none of their routes.`
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
