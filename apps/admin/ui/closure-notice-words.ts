/**
 * The words of the closure notice section (corte admin-v2, Parte 12), apart from the screen so the tests of the
 * Worker's side can read them without the browser's types.
 */

export const REISSUE_EFFECT =
  "Um aviso novo é enviado ao dono atual. O aviso anterior não é alterado.";
export const REISSUE_UNDO =
  "Não: o aviso novo é uma linha nova e o anterior continua como está.";
export const DISMISS_EFFECT =
  "A dispensa conta como entregue para o apagamento, que ainda espera 7 dias. Isso não poderá ser desfeito.";
export const DISMISS_UNDO = "Não.";
export const DISMISS_RULES =
  "Só vale sob um pedido de exclusão aceito por inteiro, feito pelo dono da loja (ou, se a conta do dono foi apagada, por quem pede), e o motivo precisa bater com o que o sistema registrou: o servidor recusa o que não bate.";
export const REISSUE_RECORD =
  "O ato fica na auditoria, com o seu e-mail e o caso.";
export const DISMISS_RECORD =
  "O ato fica na auditoria, com o seu e-mail, o caso e o motivo escolhido.";
export const NOTICE_UNKNOWN =
  "Não deu para confirmar se o ato foi registrado. Releia o caso antes de tentar de novo.";
export const NOTICE_REFUSED_GENERIC =
  "O ato não foi aceito no estado atual da loja e do caso. Nada foi feito.";
export const NOTICE_READ_FAILED =
  "Não deu para ler a situação da loja agora, por isso o aviso de encerramento não aparece. Recarregue o caso.";

/**
 * The refusals the server names for these two acts (a 409), in the page's words: the code only picks the sentence and
 * is never shown, and a code that is not here gets the generic sentence. `src/ui/privacy-lists.test.ts` checks that
 * each of them is a refusal of the domain and that every closure-notice refusal of the domain has its sentence.
 */
export const NOTICE_REFUSALS: Readonly<Record<string, string>> = {
  closure_notice_delivered:
    "O aviso de 7 dias deste encerramento já foi entregue ou dispensado: não há o que reemitir nem dispensar.",
  closure_notice_no_owner:
    "A loja não tem dono ativo para receber o aviso. Se ninguém pode ser avisado, dispense o aviso.",
  closure_notice_not_due:
    "O aviso de 7 dias deste encerramento ainda não venceu: não há o que reemitir nem dispensar.",
  closure_notice_not_refused:
    "O motivo não bate com o que o sistema registrou: o provedor de e-mail não recusou o aviso para o dono atual, ou ainda há um aviso esperando envio.",
  closure_notice_not_unverified:
    "O motivo não bate com o que o sistema registrou: nenhuma tentativa de envio encontrou o e-mail do dono sem verificação.",
  closure_notice_owner_present:
    "O motivo não bate com o que o sistema registrou: a loja ainda tem dono ativo.",
  closure_notice_owner_verified:
    "O motivo não bate com o que o sistema registrou: o dono já verificou o e-mail depois da última tentativa de envio.",
  closure_notice_pending:
    "Há um aviso deste encerramento esperando envio. Espere o envio.",
  organization_mismatch: "A loja deste aviso não é a loja deste caso.",
  organization_not_in_closure: "A loja não está em encerramento.",
  privacy_case_not_accepted:
    "O pedido de exclusão deste caso ainda não foi decidido ou não foi aceito por inteiro.",
  privacy_case_not_deletion: "Este caso não é um pedido de exclusão.",
  privacy_case_required: "Este não é um caso de privacidade aberto.",
  privacy_requester_not_owner:
    "Este pedido de exclusão não foi feito pelo dono da loja.",
};

/** The words of a refusal: the page's sentence for the code the server named, the generic one for any other. */
export function refusalText(code: string): string {
  return Object.hasOwn(NOTICE_REFUSALS, code)
    ? (NOTICE_REFUSALS[code] ?? NOTICE_REFUSED_GENERIC)
    : NOTICE_REFUSED_GENERIC;
}
