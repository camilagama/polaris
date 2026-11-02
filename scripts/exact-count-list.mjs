import { spawnSync } from "node:child_process";
import { lstatSync } from "node:fs";
import path from "node:path";
import { IGNORED_FOLDERS } from "./verify-no-history-comments.mjs";

/**
 * A pattern that is already common in the repository cannot be forbidden in one change without
 * rewriting old code. The checks that use this keep an exact list instead: each file with how many
 * uses it has and why. A file not in the list fails, a file with more uses than the list fails, and
 * a file with fewer fails too, so the list is lowered in the change that removed a use and never
 * keeps room for a new one.
 *
 * `found` maps a key (a file path, or a file and a target) to the count in the tree; `allowed` maps
 * a key to `{ count, reason }`. `advice` is appended to each problem about a new use, and says what
 * to write instead. `listFile` names where the list lives.
 */
export function exactCountProblems({ found, allowed, what, advice, listFile }) {
  const problems = [];
  for (const [key, count] of Object.entries(found).sort()) {
    if (count === 0) {
      continue;
    }
    const entry = allowed[key];
    if (!entry) {
      problems.push(`${key}: ${count} ${what}. ${advice}`);
    } else if (count > entry.count) {
      problems.push(
        `${key}: ${count} ${what}, a lista de ${listFile} aceita ${entry.count}. ${advice}`
      );
    } else if (count < entry.count) {
      problems.push(
        `${key}: ${count} ${what} e a lista de ${listFile} diz ${entry.count}. Baixe a entrada para ${count} (ou tire-a, se for 0) no mesmo PR.`
      );
    }
  }
  for (const [key, entry] of Object.entries(allowed)) {
    if (!found[key]) {
      problems.push(
        `${key}: na lista de ${listFile} e sem nenhum uso. Tire a entrada no mesmo PR.`
      );
    }
    if (typeof entry.reason !== "string" || entry.reason.trim() === "") {
      problems.push(`${key}: a entrada de ${listFile} precisa de um motivo.`);
    }
  }
  return problems;
}

/**
 * Every file git knows under `base` (tracked or added to the index) whose relative path passes
 * `keep`, skipping dependencies and build output. Reading the disk instead would count a file that
 * exists only on this machine, so the check would fail here and pass in CI.
 */
export function walkFiles(base, keep) {
  const listed = spawnSync("git", ["ls-files", "-z", "--cached"], {
    cwd: base,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (listed.error || listed.status !== 0) {
    const reason = listed.error?.message ?? listed.stderr.trim();
    throw new Error(
      `Não consegui listar os arquivos versionados em ${base} com "git ls-files": ${reason}. Rode a verificação dentro do clone do repositório, com o git instalado.`
    );
  }
  return listed.stdout
    .split("\0")
    .filter((relative) => relative !== "")
    .filter(
      (relative) =>
        !relative
          .split("/")
          .slice(0, -1)
          .some((folder) => IGNORED_FOLDERS.has(folder))
    )
    .filter((relative) => keep(relative) && isRegularFile(base, relative))
    .sort();
}

function isRegularFile(base, relative) {
  try {
    return lstatSync(path.join(base, relative)).isFile();
  } catch {
    return false;
  }
}
