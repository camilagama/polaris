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

export const SIGN_IN_SUPPORT_BOTH =
  "Entre com sua conta do Google ou com e-mail e senha.";
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
  "Se você criou a conta com o Google, use Continuar com o Google.";

export const PASSWORD_RULE =
  "Use pelo menos 15 caracteres. Pode ter espaços e qualquer letra ou símbolo. Não pode ser uma senha que já vazou na internet.";
export const PASSWORD_TOO_SHORT =
  "A senha precisa ter pelo menos 15 caracteres.";
export const PASSWORD_TOO_LONG = "A senha pode ter no máximo 128 caracteres.";
export const PASSWORD_INVALID_CHARACTERS =
  "A senha tem um caractere que não conseguimos usar. Troque esse caractere.";
export const PASSWORD_COMPROMISED =
  "Essa senha já apareceu em vazamentos. Escolha outra.";
export const PASSWORD_CHECK_UNAVAILABLE =
  "Não conseguimos conferir a senha agora. Tente de novo em instantes.";

export const CHALLENGE_CHECKING = "Confirmando que você é uma pessoa…";
export const CHALLENGE_FAILED =
  "Não foi possível confirmar que você é uma pessoa. Tente de novo.";
export const CHALLENGE_BLOCKED =
  "Não conseguimos carregar a confirmação de que você é uma pessoa. Recarregue a página. Se usa um bloqueador de anúncios, libere este site.";
/** `/redefinir-senha`: a reload would lose the link (the token lives in memory only), so it never says "recarregue". */
export const CHALLENGE_BLOCKED_LINK =
  "Não conseguimos carregar a confirmação de que você é uma pessoa. Libere este site no bloqueador de anúncios e abra de novo o link do e-mail.";

export const UNAVAILABLE =
  "Não conseguimos fazer isso agora. Tente de novo em instantes.";
export const SIGN_IN_UNAVAILABLE =
  "Não conseguimos entrar agora. Tente de novo em instantes.";
export const TOO_MANY_TRIES =
  "Muitas tentativas em pouco tempo. Espere alguns minutos e tente de novo.";
export const TOO_MANY_EMAILS =
  "Você pediu e-mails demais. Espere alguns minutos.";
export const PAGE_LOADING = "Carregando…";
export const PAGE_UNAVAILABLE =
  "Não conseguimos abrir esta página agora. Tente de novo em instantes.";
export const TRY_AGAIN = "Tentar de novo";
export const TRYING_AGAIN = "Tentando…";

const minutesText = (minutes: number) =>
  minutes === 1 ? "1 minuto" : `${minutes} minutos`;

/** The lock of the e-mail (AC-62, V4): the word of the unlock e-mail, the minutes rounded up. */
export function pausedText(minutes: number): string {
  return `Pausamos a entrada com senha deste e-mail por muitas tentativas. Espere ${minutesText(minutes)} ou toque em Esqueci a senha. Se a conta tem um e-mail, enviamos a ele um link para liberar agora.`;
}

/** The same lock seen from "Trocar senha": the person is inside, there is no "Esqueci a senha" on this screen. */
export function changePausedText(minutes: number): string {
  return `Muitas tentativas com a senha atual. Espere ${minutesText(minutes)} e tente de novo. Se não lembra a senha atual, saia e use Esqueci a senha na tela de entrada.`;
}
export const PAUSED_BUTTON_HINT = "O botão Entrar volta quando a pausa acabar.";

export const SIGN_UP_TITLE = "Criar conta";
export const SIGN_UP_PAGE_TITLE = "Criar conta";
export const SIGN_UP_SUPPORT =
  "Crie sua conta com e-mail e senha. Você confirma o e-mail antes de entrar.";
export const SIGN_UP_BUTTON = "Criar conta";
export const SIGN_UP_BUTTON_PENDING = "Criando a conta…";
export const ACCEPT_PREFIX = "Li e aceito os";
export const ACCEPT_AND = "e a";
export const ACCEPT_REQUIRED =
  "Para criar a conta, marque que leu e aceita os Termos de Uso e a Política de Privacidade.";
export const HAVE_ACCOUNT = "Já tem conta?";

export const CONFIRM_TITLE = "Confirme seu e-mail";
export const CONFIRM_PAGE_TITLE = "Confirmar e-mail";
/** Neutral on purpose: an e-mail of "you already have an account" has no confirmation link. */
export function confirmSentText(email: string | null): string {
  return `Enviamos um e-mail para ${email ?? "o seu e-mail"}. Abra e siga as instruções. Vale 24 horas.`;
}
export const CONFIRM_NOT_ARRIVED = "Não chegou?";
export const RESEND_BUTTON = "Reenviar e-mail";
export const RESEND_BUTTON_PENDING = "Reenviando…";
/** The address came from the sign-up form kept in memory: the server really sent it. */
export const RESENT = "Reenviamos. Olhe também o spam.";
/** The address was typed here: the server answers the same whether or not it has an account (AC-49). */
export const RESENT_TYPED =
  "Se esse e-mail precisar de confirmação, enviamos outro. Olhe também o spam.";
export const RESEND_ASK_EMAIL = "Digite seu e-mail para receber outro link.";
export const CONFIRM_GOOGLE_WAY =
  "Também pode entrar com o Google, se o e-mail for de uma conta do Google.";
export const CONFIRM_CHECKING = "Confirmando o e-mail…";
export const CONFIRM_DONE_TITLE = "E-mail confirmado";
export const CONFIRM_DONE = "E-mail confirmado. Agora é só entrar.";
export const CONFIRM_EXPIRED = "Este link venceu. Peça outro.";
export const CONFIRM_INVALID = "Este link não funciona mais. Peça outro.";
export const CONFIRM_NO_LINK =
  "Para confirmar o e-mail, toque no link que enviamos. Se ele venceu, peça outro aqui.";

export const FORGOT_TITLE = "Esqueci a senha";
export const FORGOT_SUPPORT =
  "Digite seu e-mail. Se ele tiver conta, enviamos um link para criar uma nova senha. O link vale 1 hora.";
export const FORGOT_BUTTON = "Enviar o link";
export const FORGOT_BUTTON_PENDING = "Enviando…";
export const FORGOT_SENT =
  "Se esse e-mail tiver conta, enviamos um link. Olhe também o spam.";

export const RESET_TITLE = "Nova senha";
export const RESET_PAGE_TITLE = "Nova senha";
export const RESET_SUPPORT = "Escolha uma nova senha.";
export const RESET_BUTTON = "Trocar a senha";
export const RESET_BUTTON_PENDING = "Trocando…";
export const RESET_DONE = "Senha trocada. Entre com a nova senha.";
export const RESET_LINK_INVALID =
  "Este link venceu ou já foi usado. Peça outro.";
export const RESET_NO_LINK =
  "Para criar uma nova senha, toque no link que enviamos por e-mail. Se ele venceu, peça outro.";
export const ASK_NEW_LINK = "Pedir outro link";

export const UNLOCK_TITLE = "Liberar a entrada";
export const UNLOCK_PAGE_TITLE = "Liberar a entrada";
export const UNLOCK_CHECKING = "Liberando a entrada…";
export const UNLOCK_DONE =
  "Pronto: a entrada com senha está liberada. Você já pode entrar.";
export const UNLOCK_INVALID =
  "Este link venceu ou já foi usado. Espere a pausa acabar ou toque em Esqueci a senha.";
export const UNLOCK_NO_LINK =
  "Para liberar a entrada, toque no link do e-mail que enviamos. Ou espere a pausa acabar.";

export const CHANGE_TITLE = "Trocar senha";
export const CHANGE_SUPPORT =
  "Ao trocar a senha, os outros aparelhos saem da sua conta e vão pedir a senha de novo. Este aparelho continua.";
export const CHANGE_BUTTON = "Trocar senha";
export const CHANGE_BUTTON_PENDING = "Trocando…";
export const CHANGE_DONE =
  "Senha trocada. Os outros aparelhos saíram da sua conta.";
export const CURRENT_PASSWORD_WRONG = "A senha atual não confere.";
export const CHANGE_RECENT_REQUIRED =
  "Por segurança, entre de novo para trocar a senha.";
export const CHANGE_NO_PASSWORD =
  "Sua conta entra com o Google e não tem senha para trocar.";
export const CHANGE_RECENT_BUTTON = "Entrar de novo";

/** The line of a refusal every form shares; the e-mail forms say "e-mails demais" for the limit. */
export function failureText(
  failure: "blocked" | CommonFailure,
  form: "email" | "other" | "reset" | "sign-in"
): string {
  switch (failure) {
    case "blocked":
      return form === "reset" ? CHALLENGE_BLOCKED_LINK : CHALLENGE_BLOCKED;
    case "challenge":
      return CHALLENGE_FAILED;
    case "hibp_unavailable":
      return PASSWORD_CHECK_UNAVAILABLE;
    case "limit":
      return form === "email" ? TOO_MANY_EMAILS : TOO_MANY_TRIES;
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
