import { describe, expect, it } from "vitest";
import { auditEventText } from "./format";

describe("the words of an audit event, one map for the support and the privacy case", () => {
  it.each([
    ["tenant_access.granted", "Acesso temporário liberado"],
    ["tenant_access.revoked", "Acesso temporário encerrado"],
    ["organization.legal_hold_released", "Trava legal liberada"],
    [
      "organization.legal_hold_reviewed",
      "Data de revisão da trava legal mudada",
    ],
    ["organization.purge_cancelled", "Agendamento do apagamento cancelado"],
    ["organization.purge_completed", "Apagamento da loja concluído"],
    ["organization.purge_scheduled", "Apagamento da loja agendado"],
    ["privacy_case.action_recorded", "Ação registrada"],
    ["privacy_case.stage_recorded", "Etapa registrada"],
    ["evento.que.nao.existe", "Outra ação registrada"],
  ])("says %s as “%s”", (eventType, text) => {
    expect(auditEventText(eventType)).toBe(text);
  });
});
