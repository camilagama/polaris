import type {
  CommonFailure,
  EmailProblem,
  NewPasswordProblem,
} from "./password-model";

/**
 * Every line of the password screens (corte da tela de entrada, "Textos para o lojista", and the review of
 * the e-mails: the lock is "pausamos a entrada", the same word as the unlock e-mail). No code, no status,
 * no reason the server gave (AC-76).
 */
export const EMAIL_LABEL = "E-mail";
export const PASSWORD_LABEL = "Senha";
export const NEW_PASSWORD_LABEL = "Nova senha";
export const CURRENT_PASSWORD_LABEL = "Senha atual";
export const SHOW_PASSWORD = "Mostrar";
export const HIDE_PASSWORD = "Ocultar";
export const SHOW_PASSWORD_LABEL = "Mostrar senha";
export const HIDE_PASSWORD_LABEL = "Ocultar senha";

export const OR_SEPARATOR = "ou";
export const SIGN_IN_BUTTON = "Entrar";
export const SIGN_IN_BUTTON_PENDING = "Entrando…";
export const FORGOT_PASSWORD_LINK = "Esqueci a senha";
export const CREATE_ACCOUNT_LINK = "Criar conta";
export const BACK_TO_SIGN_IN = "Voltar para a entrada";
export const GO_TO_SIGN_IN = "Entrar";

export const EMAIL_REQUIRED = "Digite seu e-mail.";
export const EMAIL_INVALID =
  "Digite um e-mail completo, como nome@exemplo.com.";
export const PASSWORD_REQUIRED = "Digite a senha.";
export const INCORRECT_CREDENTIALS = "E-mail ou senha incorretos.";
export const GOOGLE_ACCOUNT_HELP =
  "Conta do Google? Use Continuar com o Google.";

/** The rule, said before typing, on every screen that makes a password (v5.2): the same three rules, shorter. */
export const PASSWORD_RULE =
  "No mínimo 15 caracteres. Vale frase com espaços. Senha que já vazou não serve.";
export const PASSWORD_TOO_SHORT = "Use pelo menos 15 caracteres.";
export const PASSWORD_TOO_LONG = "A senha pode ter no máximo 128 caracteres.";
export const PASSWORD_INVALID_CHARACTERS =
  "A senha tem um caractere que não conseguimos usar. Troque esse caractere.";
export const PASSWORD_COMPROMISED =
  "Essa senha já apareceu em vazamentos. Escolha outra.";
export const PASSWORD_CHECK_UNAVAILABLE =
  "Não conseguimos conferir a senha agora. Tente de novo em instantes.";

export const CHALLENGE_CHECKING = "Confirmando que você é uma pessoa…";
/** Above the widget, when it asks the person for an action (text of the cut). */
export const CHALLENGE_INTERACTIVE = "Confirme que você é uma pessoa.";
export const CHALLENGE_FAILED =
  "Não foi possível confirmar que você é uma pessoa. Tente de novo.";
/** One instruction with the two ways out (v5.2). */
export const CHALLENGE_BLOCKED =
  "Não deu para carregar a confirmação. Recarregue a página ou libere este site no bloqueador de anúncios.";
/** `/redefinir-senha`: a reload would lose the link (the token lives in memory only), so it never says "recarregue". */
export const CHALLENGE_BLOCKED_LINK =
  "Não deu para carregar a confirmação. Libere este site no bloqueador de anúncios e abra o link de novo.";

export const UNAVAILABLE = "Não conseguimos agora. Tente de novo em instantes.";
export const SIGN_IN_UNAVAILABLE =
  "Não conseguimos entrar agora. Tente de novo em instantes.";
export const TOO_MANY_TRIES =
  "Muitas tentativas em pouco tempo. Espere alguns minutos e tente de novo.";
export const TOO_MANY_EMAILS = "Muitos pedidos. Espere alguns minutos.";
export const PAGE_LOADING = "Carregando…";
export const PAGE_UNAVAILABLE =
  "Não conseguimos abrir esta página agora. Tente de novo em instantes.";
export const TRY_AGAIN = "Tentar de novo";
export const TRYING_AGAIN = "Tentando…";

const minutesText = (minutes: number) =>
  minutes === 1 ? "1 minuto" : `${minutes} minutos`;

/**
 * The lock of the e-mail (AC-62, V4), v5.2: the minutes rounded up, and neutral, the same whether the e-mail
 * has an account or not. The button "Entrar" off already shows that it comes back with the end of the pause.
 */
export function pausedText(minutes: number): string {
  return `Muitas tentativas. Espere ${minutesText(minutes)} ou use Esqueci a senha. Se este e-mail tem conta com senha, enviamos um link para liberar agora.`;
}

/** The same lock seen from "Trocar senha": the person is inside, there is no "Esqueci a senha" on this screen. */
export function changePausedText(minutes: number): string {
  return `Muitas tentativas. Espere ${minutesText(minutes)}. Não lembra a senha atual? Saia e use Esqueci a senha.`;
}

export const SIGN_UP_TITLE = "Criar conta";
export const SIGN_UP_PAGE_TITLE = "Criar conta";
export const SIGN_UP_BUTTON = "Criar conta";
export const SIGN_UP_BUTTON_PENDING = "Criando a conta…";
export const ACCEPT_PREFIX = "Li e aceito os";
export const ACCEPT_AND = "e a";
export const ACCEPT_REQUIRED = "Marque o aceite para criar a conta.";
export const HAVE_ACCOUNT = "Já tem conta?";

export const CONFIRM_TITLE = "Confirme seu e-mail";
export const CONFIRM_PAGE_TITLE = "Confirmar e-mail";
/** Neutral on purpose: an e-mail of "you already have an account" has no confirmation link. */
export function confirmSentText(email: string | null): string {
  return `Enviamos um e-mail para ${email ?? "o seu e-mail"}. Siga as instruções nele.`;
}
export const CONFIRM_NOT_ARRIVED = "Não chegou?";
export const RESEND_BUTTON = "Reenviar e-mail";
export const RESEND_BUTTON_PENDING = "Reenviando…";
/** Always the same, whichever address: the server may not have sent it (cap of 72 h, limit) and answers alike with or without an account (AC-49). */
export const RESENT =
  "Se esse e-mail precisar de confirmação, enviamos outro. Veja o spam.";
export const CONFIRM_CHECKING = "Confirmando o e-mail…";
export const CONFIRM_DONE_TITLE = "E-mail confirmado";
export const CONFIRM_DONE = "Agora é só entrar.";
export const CONFIRM_EXPIRED = "Este link venceu. Peça outro.";
export const CONFIRM_INVALID = "Este link não funciona mais. Peça outro.";
export const CONFIRM_NO_LINK =
  "Toque no link que enviamos por e-mail. Venceu? Peça outro aqui.";

export const FORGOT_TITLE = "Esqueci a senha";
export const FORGOT_SUPPORT =
  "Se o e-mail tiver conta, enviamos um link de 1 hora para criar outra senha.";
export const FORGOT_BUTTON = "Enviar link";
export const FORGOT_BUTTON_PENDING = "Enviando…";
export const FORGOT_SENT =
  "Se esse e-mail tiver conta, enviamos um link. Veja o spam.";

export const RESET_TITLE = "Nova senha";
export const RESET_PAGE_TITLE = "Nova senha";
export const RESET_BUTTON = "Trocar senha";
export const RESET_BUTTON_PENDING = "Trocando…";
export const RESET_DONE = "Senha trocada. Entre com a nova senha.";
export const RESET_LINK_INVALID =
  "Este link venceu ou já foi usado. Peça outro.";
export const RESET_NO_LINK =
  "Toque no link que enviamos por e-mail. Venceu? Peça outro.";
export const ASK_NEW_LINK = "Pedir outro link";

export const UNLOCK_TITLE = "Liberar a entrada";
export const UNLOCK_PAGE_TITLE = "Liberar a entrada";
export const UNLOCK_CHECKING = "Liberando a entrada…";
export const UNLOCK_DONE = "Entrada liberada. Você já pode entrar.";
export const UNLOCK_INVALID =
  "Link vencido ou já usado. Espere a pausa acabar ou use Esqueci a senha.";
export const UNLOCK_NO_LINK =
  "Toque no link que enviamos por e-mail ou espere a pausa acabar.";

export const CHANGE_TITLE = "Trocar senha";
export const CHANGE_SUPPORT =
  "Ao trocar, os outros aparelhos saem da sua conta. Este aparelho continua.";
export const CHANGE_BUTTON = "Trocar senha";
export const CHANGE_BUTTON_PENDING = "Trocando…";
export const CHANGE_DONE =
  "Senha trocada. Os outros aparelhos saíram da sua conta.";
export const CURRENT_PASSWORD_WRONG = "A senha atual não confere.";
export const CHANGE_RECENT_REQUIRED =
  "Por segurança, entre de novo para trocar a senha.";
export const CHANGE_NO_PASSWORD = "Conta do Google: não há senha para trocar.";
export const CHANGE_CANCEL = "Cancelar";
export const CHANGE_CANCEL_LABEL = "Cancelar e voltar para Aparelhos";
export const CHANGE_CARD_TITLE = "Nova senha";
export const CHANGE_RECENT_BUTTON = "Entrar de novo";

/** The line of a refusal every form shares; the forms that send an e-mail say "e-mails demais" for the limit. */
export function failureText(
  failure: "blocked" | CommonFailure,
  form: "email" | "other" | "reset" | "sign-in" | "sign-up"
): string {
  switch (failure) {
    case "blocked":
      // `/redefinir-senha` never says reload: the link would be lost
      return form === "reset" ? CHALLENGE_BLOCKED_LINK : CHALLENGE_BLOCKED;
    case "challenge":
      return CHALLENGE_FAILED;
    case "hibp_unavailable":
      return PASSWORD_CHECK_UNAVAILABLE;
    case "limit":
      return form === "email" || form === "sign-up"
        ? TOO_MANY_EMAILS
        : TOO_MANY_TRIES;
    default:
      return form === "sign-in" ? SIGN_IN_UNAVAILABLE : UNAVAILABLE;
  }
}

export function newPasswordText(problem: NewPasswordProblem): string {
  switch (problem) {
    case "compromised":
      return PASSWORD_COMPROMISED;
    case "invalid_characters":
      return PASSWORD_INVALID_CHARACTERS;
    case "too_long":
      return PASSWORD_TOO_LONG;
    default:
      return PASSWORD_TOO_SHORT;
  }
}

export function emailText(problem: EmailProblem | null): string | null {
  if (problem === null) {
    return null;
  }
  return problem === "required" ? EMAIL_REQUIRED : EMAIL_INVALID;
}

export const CONFIRM_PENDING_SIGN_IN =
  "Este e-mail ainda não foi confirmado. Toque no link que enviamos quando a conta foi criada. Se ele venceu ou não chegou, peça outro.";
