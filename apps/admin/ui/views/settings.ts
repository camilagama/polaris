import type { ScreenContext, ScreenTools } from "../app";
import { facts } from "../blocks";
import type { Dom } from "../dom";

/**
 * What each permission the server lists lets the operator do, in words. The list is the one of
 * `platformCapabilitiesForRole`; a code that is not here is shown as "Permissão {código}", so a new capability is
 * never given a meaning the page did not write.
 */
const PERMISSION_TEXT: Readonly<Record<string, string>> = {
  "access_log:read": "Consultar o registro de acessos",
  "billing:operate":
    "Dar e encerrar concessões, cancelar a renovação e ver a janela de reembolso",
  "billing:refund": "Reembolsar o período em vigor de uma loja",
  "operational_incident:read": "Ver os incidentes operacionais",
  "operational_incident:retry": "Reenviar um evento de um incidente",
  "organization:classify": "Marcar e desmarcar uma loja como interna",
  "organization:diagnose": "Buscar lojas e ver o diagnóstico de cada uma",
  "organization:legal_hold": "Pôr e tirar a retenção legal de uma loja",
  "organization:purge":
    "Agendar e cancelar o apagamento de uma loja e cuidar do aviso de encerramento",
  "organization:suspend": "Suspender e reativar uma loja",
  "pii:reveal": "Revelar um dado pessoal de um cliente",
  "platform:read": "Ver o Início, o funil de ativação e estas Configurações",
  "privacy_case:manage": "Tratar casos de privacidade",
  "support_case:manage": "Abrir, ver e fechar casos de suporte",
  "tenant_access:grant":
    "Dar e encerrar o acesso temporário aos dados de uma loja",
  "tenant_data:read": "Ver a lista de clientes de uma loja com acesso ativo",
};

const ROLE_TEXT: Readonly<Record<string, string>> = {
  platform_owner: "Dono da plataforma",
};

const ENVIRONMENT_BANNER: Readonly<
  Record<ScreenContext["environment"], string>
> = {
  production: "PRODUÇÃO · dados reais",
  staging: "STAGING · dados de teste",
  unknown: "Ambiente não informado",
};

export const PERMISSIONS_NOTE =
  "Estas permissões vêm do cadastro do Admin; não se mudam por aqui.";
export const SIGN_OUT_TEXT = "Para sair, encerre a sessão no Access.";

export function permissionText(code: string): string {
  return PERMISSION_TEXT[code] ?? `Permissão ${code}`;
}

export function roleText(role: string): string {
  return ROLE_TEXT[role] ?? `desconhecido: ${role}`;
}

function area(dom: Dom, id: string, title: string, ...content: Node[]) {
  return dom.el(
    "section",
    { "aria-labelledby": id, class: "area" },
    dom.el("h2", { id }, title),
    ...content
  );
}

/**
 * Configurações (corte admin-v2, Parte 9): who the operator is to the Admin, in which environment this is and how to
 * end the session. Read only: it uses the `whoami` the page already read, makes no request, keeps nothing in the
 * browser and has no field. The operator's label is the one of the top of the page.
 */
export function settingsView(tools: ScreenTools): HTMLElement[] {
  const { context, dom, who } = tools;
  const operator = who.principal.emailSnapshot ?? who.principal.id;
  const permissions = dom.el(
    "ul",
    { class: "permissions" },
    ...who.capabilities.map((code) => dom.el("li", {}, permissionText(code)))
  );
  return [
    area(
      dom,
      "configuracoes-voce",
      "Você",
      facts(dom, [
        ["Operador", operator],
        ["Papel", roleText(who.principal.role)],
      ]),
      dom.el("h3", {}, "Permissões"),
      permissions,
      dom.el("p", { class: "hint" }, PERMISSIONS_NOTE)
    ),
    area(
      dom,
      "configuracoes-ambiente",
      "Ambiente",
      dom.el(
        "p",
        { class: `env env-${context.environment}` },
        ENVIRONMENT_BANNER[context.environment]
      )
    ),
    area(dom, "configuracoes-sessao", "Sessão", dom.el("p", {}, SIGN_OUT_TEXT)),
  ];
}
