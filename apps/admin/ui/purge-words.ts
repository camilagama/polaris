/**
 * The words of the purge and legal hold tab (corte admin-v2, Parte 7), apart from the screen so the tests of the
 * Worker's side can read them without the browser's types. The effect of the purge is the corte's text (AC-P7.2),
 * split in the three lines of the review and never rewritten.
 */

/** Said where the server did not give the date the purge may start from (D-3 g). */
export const NEXT_PURGE_CYCLE = "a partir do próximo ciclo do apagamento";

/** What is erased, with the start the server gave ("a partir de {data}") or `NEXT_PURGE_CYCLE`. */
export function purgeErasedText(from: string): string {
  return `Os dados operacionais da loja (vendas, produtos e catálogo, estoque, clientes, despesas, metas, formas de pagamento, imagens, dados sincronizados com os aparelhos e cópias exportadas) serão apagados ${from}.`;
}

export const PURGE_KEPT =
  "Ficam, sem texto livre: os registros de cobrança, pseudonimizados (sem os dados do pagador; as referências do provedor continuam e permitem localizá-lo lá), os atendimentos de suporte e de privacidade, e os registros de auditoria e de exclusão. A conta de cada pessoa não é apagada com a loja.";

export const PURGE_UNDO =
  "Você pode cancelar o agendamento enquanto nenhuma execução estiver em curso e nada tiver sido apagado do armazenamento. Depois da primeira exclusão de arquivo, isso não poderá ser desfeito.";

export const PURGE_NOT_NOW =
  "Agendar não apaga agora: o apagamento roda depois, no ciclo do apagamento, e o servidor confere de novo cada condição antes de apagar.";

export const PURGE_RECORD =
  "O agendamento fica na auditoria, com o seu e-mail e o atendimento.";

export const TYPE_THE_NAME = "Digite o nome da loja para continuar.";

export const CASE_REQUIRED =
  "Para agendar o apagamento, é preciso um atendimento de privacidade decidido (aceito) desta loja.";

export const ONLY_CLOSED =
  "O apagamento só existe para loja encerrada: esta loja não está encerrada.";

export const PURGE_DONE =
  "O apagamento já aconteceu. Não há o que cancelar nem agendar.";

export const SERVER_CHECKS =
  "O Admin não devolve a data do encerramento nem a situação da renovação no provedor: o servidor confere os 90 dias do encerramento, a renovação cancelada e a leitura da cobrança ao agendar, e a recusa diz qual falta.";

export const HOLD_STOPS_PURGE =
  "Com trava legal vigente, o apagamento não é agendado nem roda, nem o automático.";

export const HELD_WHILE_SCHEDULED =
  "Há uma trava legal vigente: o apagamento agendado não roda enquanto ela não for liberada.";

export const CANCEL_RULE =
  "Só dá para cancelar enquanto nenhuma execução estiver em curso e nada tiver sido apagado do armazenamento: o servidor confere.";

export const CANCEL_EFFECT = "A loja encerrada não será apagada neste ciclo.";
export const CANCEL_UNDO = "Sim, agendando de novo.";
export const CANCEL_RECORD =
  "O cancelamento fica na auditoria, com o seu e-mail e o atendimento, e o motivo fica guardado com ele.";

export const HOLD_RULE =
  "A data de revisão é obrigatória, no futuro e em até 366 dias; o servidor a confere. Na data, a trava continua valendo e passa a “pendente de revisão”. A trava não tem texto livre: o motivo é o do atendimento.";

export function holdEffectText(day: string): string {
  return `A loja não pode ser apagada enquanto a trava valer. Em ${day}, a trava continua valendo e passa a “pendente de revisão”.`;
}

export const HOLD_UNDO = "Sim, tirando a trava.";
export const HOLD_RECORD =
  "A trava fica na auditoria, com o seu e-mail e o atendimento.";

export const RELEASE_EFFECT =
  "A loja volta a poder ser apagada pelas regras normais, se os demais requisitos do apagamento forem cumpridos.";
export const RELEASE_UNDO = "Sim: pôr a trava de novo, com data de revisão.";
export const RELEASE_RECORD =
  "A liberação fica na auditoria, com o seu e-mail e o atendimento.";

export const REVIEW_DUE = "pendente de revisão";

export const COMMAND_UNKNOWN =
  "Não deu para confirmar se a ação foi feita. Releia o atendimento para ver o estado antes de tentar de novo.";

export const READ_FAILED =
  "Não deu para ler a situação da loja ou as travas legais agora, por isso nenhuma ação aparece. Releia o atendimento.";

export const REFUSED_GENERIC =
  "A ação não foi aceita no estado atual da loja e do atendimento. Nada foi feito.";

/**
 * The refusals the server names for these commands (a 409, the 503 of the billing read, the 400 with a code), in the
 * page's words: the code only picks the sentence and is never shown. `src/ui/privacy-lists.test.ts` checks that every
 * refusal of the purge in the domain has its sentence, and that each one here is the domain's or a route's.
 */
export const PURGE_REFUSALS: Readonly<Record<string, string>> = {
  case_not_open:
    "Este atendimento está fechado: apagamento e trava legal precisam de um atendimento aberto. Nada foi feito.",
  closure_period_not_elapsed:
    "A loja foi encerrada há menos de 90 dias: o apagamento só pode ser agendado depois desse prazo, para o dono poder ler e exportar os dados. Nada foi feito.",
  invalid_review_at:
    "A data de revisão não foi aceita: ela precisa ser no futuro e em até 366 dias. Nada foi feito.",
  legal_hold_active:
    "Há uma trava legal vigente nesta loja: o apagamento não é agendado enquanto ela não for liberada. Nada foi feito.",
  organization_mismatch:
    "Este atendimento é de outra loja: a loja informada não é a deste atendimento. Nada foi feito.",
  organization_not_closed:
    "A loja não está encerrada (está ativa, suspensa ou ainda em encerramento). Nada foi feito.",
  paid_access_running:
    "A loja ainda tem período de teste ou acesso pago em andamento. Nada foi feito.",
  privacy_case_not_accepted:
    "O pedido de exclusão deste atendimento ainda não foi decidido ou não foi aceito por inteiro. Nada foi feito.",
  privacy_case_not_deletion:
    "Este atendimento não é um pedido de exclusão. Nada foi feito.",
  privacy_case_required:
    "Este não é um atendimento de privacidade: o apagamento só é agendado sob o atendimento de privacidade do pedido de exclusão. Nada foi feito.",
  privacy_requester_not_owner:
    "Este pedido de exclusão não foi feito pelo dono da loja. Nada foi feito.",
  privacy_scope_covers_kept_data:
    "O escopo do atendimento inclui dados que o apagamento mantém (conta, entrada, cobrança ou auditoria). Nada foi feito.",
  privacy_scope_incomplete:
    "O escopo do atendimento não cobre tudo o que o apagamento apaga (dados da loja, clientes, vendas, estoque e catálogo, imagens). Nada foi feito.",
  purge_already_done: "O apagamento já aconteceu. Isso não pode ser desfeito.",
  purge_in_progress:
    "O apagamento está em execução agora. Não dá para cancelar enquanto ele roda; espere até 15 minutos e releia o atendimento.",
  purge_not_scheduled:
    "Não há apagamento agendado para esta loja. Nada foi feito.",
  purge_storage_touched:
    "O apagamento já começou a apagar arquivos do armazenamento. Isso não pode ser desfeito, e o agendamento não pode mais ser cancelado.",
  recovery_window_open:
    "A janela de recuperação da loja ainda não acabou. Nada foi feito.",
  renewal_alive:
    "A renovação da assinatura ainda não foi cancelada no provedor: o apagamento espera o cancelamento. Nada foi feito.",
  renewal_status_unavailable:
    "Não deu para ler a cobrança da loja para confirmar que a renovação foi cancelada, por isso o apagamento não foi agendado. Tente de novo mais tarde.",
  tenant_access_active:
    "Há um acesso temporário do Admin vigente nesta loja: encerre-o no atendimento de suporte antes. Nada foi feito.",
};

/** The codes a route adds to the domain's refusals (the billing read before the database, and the 400s with a code). */
export const ROUTE_REFUSALS: readonly string[] = [
  "case_not_open",
  "invalid_review_at",
  "renewal_alive",
  "renewal_status_unavailable",
];

export function purgeRefusalText(code: string): string {
  return Object.hasOwn(PURGE_REFUSALS, code)
    ? (PURGE_REFUSALS[code] ?? REFUSED_GENERIC)
    : REFUSED_GENERIC;
}
