import { normalizeSha, UNKNOWN_SHA } from "./report";

export type GitRunner = (args: string[]) => string;

export interface AppCommit {
  dirty: boolean;
  sha: string;
}

export const UNKNOWN_APP_COMMIT: Readonly<AppCommit> = Object.freeze({
  dirty: false,
  sha: UNKNOWN_SHA,
});

/**
 * O commit da árvore de que a build sai, e se ela tinha alterações não commitadas (o SHA então não a identifica
 * inteira). A build não carrega o SHA de forma legível: só `VITE_RELEASE`, encurtado, e só com os erros de cliente ligados.
 *
 * Limite: é o SHA do HEAD local no momento da build, não o de um deploy; a prova de aparelho real não diz qual
 * versão publicada foi testada. Se o `git` falhar (ausente, fora de repositório), o resultado é `desconhecido` com
 * `dirty: false` em vez de derrubar o gate: o relatório mostra o SHA desconhecido.
 */
export function appCommit(git: GitRunner): Readonly<AppCommit> {
  try {
    return {
      dirty: git(["status", "--porcelain"]).trim() !== "",
      sha: normalizeSha(git(["rev-parse", "HEAD"])),
    };
  } catch {
    return UNKNOWN_APP_COMMIT;
  }
}
