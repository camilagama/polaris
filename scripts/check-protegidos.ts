import { execFileSync } from "node:child_process";
import { posix } from "node:path";
import { pathToFileURL } from "node:url";
import { codeOnly } from "../packages/db/scripts/gate-clock-scan.ts";

/**
 * Guard of the protected tests (`tests/protegidos.txt`). Compares the base of a pull request with its head and fails
 * when a test the list covers is deleted, leaves the list, is weakened, or stops being run by its Vitest/Playwright
 * config; a commit trailer with the accepted name (`ACCEPT_TRAILER`, `ACCEPTED_BY`) releases the change and the report says what it released.
 *
 *   bun scripts/check-protegidos.ts [--base origin/main] [--head HEAD] [--cwd <repository>] [--list-from <commit>]
 *
 * The comparison reads the trees of two commits (`git show`), never the working copy, and counts on the source with
 * comments, strings and regular expressions blanked (`codeOnly`): a file weakens when, against the base, it gains a
 * `.skip`/`.only`/`.todo`/`.fixme`/`.fail`, gains a `retry`/`retries` above zero or a quarantine marker, loses
 * `expect`/`assert*` calls or loses `it`/`test` cases. What text cannot show is listed in `NOT_CHECKED`.
 */

export const LIST_PATH = "tests/protegidos.txt";
export const ACCEPT_TRAILER = "Protegido-Aceito-Por";
export const ACCEPTED_BY = "Rodrigo";

export const NOT_CHECKED = [
  "matriz de shards e `--shard`, `--project` e `paths:` dos workflows (`.github/workflows`): não se conferem por texto aqui",
  "filtros de caminho do `scripts/ci-changed.mjs` (quais jobs rodam para qual caminho)",
  "lista de arquivos montada fora de literal (`testMatch: NOME_DA_CONSTANTE` sem a constante no mesmo arquivo, glob montado por código)",
  "mover um teste protegido para outro workflow (noturno) sem mexer na config",
  "asserção, caso ou `.skip` trocado por outro mais fraco ou de lugar, sem mudar a contagem",
  "pulo que o texto não mostra (`if (cond) return` no corpo do teste, nome do pulo guardado em variável)",
  "gate de banco tirado da lista do `run-gates.ts` ou de uma suíte sem apagar o arquivo",
];

const CONFIG_FILE =
  /(?:^|\/)(?:vitest|playwright)[^/]*config[^/]*\.(?:ts|mts|cts|mjs|cjs|js)$/;
const WATCHED_FOR_WARNING =
  /^(?:\.github\/workflows\/|scripts\/ci-changed\.mjs$|scripts\/check-protegidos\.ts$|tests\/protegidos\.txt$)/;

const SKIP_MEMBER =
  /(?<![.\w$])(?:it|test|describe|suite|bench)(?:\.\w+)*\.(?:skip|only|todo|fixme|fail|fails|skipIf|runIf)\b/g;
const SKIP_PREFIXED = /(?<![.\w$])(?:xit|xtest|xdescribe)\s*\(/g;
const SKIP_CONTEXT_CALL = /\.(?:skip|fixme)(?=\s*\()/g;
const SKIP_DESTRUCTURED_CALL = /(?<![.\w$])(?:skip|fixme)(?=\s*\()/g;
const SKIP_OPTION =
  /(?<![.\w$])(?:skip|todo|fails)\s*:\s*(?!(?:false|null|undefined|0)(?![\w$]))[^\s,})]/g;
const RETRY = /(?<![\w$])retr(?:y|ies)\s*:\s*([^,}\n]+)/g;
const QUARANTINE = /quarantine|quarentena/gi;
const ASSERTION = /(?<![.\w$])(?:expect|assert)\w*\s*[(<.]/g;
const CASE =
  /(?<![.\w$])(?:it|test)(?:\.(?:each|concurrent|sequential|for|scoped)\b)*\s*[(<`]/g;
const DIGITS = /\d+/g;
const TRUE_VALUE = /\btrue\b/;

export interface FileMetrics {
  assertions: number;
  cases: number;
  quarantine: number;
  retryCount: number;
  retrySum: number;
  skips: number;
}

const count = (code: string, pattern: RegExp): number =>
  [...code.matchAll(pattern)].length;

/** Every form that turns a case off, counted once by where its keyword ends: `it.skip`, `ctx.skip()`, a destructured `skip()`, `testInfo.fixme()` and `{ skip: true }` in the options of a case. */
function skipsIn(code: string): number {
  const ends = new Set<number>();
  for (const pattern of [
    SKIP_MEMBER,
    SKIP_CONTEXT_CALL,
    SKIP_DESTRUCTURED_CALL,
  ]) {
    for (const match of code.matchAll(pattern)) {
      ends.add(match.index + match[0].length);
    }
  }
  for (const match of code.matchAll(SKIP_OPTION)) {
    ends.add(match.index + match[0].length);
  }
  return ends.size;
}

export function retryFacts(code: string): { count: number; sum: number } {
  let retryCount = 0;
  let sum = 0;
  for (const match of code.matchAll(RETRY)) {
    const value = match[1] ?? "";
    const digits = (value.match(DIGITS) ?? []).reduce(
      (total, digit) => total + Number(digit),
      0
    );
    const enabled = digits > 0 || TRUE_VALUE.test(value);
    retryCount += enabled ? 1 : 0;
    sum += digits;
  }
  return { count: retryCount, sum };
}

export function metricsOf(source: string): FileMetrics {
  const code = codeOnly(source);
  const retries = retryFacts(code);
  return {
    assertions: count(code, ASSERTION),
    cases: count(code, CASE),
    quarantine: count(source, QUARANTINE),
    retryCount: retries.count,
    retrySum: retries.sum,
    skips: skipsIn(code) + count(code, SKIP_PREFIXED),
  };
}

export function weakenings(base: FileMetrics, head: FileMetrics): string[] {
  const found: string[] = [];
  if (head.skips > base.skips) {
    found.push(
      `ganhou ${head.skips - base.skips} .skip/.only/.todo/.fixme/.fail (de ${base.skips} para ${head.skips})`
    );
  }
  if (head.retryCount > base.retryCount || head.retrySum > base.retrySum) {
    found.push(
      `ganhou retry/retries acima de zero (soma de ${base.retrySum} para ${head.retrySum})`
    );
  }
  if (head.quarantine > base.quarantine) {
    found.push(
      `ganhou marca de quarentena (${base.quarantine} para ${head.quarantine})`
    );
  }
  if (head.assertions < base.assertions) {
    found.push(
      `perdeu chamadas expect/assert (de ${base.assertions} para ${head.assertions})`
    );
  }
  if (head.cases < base.cases) {
    found.push(`perdeu casos it/test (de ${base.cases} para ${head.cases})`);
  }
  return found;
}

function closingBrace(glob: string, open: number): number {
  let depth = 0;
  for (let index = open; index < glob.length; index += 1) {
    depth += glob[index] === "{" ? 1 : 0;
    depth -= glob[index] === "}" ? 1 : 0;
    if (depth === 0) {
      return index;
    }
  }
  return -1;
}

function splitTopLevel(inner: string): string[] {
  const parts: string[] = [];
  let level = 0;
  let from = 0;
  for (let at = 0; at < inner.length; at += 1) {
    level += inner[at] === "{" ? 1 : 0;
    level -= inner[at] === "}" ? 1 : 0;
    if (inner[at] === "," && level === 0) {
      parts.push(inner.slice(from, at));
      from = at + 1;
    }
  }
  parts.push(inner.slice(from));
  return parts;
}

function expandBraces(glob: string): string[] {
  const open = glob.indexOf("{");
  const close = open < 0 ? -1 : closingBrace(glob, open);
  if (close < 0) {
    return [glob];
  }
  return splitTopLevel(glob.slice(open + 1, close)).flatMap((part) =>
    expandBraces(glob.slice(0, open) + part + glob.slice(close + 1))
  );
}

const REGEX_SPECIAL = /[.+^$()|[\]\\]/g;

function segmentRegex(glob: string): string {
  let out = "";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index] ?? "";
    if (char === "*" && glob[index + 1] === "*") {
      index += 1;
      if (glob[index + 1] === "/") {
        index += 1;
        out += "(?:.*/)?";
      } else {
        out += ".*";
      }
    } else if (char === "*") {
      out += "[^/]*";
    } else if (char === "?") {
      out += "[^/]";
    } else {
      out += char.replace(REGEX_SPECIAL, "\\$&");
    }
  }
  return out;
}

/** `**` crosses folders (and `**` followed by `/` may match none), `*` and `?` stay in one segment, `{a,b}` chooses. */
export function globToRegExp(glob: string): RegExp {
  const alternatives = expandBraces(glob).map(segmentRegex);
  return new RegExp(`^(?:${alternatives.join("|")})$`);
}

export function parseList(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

interface Git {
  show: (ref: string, path: string) => string | null;
  tree: (ref: string) => string[];
  run: (...args: string[]) => string;
}

function makeGit(cwd: string): Git {
  const run = (...args: string[]) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  return {
    run,
    show(ref, path) {
      try {
        return run("show", `${ref}:${path}`);
      } catch {
        return null;
      }
    },
    tree: (ref) =>
      run("ls-tree", "-r", "--name-only", "-z", ref)
        .split("\0")
        .filter(Boolean),
  };
}

export interface Change {
  status: string;
  path: string;
  from?: string;
}

export function parseNameStatus(raw: string): Change[] {
  const tokens = raw.split("\0").filter((token) => token !== "");
  const changes: Change[] = [];
  for (let index = 0; index < tokens.length; ) {
    const status = tokens[index] ?? "";
    if (status.startsWith("R") || status.startsWith("C")) {
      changes.push({
        from: tokens[index + 1] ?? "",
        path: tokens[index + 2] ?? "",
        status: status.slice(0, 1),
      });
      index += 3;
    } else {
      changes.push({ path: tokens[index + 1] ?? "", status });
      index += 2;
    }
  }
  return changes;
}

const quoted = (value: string): string[] =>
  [...value.matchAll(/"([^"\n]*)"|'([^'\n]*)'|`([^`\n$]*)`/g)].map(
    (match) => match[1] ?? match[2] ?? match[3] ?? ""
  );

const KEYED_LITERALS = (keys: string): RegExp =>
  new RegExp(
    String.raw`(?<![\w$])(?:${keys})\s*:\s*(\[[^\]]*\]|"[^"\n]*"|'[^'\n]*')`,
    "g"
  );
const INCLUDE_KEYED = KEYED_LITERALS("include|testMatch");
const GLOB_LIKE = /\*|\.(?:e2e|test)\.[cm]?[jt]sx?$|\.workerd(?:-db)?\.test\./;
const TEST_DIR = /(?<![\w$])testDir\s*:\s*["']([^"'\n]+)["']/;
const GREP_INVERT = /(?<![\w$])grepInvert\b/g;

export interface ConfigFacts {
  filters: Set<string>;
  testDir: string | undefined;
  grepInvert: number;
  includes: string[];
  retrySum: number;
}

/** Index of the last character of the comment that starts at `index`, or -1 when none does. */
function commentEnd(source: string, index: number): number {
  const pair = source.slice(index, index + 2);
  if (pair === "//") {
    const newline = source.indexOf("\n", index);
    return newline < 0 ? source.length - 1 : newline - 1;
  }
  if (pair === "/*") {
    const close = source.indexOf("*/", index + 2);
    return close < 0 ? source.length - 1 : close + 1;
  }
  return -1;
}

/** Drops line and block comments but keeps what sits inside a quoted string: a glob with a folder wildcard in the middle holds the characters that open and close a block comment. */
export function withoutComments(source: string): string {
  let out = "";
  let quote = "";
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index] ?? "";
    if (quote) {
      out += char;
      if (char === "\\") {
        out += source[index + 1] ?? "";
        index += 1;
      } else if (char === quote) {
        quote = "";
      }
      continue;
    }
    const end = commentEnd(source, index);
    if (end >= 0) {
      index = end;
      continue;
    }
    quote = char === '"' || char === "'" || char === "`" ? char : "";
    out += char;
  }
  return out;
}

export function configFacts(source: string): ConfigFacts {
  const text = withoutComments(source);
  const includes = [...text.matchAll(INCLUDE_KEYED)].flatMap((match) =>
    quoted(match[1] ?? "")
  );
  const keyedLiteral = new Set(includes);
  const filters = new Set(
    quoted(text).filter(
      (literal) => GLOB_LIKE.test(literal) && !keyedLiteral.has(literal)
    )
  );
  return {
    filters,
    grepInvert: count(text, GREP_INVERT),
    includes,
    retrySum: retryFacts(text).sum,
    testDir: TEST_DIR.exec(text)?.[1],
  };
}

const LEADING_DOT_SLASH = /^\.\//;

function inDir(
  configPath: string,
  glob: string,
  testDir?: string | undefined
): RegExp {
  const dir = posix.dirname(configPath);
  const root = dir === "." ? "" : dir;
  const clean = glob.replace(LEADING_DOT_SLASH, "");
  const roots = testDir
    ? [root, posix.join(root, testDir.replace(LEADING_DOT_SLASH, ""))]
    : [root];
  return new RegExp(
    roots.map((from) => globToRegExp(posix.join(from, clean)).source).join("|")
  );
}

function includeMatchers(configPath: string, facts: ConfigFacts): RegExp[] {
  return facts.includes.map((glob) => inDir(configPath, glob, facts.testDir));
}

function governs(configPath: string, matchers: RegExp[], file: string) {
  const dir = posix.dirname(configPath);
  const inside = dir === "." || file === dir || file.startsWith(`${dir}/`);
  return inside && matchers.some((matcher) => matcher.test(file));
}

export interface Report {
  accepted: { sha: string; value: string }[];
  findings: string[];
  warnings: string[];
}

function trailersOf(git: Git, base: string, head: string) {
  const raw = git.run(
    "log",
    `--format=%x1e%H%x1f%(trailers:key=${ACCEPT_TRAILER},valueonly,separator=%x1d)`,
    `${base}..${head}`
  );
  const accepted: Report["accepted"] = [];
  for (const record of raw.split("\x1e").filter((r) => r.trim() !== "")) {
    const [sha = "", values = ""] = record.split("\x1f");
    for (const value of values.split("\x1d").map((v) => v.trim())) {
      if (value.toLowerCase() === ACCEPTED_BY.toLowerCase()) {
        accepted.push({ sha: sha.trim(), value });
      }
    }
  }
  return accepted;
}

function listFindings(
  baseLines: string[] | null,
  headLines: string[] | null,
  headTree: string[],
  historical: boolean
): string[] {
  const found: string[] = [];
  if (headLines === null) {
    return [`${LIST_PATH}: a lista foi apagada`];
  }
  for (const line of baseLines ?? []) {
    if (!headLines.includes(line)) {
      found.push(`${LIST_PATH}: perdeu a linha \`${line}\``);
    }
  }
  for (const glob of historical ? [] : headLines) {
    const matcher = globToRegExp(glob);
    if (!headTree.some((file) => matcher.test(file))) {
      found.push(
        `${LIST_PATH}: o glob \`${glob}\` não casa com nenhum arquivo`
      );
    }
  }
  return found;
}

function protectedIn(tree: string[], lines: string[] | null): Set<string> {
  const matchers = (lines ?? []).map(globToRegExp);
  return new Set(
    tree.filter((file) => matchers.some((matcher) => matcher.test(file)))
  );
}

interface ConfigSide {
  facts: ConfigFacts | null;
  matchers: RegExp[];
}

function sideOf(git: Git, ref: string, configPath: string): ConfigSide {
  const source = git.show(ref, configPath);
  const facts = source === null ? null : configFacts(source);
  return { facts, matchers: facts ? includeMatchers(configPath, facts) : [] };
}

function filterFindings(
  configPath: string,
  base: ConfigSide,
  head: ConfigSide,
  headProtected: Set<string>
): string[] {
  const found: string[] = [];
  for (const filter of head.facts?.filters ?? []) {
    if (base.facts?.filters.has(filter)) {
      continue;
    }
    const matcher = inDir(configPath, filter, head.facts?.testDir);
    for (const file of headProtected) {
      if (matcher.test(file) && governs(configPath, base.matchers, file)) {
        found.push(
          `${file}: ${configPath} ganhou o filtro \`${filter}\` que o alcança`
        );
      }
    }
  }
  return found;
}

function loosenedFindings(
  configPath: string,
  base: ConfigFacts,
  head: ConfigSide & { facts: ConfigFacts },
  headProtected: Set<string>
): string[] {
  const reached = [...headProtected].filter((file) =>
    governs(configPath, head.matchers, file)
  );
  const [first] = reached;
  if (first === undefined) {
    return [];
  }
  const found: string[] = [];
  if (head.facts.retrySum > base.retrySum) {
    found.push(
      `${configPath}: retry/retries sobe de ${base.retrySum} para ${head.facts.retrySum} e alcança ${reached.length} arquivo(s) protegido(s), como ${first}`
    );
  }
  if (head.facts.grepInvert > base.grepInvert) {
    found.push(
      `${configPath}: ganhou grepInvert e alcança ${reached.length} arquivo(s) protegido(s), como ${first}`
    );
  }
  return found;
}

function configFindings(
  git: Git,
  mergeBase: string,
  head: string,
  changedConfigs: string[],
  headProtected: Set<string>
): string[] {
  const found: string[] = [];
  for (const configPath of changedConfigs) {
    const base = sideOf(git, mergeBase, configPath);
    const after = sideOf(git, head, configPath);
    for (const file of headProtected) {
      if (
        governs(configPath, base.matchers, file) &&
        !governs(configPath, after.matchers, file)
      ) {
        found.push(
          `${file}: ${configPath} deixou de incluí-lo (include/testMatch)`
        );
      }
    }
    found.push(...filterFindings(configPath, base, after, headProtected));
    if (base.facts && after.facts) {
      found.push(
        ...loosenedFindings(
          configPath,
          base.facts,
          { facts: after.facts, matchers: after.matchers },
          headProtected
        )
      );
    }
  }
  return found;
}

export interface Options {
  base: string;
  cwd: string;
  head: string;
  /** Backtest only: read the list of this commit for both sides, as if it already existed at the base; a glob with no file does not count, the tree being an old one. */
  listFrom?: string | undefined;
}

const TEST_MARKERS = new Set(["test", "e2e", "spec", "workerd", "workerd-db"]);

/** What makes a file discoverable by a runner: the last extension, with the `.test`/`.e2e`/`.workerd` marker before it. */
export function testKind(path: string): string {
  const parts = posix.basename(path).split(".");
  const marker = parts.at(-2);
  return marker && TEST_MARKERS.has(marker)
    ? `.${marker}.${parts.at(-1)}`
    : `.${parts.at(-1)}`;
}

interface FileContext {
  baseProtected: Set<string>;
  git: Git;
  head: string;
  headProtected: Set<string>;
  headTreeSet: Set<string>;
  mergeBase: string;
  renamed: Map<string, string>;
  touched: Set<string>;
}

function protectedFileFindings(context: FileContext): string[] {
  const { git, head, mergeBase, touched } = context;
  const findings: string[] = [];
  for (const file of [...context.baseProtected].sort()) {
    const target = context.headTreeSet.has(file)
      ? file
      : context.renamed.get(file);
    if (target === undefined) {
      findings.push(`${file}: apagado (ou renomeado com mudança grande)`);
      continue;
    }
    if (!context.headProtected.has(target)) {
      findings.push(
        target === file
          ? `${file}: saiu da lista`
          : `${file}: renomeado para ${target}, que a lista não cobre`
      );
      continue;
    }
    if (!(touched.has(file) || touched.has(target))) {
      continue;
    }
    if (testKind(file) !== testKind(target)) {
      findings.push(
        `${file}: renomeado para ${target}, que muda o tipo (${testKind(file)} para ${testKind(target)}) e o runner deixa de achar`
      );
      continue;
    }
    const before = git.show(mergeBase, file);
    const after = git.show(head, target);
    if (before === null || after === null) {
      findings.push(`${target}: não consegui ler o arquivo no git`);
      continue;
    }
    for (const why of weakenings(metricsOf(before), metricsOf(after))) {
      findings.push(`${target}: ${why}`);
    }
  }
  return findings;
}

export function check(options: Options): Report {
  const git = makeGit(options.cwd);
  const mergeBase = git.run("merge-base", options.base, options.head).trim();
  const baseText = git.show(options.listFrom ?? mergeBase, LIST_PATH);
  const headText = git.show(options.listFrom ?? options.head, LIST_PATH);
  const baseLines = baseText === null ? null : parseList(baseText);
  const headLines = headText === null ? null : parseList(headText);
  const baseTree = git.tree(mergeBase);
  const headTree = git.tree(options.head);
  const headTreeSet = new Set(headTree);
  const changes = parseNameStatus(
    git.run("diff", "-M", "--name-status", "-z", mergeBase, options.head)
  );
  const renamed = new Map(
    changes
      .filter((change) => change.status === "R" && change.from)
      .map((change) => [change.from ?? "", change.path])
  );
  const findings = listFindings(
    baseLines,
    headLines,
    headTree,
    options.listFrom !== undefined
  );
  const baseProtected = protectedIn(baseTree, baseLines);
  const headProtected = protectedIn(headTree, headLines);
  const touched = new Set(
    changes.flatMap((change) => [change.path, change.from ?? ""])
  );

  findings.push(
    ...protectedFileFindings({
      baseProtected,
      git,
      head: options.head,
      headProtected,
      headTreeSet,
      mergeBase,
      renamed,
      touched,
    })
  );

  const changedConfigs = [...touched].filter((file) => CONFIG_FILE.test(file));
  findings.push(
    ...configFindings(
      git,
      mergeBase,
      options.head,
      changedConfigs,
      headProtected
    )
  );

  const warnings = [...touched]
    .filter((file) => WATCHED_FOR_WARNING.test(file))
    .sort()
    .map(
      (file) =>
        `${file} mudou: o Rodrigo lê (filtro de job, shard e a própria checagem não se provam por texto)`
    );
  return {
    accepted: trailersOf(git, options.base, options.head),
    findings,
    warnings,
  };
}

export function render(report: Report): { code: number; text: string } {
  const lines: string[] = [];
  for (const warning of report.warnings) {
    lines.push(`aviso: ${warning}`);
  }
  if (report.findings.length === 0) {
    lines.push("check-protegidos: nenhum teste protegido enfraquecido.");
    return { code: 0, text: lines.join("\n") };
  }
  if (report.accepted.length > 0) {
    lines.push(
      `check-protegidos: ${report.findings.length} mudança(s) em teste protegido LIBERADA(S) por ${ACCEPT_TRAILER}: ${report.accepted.map((a) => `${a.value} (commit ${a.sha.slice(0, 10)})`).join(", ")}`
    );
    for (const finding of report.findings) {
      lines.push(`  liberado: ${finding}`);
    }
    return { code: 0, text: lines.join("\n") };
  }
  lines.push(
    `check-protegidos: ${report.findings.length} problema(s) em teste protegido (${LIST_PATH}):`
  );
  for (const finding of report.findings) {
    lines.push(`  - ${finding}`);
  }
  lines.push(
    `Corrija na causa. Só com o aceite do ${ACCEPTED_BY}: commit no PR com a linha \`${ACCEPT_TRAILER}: ${ACCEPTED_BY}\` no fim da mensagem.`
  );
  return { code: 1, text: lines.join("\n") };
}

function argumentOf(args: string[], name: string, fallback: string): string {
  const at = args.indexOf(name);
  return at >= 0 && args[at + 1] ? (args[at + 1] as string) : fallback;
}

function main(args: string[]): number {
  const result = render(
    check({
      base: argumentOf(args, "--base", "origin/main"),
      cwd: argumentOf(args, "--cwd", process.cwd()),
      head: argumentOf(args, "--head", "HEAD"),
      listFrom: argumentOf(args, "--list-from", "") || undefined,
    })
  );
  console.log(result.text);
  return result.code;
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  process.exit(main(process.argv.slice(2)));
}
