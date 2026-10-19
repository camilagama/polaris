/**
 * What every screen says when the server answers that the session is over (the corte da tela de
 * entrada, AC-17): one sentence, in one place. The button "Entrar de novo" and the warning about
 * what was typed come from the shell (`SessionEndedNotice`); a screen only carries the sentence.
 */
export const SESSION_ENDED_MESSAGE =
  "Sua sessão acabou. Entre de novo para continuar.";

export const SIGN_IN_AGAIN_BUTTON = "Entrar de novo";

/**
 * Going to the sign-in screen leaves the page, so what was typed and not sent can be lost (AC-22).
 * Shown only when there is something typed; nothing here promises that it stays.
 */
export const UNSENT_INPUT_WARNING =
  "O que você digitou e ainda não enviou pode se perder ao entrar de novo.";
