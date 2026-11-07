import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

/**
 * LEIAME.md of the evidence directory (`~/tasks/<id>-telas/`): one line per file, with the state it shows and the
 * commit of the worktree it was taken on. Used by the drives' fixture and by `verify.sh sql`.
 */

export function evidenceDir(): string {
  const dir = process.env.VERIFY_EVIDENCE_DIR;
  if (!dir) {
    throw new Error("VERIFY_EVIDENCE_DIR is missing: run through verify.sh.");
  }
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** The short HEAD of the worktree, and whether apps/ or packages/ have changes not committed. */
export function commitLabel(): string {
  const options = { encoding: "utf8" as const };
  const head = execFileSync(
    "git",
    ["rev-parse", "--short=12", "HEAD"],
    options
  ).trim();
  const dirty = execFileSync(
    "git",
    ["status", "--porcelain", "--", ":/apps", ":/packages"],
    options
  ).trim();
  return dirty ? `${head} + mudanças locais` : head;
}

export interface LeiameRow {
  address: string;
  file: string;
  loja: string;
  project: string;
  sha: string;
  state: string;
}

export function appendLeiame(row: LeiameRow): void {
  const file = join(evidenceDir(), "LEIAME.md");
  if (!existsSync(file)) {
    writeFileSync(
      file,
      [
        `# Capturas e provas de ${process.env.VERIFY_ID}`,
        "",
        "Geradas pela skill verify-polaris (`.claude/skills/verify-polaris/`), contra a pilha local com dados fictícios. Não commitar.",
        "",
        "| Arquivo | Estado | Endereço | Loja | Projeto | Commit |",
        "|---|---|---|---|---|---|",
        "",
      ].join("\n")
    );
  }
  const cells = [
    row.file,
    row.state,
    row.address,
    row.loja,
    row.project,
    row.sha,
  ].map((cell) => cell.replaceAll("|", "\\|").replaceAll("\n", " "));
  // a capture taken again overwrites its file: its old line would describe a file that no longer exists
  const kept = readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => !line.startsWith(`| ${cells[0]} |`))
    .join("\n");
  writeFileSync(file, kept.endsWith("\n") ? kept : `${kept}\n`);
  appendFileSync(file, `| ${cells.join(" | ")} |\n`);
}
