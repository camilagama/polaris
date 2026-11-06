import type { Dom } from "./dom";
import { REVEAL_SECONDS } from "./views/reveal";

/** The longest an effect line may be: it is read before the click, so it has to be read in one breath. */
export const MAX_EFFECT_LENGTH = 120;

/**
 * What each action does and whether it can be undone, in one sentence shown above its first button (AC-CL2). Each line
 * carries the sense of the effect and undo texts of that action's review, which stay as written; none rewrites the
 * purge texts, it points to them. The list is the one the test reads.
 */
export const EFFECT_LINES = {
  accessEndOnly:
    "Encerrar acesso agora tira o acesso aos clientes. Dá para dar outro acesso depois, como nova decisão.",
  accessGrant:
    "Você vê os clientes da loja com dados escondidos, só neste atendimento. Dá para encerrar antes do prazo.",
  accessInUse:
    "Ver clientes mostra a lista escondida. Encerrar acesso agora a tira da tela; dá para dar outro acesso depois.",
  accessReadOnly:
    "Ver clientes mostra a lista escondida e cada leitura fica na auditoria. Dá para ler de novo até o prazo.",
  cancelRenewal:
    "A renovação é cancelada no provedor e o acesso já pago segue até o fim do período. Aqui não dá para desfazer.",
  closeCase:
    "Fechar o atendimento revoga todos os acessos temporários dele. Atendimento fechado não reabre. Não dá para desfazer.",
  dismissNotice:
    "A dispensa conta como entregue e o apagamento ainda espera 7 dias. Não dá para desfazer.",
  grantEnd:
    "Encerrar volta a loja ao que o plano dá. Não dá para desfazer; uma nova liberação temporária é outra decisão.",
  grantGive:
    "A liberação temporária só eleva o plano da loja; nunca reduz um limite nem desliga um recurso. Dá para encerrar antes.",
  holdPlace:
    "A loja não é apagada enquanto a trava valer. Dá para tirar a trava depois.",
  holdPlaced:
    "Mudar a data só adia a revisão da trava. Liberar deixa a loja apagável. Dá para pôr a trava de novo.",
  internalMark:
    "A loja sai do funil de ativação. Dá para desmarcar e ela volta ao funil.",
  internalMarkOrUnmark:
    "Marcada, a loja sai do funil de ativação; desmarcada, volta. Dá para trocar quando quiser.",
  internalUnmark:
    "A loja volta ao funil de ativação. Dá para marcar de novo e ela sai do funil.",
  purgeCancel:
    "A loja encerrada não será apagada neste ciclo. Dá para agendar de novo.",
  purgeSchedule:
    "Agendar não apaga agora: roda no próximo ciclo. Dá para cancelar enquanto o apagamento não começar.",
  reactivate:
    "Reativar desfaz só a suspensão. Loja encerrada continua encerrada. Dá para suspender de novo.",
  refund:
    "O estorno vai ao provedor; quando ele confirmar, o Pro da loja acaba na hora, sem carência. Não dá para desfazer.",
  reissueNotice:
    "Um aviso novo vai ao dono atual e o anterior fica como está. Não dá para desfazer: o aviso novo é outra linha.",
  reveal: `Revelar mostra um dado do cliente por até ${REVEAL_SECONDS} segundos e fica na auditoria. Não dá para desfazer o registro.`,
  stepActions:
    "Registra o que foi feito pelas ações da loja, sem alterar dado. Não dá para desfazer nem repetir.",
  stepDecision:
    "A decisão sobre o pedido fica registrada. Não dá para desfazer nem repetir.",
  stepIdentity:
    "A forma de conferir a identidade fica registrada nesta etapa. Não dá para desfazer nem repetir.",
  stepResolve:
    "Resolver fecha o atendimento e revoga os acessos temporários. Não dá para desfazer: ele não reabre.",
  stepRole:
    "O papel do Polaris neste pedido fica registrado. Não dá para desfazer nem repetir.",
  stepScope:
    "As categorias de dado que o pedido alcança ficam registradas. Não dá para desfazer nem repetir.",
  suspend:
    "A loja deixa de abrir para os usuários; os dados ficam. Dá para reativar a loja depois.",
} as const;

export type EffectKey = keyof typeof EFFECT_LINES;

/** The sentence of the effect, in the panel's normal text, above the first button. */
export function effectLine(dom: Dom, key: EffectKey): HTMLElement {
  return dom.el("p", { class: "effect" }, EFFECT_LINES[key]);
}

/** What the action leaves in the audit, in the hint's voice, below the button. */
export function recordLine(dom: Dom, text: string): HTMLElement {
  return dom.el("p", { class: "hint record" }, text);
}

/** The buttons of an action, in the row every panel uses. */
export function buttonRow(
  dom: Dom,
  ...buttons: (HTMLElement | null)[]
): HTMLElement {
  return dom.el("div", { class: "button-row" }, ...buttons);
}
