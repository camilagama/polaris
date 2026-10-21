import type { SignInError, SignInReason } from "../lib/sign-in-path";

/**
 * Every line the sign-in screen says (corte da tela de entrada, "Textos para o lojista"). No code, no
 * status, no reason the server gave: the same words for every cause of the same state.
 */
export const SIGN_IN_TITLE = "Entrar no Polaris";
export const SIGN_IN_PAGE_TITLE = "Entrar";
/** The one line of help on `/entrar` (v5.2), under the Google button: what a first-timer needs before choosing. */
export const SIGN_IN_FIRST_TIME = "Primeira vez? O botão também cria a conta.";

export const GOOGLE_BUTTON = "Continuar com o Google";
export const GOOGLE_BUTTON_PENDING = "Abrindo o Google…";
export const GOOGLE_RETRY = "Tentar de novo";
export const SIGN_IN_ENTERING = "Entrando…";
export const SIGN_IN_CHECKING = "Verificando se você já entrou…";

export const GOOGLE_ERROR =
  "Não foi possível entrar com o Google. Tente de novo.";
export const GOOGLE_ERROR_HELP =
  "Se você cancelou no Google, toque em Continuar com o Google para tentar outra vez.";
export const SIGN_IN_LIMIT =
  "Muitas tentativas em pouco tempo. Espere alguns minutos e tente de novo.";
export const SIGN_IN_UNAVAILABLE =
  "Não conseguimos entrar agora. Tente de novo em instantes.";
export const GOOGLE_NOT_OFFERED =
  "A entrada com o Google não está disponível agora. Tente de novo em instantes.";

export const SIGN_IN_OFFLINE = "Sem conexão. Conecte-se para entrar.";
export const SIGN_IN_BACK_ONLINE = "Conexão de volta. Você já pode entrar.";

export const SESSION_ENDED_REASON = "Sua sessão acabou. Entre de novo.";
export const RECENT_LOGIN_REASON =
  "Por segurança, entre de novo para confirmar que é você.";

export const PRIVACY_LINK = "Política de Privacidade";
export const TERMS_LINK = "Termos de Uso";
export const NEW_TAB_HINT = "abre em outra aba";

/** The line above the button for the reason the person was sent here, if any. */
export function reasonText(reason: SignInReason | undefined): string | null {
  if (reason === "sessao") {
    return SESSION_ENDED_REASON;
  }
  if (reason === "recente") {
    return RECENT_LOGIN_REASON;
  }
  return null;
}

/** The alert for what came back in `?erro=`; one text for every Google failure, whatever the cause. */
export function errorText(error: SignInError | undefined): string | null {
  if (error === "google") {
    return GOOGLE_ERROR;
  }
  if (error === "limite") {
    return SIGN_IN_LIMIT;
  }
  if (error === "indisponivel") {
    return SIGN_IN_UNAVAILABLE;
  }
  return null;
}
