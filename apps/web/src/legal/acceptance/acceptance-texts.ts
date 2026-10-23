/**
 * What the acceptance of the Terms of Use and of the Privacy Policy says (corte da tela de entrada,
 * "Aceite pendente"; ADR 0100). In one place, so the screen, the fixed notice and the tests agree.
 */
export const ACCEPTANCE_TITLE = "Termos de Uso e Política de Privacidade";
export const ACCEPTANCE_FIRST_TIME = "Para usar o Polaris, leia e aceite.";
export const ACCEPTANCE_NEW_VERSION =
  "Atualizamos os termos. Leia e aceite para continuar.";
export const ACCEPTANCE_CHECKBOX =
  "Li e aceito os Termos de Uso e a Política de Privacidade.";
export const ACCEPTANCE_CONTINUE = "Continuar";
export const ACCEPTANCE_SAVING = "Registrando o aceite…";
export const ACCEPTANCE_CHECKBOX_MISSING =
  "Marque a caixa para aceitar e continuar.";
export const ACCEPTANCE_LOADING = "Carregando os termos…";
export const ACCEPTANCE_LOAD_FAILED =
  "Não foi possível carregar os termos. Tente de novo.";
export const ACCEPTANCE_SAVE_FAILED =
  "Não foi possível registrar o aceite. Tente de novo.";
export const ACCEPTANCE_VERSION_CHANGED =
  "Os termos mudaram enquanto esta tela estava aberta. Leia a versão nova e aceite de novo.";
export const ACCEPTANCE_OFFLINE =
  "Sem conexão. O aceite precisa de internet para ser registrado.";
export const ACCEPTANCE_DONE =
  "Tudo certo: você já aceitou os termos em vigor.";
export const ACCEPTANCE_GO_ON = "Abrir o Polaris";
export const ACCEPTANCE_OPENING = "Abrindo o Polaris…";
export const ACCEPTANCE_WHAT_CHANGED = "O que mudou";
export const ACCEPTANCE_READ_TERMS = "Ler os Termos de Uso";
export const ACCEPTANCE_READ_PRIVACY = "Ler a Política de Privacidade";
export const NEW_TAB_HINT = "abre em outra aba";

/** The fixed notice of the shell when a call was refused for lack of the acceptance. */
export const ACCEPTANCE_NOTICE =
  "Para continuar usando o Polaris, leia e aceite os Termos de Uso e a Política de Privacidade. O trabalho guardado neste aparelho continua aqui, e o envio volta depois do aceite.";
export const ACCEPTANCE_NOTICE_LINK = "Ler e aceitar";
/** With something typed on the screen the acceptance opens in another tab, so nothing is lost. */
export const ACCEPTANCE_NOTICE_KEEPS_INPUT =
  "abre em outra aba; o que você digitou fica nesta";
/** The app was opened without the acceptance: it goes to `/aceite` by itself. */
export const ACCEPTANCE_OPENING_SCREEN = "Abrindo os termos para aceite…";
