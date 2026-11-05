import { describe, expect, it } from "vitest";
import { byTag, type FakeElement, visibleText } from "./test-dom";
import { json, mount, OWNER, screenContext } from "./test-page";
import {
  PERMISSIONS_NOTE,
  permissionText,
  roleText,
  SIGN_OUT_TEXT,
} from "./views/settings";

/**
 * Configurações (corte admin-v2, Parte 9: AC-P9.1 to AC-P9.4, AC-C6, AC-C7): the operator, the role and the
 * permissions in words, the environment and how to leave, with no request but the `whoami` and nothing to write.
 */

const HOSTILE = [
  "<img src=x onerror=alert(1)>",
  "<script>alert(1)</script>",
  "javascript:alert(1)",
  "‮abc",
  '"><svg onload=1>',
];
const NEVER_CREATED = ["script", "img", "svg", "iframe", "form", "input"];

const screen = (
  who = json(OWNER),
  environment: "production" | "staging" | "unknown" = "staging"
) =>
  mount(
    [],
    who,
    undefined,
    screenContext({ environment, screen: "configuracoes" })
  );

const lines = (root: FakeElement) =>
  byTag(root, "li").map((item) => item.textContent);

describe("Configurações: Você (AC-P9.1)", () => {
  it("shows the operator as the top of the page does, the role and one permission per line, in words", async () => {
    const { root } = await screen(
      json({
        ...OWNER,
        capabilities: [
          "platform:read",
          "support_case:manage",
          "organization:purge",
        ],
        principal: { ...OWNER.principal, role: "platform_owner" },
      })
    );
    const text = visibleText(root);
    expect(text).toContain("Operador: dona@polaris.example");
    expect(text).toContain("Dono da plataforma");
    expect(lines(root)).toEqual([
      "Ver o Início, o funil de ativação e estas Configurações",
      "Abrir, ver e fechar casos de suporte",
      "Agendar e cancelar o apagamento de uma loja e cuidar do aviso de encerramento",
    ]);
    expect(text).toContain(PERMISSIONS_NOTE);
    expect(PERMISSIONS_NOTE).toBe(
      "Estas permissões vêm do cadastro do Admin; não se mudam por aqui."
    );
  });

  it("names the operator by the ID when the login has no e-mail, as the top of the page does", async () => {
    const { root } = await screen(
      json({
        ...OWNER,
        principal: { ...OWNER.principal, emailSnapshot: null },
      })
    );
    expect(visibleText(root)).toContain(`Operador: ${OWNER.principal.id}`);
    expect(visibleText(root)).toContain(`${OWNER.principal.id}Papel`);
  });

  it('shows a permission without a translation as "Permissão {código}", and a role without one as unknown', async () => {
    const { root } = await screen(
      json({
        ...OWNER,
        capabilities: ["platform:read", "novo:poder"],
        principal: { ...OWNER.principal, role: "auditor" },
      })
    );
    expect(lines(root)).toEqual([
      "Ver o Início, o funil de ativação e estas Configurações",
      "Permissão novo:poder",
    ]);
    expect(visibleText(root)).toContain("desconhecido: auditor");
  });

  it.each(HOSTILE)(
    "writes what the server sent as text, never as markup (AC-C7): %s",
    async (hostile) => {
      const { document, root } = await screen(
        json({
          capabilities: ["platform:read", hostile],
          principal: {
            emailSnapshot: hostile,
            id: OWNER.principal.id,
            role: hostile,
          },
        })
      );
      const text = visibleText(root);
      expect(text).toContain(`Operador: ${hostile}`);
      expect(text).toContain(`desconhecido: ${hostile}`);
      expect(lines(root)).toContain(`Permissão ${hostile}`);
      expect(
        document.created.filter((tag) => NEVER_CREATED.includes(tag))
      ).toEqual([]);
    }
  );
});

describe("the words of Configurações", () => {
  it("name the one role and keep a code with no words as itself", () => {
    expect(roleText("platform_owner")).toBe("Dono da plataforma");
    expect(permissionText("novo:poder")).toBe("Permissão novo:poder");
    expect(permissionText("platform:read")).toBe(
      "Ver o Início, o funil de ativação e estas Configurações"
    );
  });
});

describe("Configurações: Ambiente (AC-P9.2)", () => {
  it.each([
    ["production", "PRODUÇÃO · dados reais", "env env-production"],
    ["staging", "STAGING · dados de teste", "env env-staging"],
    ["unknown", "Ambiente não informado", "env env-unknown"],
  ] as const)(
    "says %s in words, as the banner of the menu does",
    async (environment, banner, kind) => {
      const { root } = await screen(json(OWNER), environment);
      const shown = byTag(root, "p").filter(
        (element) => element.getAttribute("class") === kind
      );
      expect(shown.map((element) => element.textContent)).toEqual([banner]);
    }
  );

  it("does not name an environment the Worker did not name", async () => {
    const { root } = await screen(json(OWNER), "unknown");
    const text = visibleText(root);
    expect(text).not.toContain("PRODUÇÃO");
    expect(text).not.toContain("STAGING");
  });
});

describe("Configurações sem platform:read (AC-C1)", () => {
  it("says there is no permission and shows none of the three areas", async () => {
    const { calls, root } = await screen(
      json({ ...OWNER, capabilities: ["support_case:manage"] })
    );
    expect(visibleText(root)).toContain("Sem permissão para isto.");
    expect(visibleText(root)).not.toContain(SIGN_OUT_TEXT);
    expect(
      byTag(root, "section").map((section) =>
        section.getAttribute("aria-labelledby")
      )
    ).toEqual(["configuracoes-titulo"]);
    expect(calls.map((call) => call.path)).toEqual(["/api/whoami"]);
  });
});

describe("Configurações: Sessão (AC-P9.3) and nothing to write (AC-P9.1, AC-P9.4)", () => {
  it("says how to leave and offers no way to do it", async () => {
    const { root } = await screen();
    expect(visibleText(root)).toContain(SIGN_OUT_TEXT);
    expect(SIGN_OUT_TEXT).toBe("Para sair, encerre a sessão no Access.");
    expect(byTag(root, "a")).toEqual([]);
    expect(byTag(root, "button")).toEqual([]);
  });

  it("has no field, form or control, and asks nothing but the whoami", async () => {
    const { calls, document, navigations, root } = await screen();
    expect(calls.map((call) => call.path)).toEqual(["/api/whoami"]);
    expect(calls[0]?.init.method).toBe("GET");
    for (const tag of ["form", "input", "select", "button", "a"]) {
      expect(byTag(root, tag)).toEqual([]);
      expect(document.created).not.toContain(tag);
    }
    expect(navigations).toEqual([]);
  });

  it("has the three areas, each named by its heading", async () => {
    const { root } = await screen();
    expect(
      byTag(root, "section").map((section) =>
        section.getAttribute("aria-labelledby")
      )
    ).toEqual([
      "configuracoes-voce",
      "configuracoes-ambiente",
      "configuracoes-sessao",
    ]);
    expect(byTag(root, "h2").map((heading) => heading.textContent)).toEqual([
      "Você",
      "Ambiente",
      "Sessão",
    ]);
  });
});
