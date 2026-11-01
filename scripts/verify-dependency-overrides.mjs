import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { walkFiles } from "./exact-count-list.mjs";

/**
 * An `overrides` entry is a temporary exception: it pins a version that a dependency does not ask
 * for, and it is right only until that dependency catches up. Without a written reason and a removal
 * condition nobody knows when it can go, and it stays after the cause is gone. Every override of the
 * root `package.json` must have its row in the "Overrides vigentes" table of the dependency audit
 * runbook (same package, same version, same parent), with a non-empty reason and "Remover quando";
 * a row whose override is gone fails too. Bun reads `overrides` and `resolutions` only from the root
 * `package.json`, so either key in a workspace `package.json` fails: it would look like a fix and do
 * nothing.
 */
const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

export const RUNBOOK = "docs/runbooks/dependency-audit.md";
const SECTION = "## Overrides vigentes";
const nextSection = /\n## /;
const tableRow = /^\|(.+)\|\s*$/;
const separatorRow = /^\|[\s:|-]+\|\s*$/;
const overrideCell = /`([^`:]+):\s*([^`]+)`/;
const parentCell = /só sob `([^`]+)`/;

const keyOf = (name, version, parent) =>
  parent ? `${name}@${version} só sob ${parent}` : `${name}@${version}`;

/** The overrides of a root `package.json`, as keys `name@version` or `name@version só sob parent`. */
export function overrideKeys(packageJson) {
  const keys = [];
  for (const [name, value] of Object.entries(packageJson.overrides ?? {})) {
    if (typeof value === "string") {
      keys.push(keyOf(name, value));
    } else {
      for (const [child, version] of Object.entries(value)) {
        keys.push(
          typeof version === "string"
            ? keyOf(child, version, name)
            : `${child} em mais de um nível sob ${name}`
        );
      }
    }
  }
  for (const [name, version] of Object.entries(packageJson.resolutions ?? {})) {
    keys.push(keyOf(name, String(version)));
  }
  return keys.sort();
}

/** The rows of the "Overrides vigentes" table, keyed like `overrideKeys`. */
export function documentedOverrides(markdown) {
  const start = markdown.indexOf(SECTION);
  if (start < 0) {
    return {
      problems: [`${RUNBOOK}: falta a seção "${SECTION}".`],
      rows: new Map(),
    };
  }
  const body = markdown.slice(start + SECTION.length);
  const end = body.search(nextSection);
  const lines = (end < 0 ? body : body.slice(0, end)).split("\n");
  const rows = new Map();
  const problems = [];
  let header = null;
  for (const line of lines) {
    if (!tableRow.test(line) || separatorRow.test(line)) {
      continue;
    }
    const cells = line
      .trim()
      .slice(1, -1)
      .split("|")
      .map((cell) => cell.trim());
    if (!header) {
      header = cells;
      continue;
    }
    const match = overrideCell.exec(cells[0]);
    if (!match) {
      problems.push(
        `${RUNBOOK}: a linha "${cells[0]}" não diz o override como \`pacote: versão\`.`
      );
      continue;
    }
    const key = keyOf(
      match[1].trim(),
      match[2].trim(),
      parentCell.exec(cells[0])?.[1]
    );
    const row = Object.fromEntries(
      header.map((title, index) => [title, cells[index] ?? ""])
    );
    for (const required of ["Desde", "Motivo", "Remover quando"]) {
      if (!row[required]) {
        problems.push(
          `${RUNBOOK}: o override ${key} está sem "${required}". Preencha a coluna (o "Remover quando" diz o que conferir, por exemplo \`bun pm why <pacote>\`).`
        );
      }
    }
    rows.set(key, row);
  }
  return { problems, rows };
}

export function overrideProblems({ rootPackage, runbook, workspacePackages }) {
  const { rows, problems } = documentedOverrides(runbook);
  const keys = overrideKeys(rootPackage);
  for (const key of keys) {
    if (!rows.has(key)) {
      problems.push(
        `package.json: o override ${key} não está na tabela "Overrides vigentes" de ${RUNBOOK}. ` +
          "Acrescente a linha no mesmo PR, com Desde, Motivo (o aviso ou a incompatibilidade) e Remover quando " +
          "(a condição que `bun pm why <pacote>` confere); se a versão mudou, atualize a linha que já existe."
      );
    }
  }
  for (const key of rows.keys()) {
    if (!keys.includes(key)) {
      problems.push(
        `${RUNBOOK}: a linha do override ${key} não tem override igual no package.json raiz. ` +
          "Se o override saiu, tire a linha no mesmo PR (a tabela é só do que está ativo); se a versão mudou, atualize-a."
      );
    }
  }
  for (const [file, packageJson] of Object.entries(workspacePackages)) {
    for (const field of ["overrides", "resolutions"]) {
      if (packageJson[field]) {
        problems.push(
          `${file}: "${field}" fora do package.json raiz não tem efeito no Bun. Mova o override para o package.json raiz e registre-o em ${RUNBOOK}.`
        );
      }
    }
  }
  return problems;
}

const isWorkspacePackage = (relative) =>
  relative.endsWith("/package.json") &&
  (relative.startsWith("apps/") || relative.startsWith("packages/"));

export function checkRepository(base = root) {
  const read = (relative) => readFileSync(path.join(base, relative), "utf8");
  const parse = (relative) => {
    try {
      return JSON.parse(read(relative));
    } catch (error) {
      throw new Error(`${relative}: JSON inválido (${error.message})`, {
        cause: error,
      });
    }
  };
  return overrideProblems({
    rootPackage: parse("package.json"),
    runbook: read(RUNBOOK),
    workspacePackages: Object.fromEntries(
      walkFiles(base, isWorkspacePackage).map((file) => [file, parse(file)])
    ),
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const problems = checkRepository(process.argv[2] ?? root);
  for (const problem of problems) {
    console.error(problem);
  }
  if (problems.length > 0) {
    console.error(`\n${problems.length} problema(s) nos overrides.`);
    process.exit(1);
  }
  console.log(
    `Todo override do package.json raiz está registrado em ${RUNBOOK}.`
  );
}
