import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { exactCountProblems, walkFiles } from "./exact-count-list.mjs";
import { DOC_PATHS_LIST } from "./verify-doc-paths.list.mjs";

/**
 * A change that renames, moves or deletes a file has to update the documents that point to it
 * (DESIGN.md, AGENTS.md, doc/, docs/ and the skills); reviewers kept finding docs that still
 * named the old file. This check reads every Markdown file of the repository and resolves each
 * repository path it names: a path between backticks that starts with a top folder (`apps/`,
 * `packages/`, `scripts/`, `docs/`, `doc/`, `design/`, `.claude/`, `.github/`) and the target of
 * a relative Markdown link. A path counts as found when it exists from the repository root, from
 * the folder of the document or from a workspace (`apps/*`, `packages/*`), because runbooks name
 * `scripts/x.ts` meaning the one of the app they talk about.
 *
 * Not checked: build output and local state (`dist`, `.wrangler`, `test-results`, reports,
 * `.dev.vars` and the like), paths with a placeholder (`*`, `<id>`, `{a,b}`, `$VAR`), and names of
 * functions or types, which no file system can confirm. The main branch already has missing paths,
 * so `verify-doc-paths.list.mjs` keeps the exact count per document and target.
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
const NOT_IN_GIT = new Set([
  ".dev.vars",
  ".e2e-state",
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
export function namedPaths(markdown) {
  const named = [];
  for (const match of markdown.matchAll(backtickPath)) {
    named.push(match[1]);
  }
  for (const match of markdown.matchAll(markdownLink)) {
    named.push(match[1]);
  }
  return named
    .map((name) =>
      name.replace(lineSuffix, "").replace(trailingPunctuation, "")
    )
    .filter(
      (name) =>
        name !== "" &&
        !placeholder.test(name) &&
        !name.split("/").some((part) => NOT_IN_GIT.has(part))
    );
}

/** The workspace folders (`apps/*`, `packages/*`) of the repository. */
export function workspaceFolders(base) {
  return ["apps", "packages"].flatMap((top) =>
    existsSync(path.join(base, top))
      ? readdirSync(path.join(base, top), { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => `${top}/${entry.name}`)
      : []
  );
}

/** Whether `name`, named in `document`, exists from the root, the document's folder or a workspace. */
export function resolves(base, document, name, workspaces) {
  const decoded = decodeURIComponent(name);
  const bases = [".", path.posix.dirname(document), ...workspaces];
  return bases.some((from) => existsSync(path.join(base, from, decoded)));
}

export function missingPaths(base = root) {
  const workspaces = workspaceFolders(base);
  const found = {};
  for (const document of walkFiles(base, (file) => file.endsWith(".md"))) {
    const markdown = readFileSync(path.join(base, document), "utf8");
    for (const name of namedPaths(markdown)) {
      if (!resolves(base, document, name, workspaces)) {
        const key = `${document} → ${name}`;
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
    "Todo caminho citado nos documentos existe (fora da lista conhecida)."
  );
}
