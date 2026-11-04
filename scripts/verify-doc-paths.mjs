import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  exactCountProblems,
  trackedFiles,
  walkFiles,
} from "./exact-count-list.mjs";
import { DOC_PATHS_LIST } from "./verify-doc-paths.list.mjs";

/**
 * A change that renames, moves or deletes a file has to update the documents that point to it
 * (DESIGN.md, AGENTS.md, doc/, docs/ and the skills); reviewers kept finding docs that still
 * named the old file. This check reads every Markdown file of the repository and resolves each
 * repository path it names: a path between backticks that starts with a top folder (`apps/`,
 * `packages/`, `scripts/`, `docs/`, `doc/`, `design/`, `.claude/`, `.github/`) and the target of
 * a relative Markdown link. A link resolves from the folder of the document, as on GitHub; a path in
 * backticks counts as found from the repository root, the folder of the document or a workspace
 * (`apps/*`, `packages/*`), because runbooks name `scripts/x.ts` meaning the one of the app they talk about.
 * A path counts as found only if git knows it (a file in the index, or a folder that holds one), as in CI;
 * a file that exists only on this machine fails here too.
 *
 * Not checked: build output and local state (`dist`, `.wrangler`, `test-results`, reports,
 * `.dev.vars` and the like), paths with a placeholder (`*`, `<id>`, `{a,b}`, `$VAR`), and names of
 * functions or types, which no file system can confirm. Missing paths that exist before the rule stay
 * in `verify-doc-paths.list.mjs` with their exact count per document and target.
 */
const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

export const LIST_FILE = "scripts/verify-doc-paths.list.mjs";

const TOP_FOLDERS = "apps|packages|scripts|docs|doc|design|\\.claude|\\.github";
const backtickPath = new RegExp(`\`((?:${TOP_FOLDERS})/[^\`\\s]+)\``, "g");
// a link that starts with `/` is a route of the app, not a file
const markdownLink = /\]\((?!https?:|mailto:|#|\/)([^)\s]+)\)/g;
const lineSuffix = /(?::L?\d[\d\-–,L]*)+$|#.*$/;
const trailingPunctuation = /[.,;)]+$/;
const placeholder = /[*<>{}$|]|\.\.\.|…/;
const workspaceFolder = /^(?:apps|packages)\/[^/]+$/;
const trailingSlash = /\/$/;
const NOT_IN_GIT = new Set([
  ".dev.vars",
  ".e2e-state",
  ".lighthouseci",
  ".wrangler",
  "coverage",
  "dist",
  "dist-bare",
  "dist-e2e",
  "dist-fixture",
  "generated",
  "node_modules",
  "playwright-report",
  "reports",
  "test-results",
]);

export const ADVICE =
  "Se o arquivo foi renomeado ou movido, aponte o documento para o caminho novo; se foi apagado, tire a referência " +
  "ou diga o que o substituiu (`rg -n '<nome antigo>' DESIGN.md AGENTS.md doc docs .claude` acha as outras).";

/** The repository paths a Markdown text names, as written (line and anchor suffixes dropped). */
const clean = (name) =>
  name.replace(lineSuffix, "").replace(trailingPunctuation, "");
const checkable = (name) =>
  name !== "" &&
  !placeholder.test(name) &&
  !name.split("/").some((part) => NOT_IN_GIT.has(part));

/**
 * The repository paths a Markdown text names, as written (line and anchor suffixes dropped): `code`
 * for a path between backticks, `link` for the target of a relative link.
 */
export function namedPaths(markdown) {
  const named = [
    ...[...markdown.matchAll(backtickPath)].map((match) => ({
      kind: "code",
      name: clean(match[1]),
    })),
    ...[...markdown.matchAll(markdownLink)].map((match) => ({
      kind: "link",
      name: clean(match[1]),
    })),
  ];
  return named.filter(({ name }) => checkable(name));
}

/**
 * The files git knows plus every folder that holds one, the root included. A path that exists
 * only on this machine is not in it, so it fails here as it does in CI.
 */
export function versionedPaths(base) {
  const known = new Set(["."]);
  for (const file of trackedFiles(base)) {
    known.add(file);
    for (
      let folder = path.posix.dirname(file);
      !known.has(folder);
      folder = path.posix.dirname(folder)
    ) {
      known.add(folder);
    }
  }
  return known;
}

/** The workspace folders (`apps/*`, `packages/*`) among the versioned paths. */
export function workspaceFolders(known) {
  return [...known].filter((entry) => workspaceFolder.test(entry));
}

/**
 * Whether a path named in `document` is versioned. A link resolves from the document's folder only,
 * as on GitHub; a path in backticks from the root, the document's folder or a workspace.
 */
export function resolves(known, document, { kind, name }, workspaces) {
  const decoded = decodeURIComponent(name);
  const folder = path.posix.dirname(document);
  const bases = kind === "link" ? [folder] : [".", folder, ...workspaces];
  return bases.some((from) =>
    known.has(path.posix.join(from, decoded).replace(trailingSlash, "") || ".")
  );
}

export function missingPaths(base = root) {
  const known = versionedPaths(base);
  const workspaces = workspaceFolders(known);
  const found = {};
  for (const document of walkFiles(base, (file) => file.endsWith(".md"))) {
    const markdown = readFileSync(path.join(base, document), "utf8");
    for (const named of namedPaths(markdown)) {
      if (!resolves(known, document, named, workspaces)) {
        const key = `${document} → ${named.name}`;
        found[key] = (found[key] ?? 0) + 1;
      }
    }
  }
  return found;
}

export function checkRepository(base = root, allowed = DOC_PATHS_LIST) {
  return exactCountProblems({
    advice: ADVICE,
    allowed,
    found: missingPaths(base),
    listFile: LIST_FILE,
    what: "referência(s) a um caminho que não existe no repositório",
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const problems = checkRepository(process.argv[2] ?? root);
  for (const problem of problems) {
    console.error(problem);
  }
  if (problems.length > 0) {
    console.error(
      `\n${problems.length} problema(s) de caminho nos documentos.`
    );
    process.exit(1);
  }
  console.log(
    "Todo caminho citado nos documentos está versionado (fora da lista conhecida)."
  );
}
