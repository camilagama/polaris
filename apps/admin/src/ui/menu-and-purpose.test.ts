import { PLATFORM_CAPABILITIES } from "@polaris/domain/admin/platform-capabilities";
import { describe, expect, it } from "vitest";
import {
  createAdminPage,
  type PageRequest,
  PURPOSE_MAX_LENGTH,
  SCREENS,
  type ScreenId,
  screenOfPath,
} from "./page";

const assets = { css: "body{}", js: "export{};" };
const STORE = "0199a0a0-0000-7000-8000-00000000beef";
const NAV = /<nav aria-label="Admin">(.*?)<\/nav>/s;
const ACCOUNT = /<details[^>]* data-conta="">(.*?)<\/details>/s;
const ITEM =
  /<div class="[^"]*" data-sidebar="(group)">|<div class="[^"]*" data-sidebar="group-label">([^<]*)<\/div>|<a class="[^"]*"(?: data-active="")?(?: data-sidebar="menu-button")? href="([^"]*)"( aria-current="page")?><svg[^>]*>.*?<\/svg>(?:<span>)?([^<]*)/g;
const H1_AND_PURPOSE =
  /<h1 class="text-title" id="tela-titulo" tabindex="-1">([^<]*)<\/h1>\s*<p id="tela-proposito" class="purpose">([^<]*)<\/p>/;
const BILLING = /cobrança/i;
const TOOLTIP = /title="[^"]*abra um atendimento/;
const HIDDEN_PURPOSE = /aria-hidden="true"[^>]*>\s*Para mexer/;
const BACK = /<p class="back"><a href="([^"]*)">([^<]*)<\/a><\/p>/;

const ALL_SCREENS = Object.keys(SCREENS) as ScreenId[];

async function render(
  screen: ScreenId,
  overrides: Partial<PageRequest> = {}
): Promise<string> {
  const page = await createAdminPage(assets)();
  return page.render({
    capabilities: PLATFORM_CAPABILITIES,
    environment: "staging",
    forbidden: false,
    id: null,
    listState: "abertos",
    screen,
    store: null,
    ...overrides,
  });
}

interface Entry {
  account: boolean;
  current: boolean;
  group: string | null;
  label: string;
  path: string;
}

function entriesOf(text: string, account: boolean): Entry[] {
  const entries: Entry[] = [];
  let group: string | null = null;
  for (const [, start, heading, path, current, label] of [
    ...text.matchAll(ITEM),
  ]) {
    if (start !== undefined) {
      group = null;
    } else if (heading !== undefined) {
      group = heading;
    } else if (path !== undefined) {
      entries.push({
        account,
        current: current !== undefined,
        group,
        label: label ?? "",
        path,
      });
    }
  }
  return entries;
}

/** The side menu, then the menu of the account in the header. */
function menuEntries(html: string): Entry[] {
  return [
    ...entriesOf(NAV.exec(html)?.[1] ?? "", false),
    ...entriesOf(ACCOUNT.exec(html)?.[1] ?? "", true),
  ];
}

describe("the menu by task (AC-IA1)", () => {
  it("has the groups, the labels, the order and the paths of the table", async () => {
    const entries = menuEntries(await render("inicio"));
    expect(
      entries.map((entry) => [entry.group, entry.label, entry.path])
    ).toEqual([
      [null, "Início", "/"],
      ["Atender uma loja", "Lojas", "/lojas"],
      ["Atender uma loja", "Atendimentos", "/casos"],
      ["Privacidade (LGPD)", "Pedidos de dados", "/privacidade"],
      ["Privacidade (LGPD)", "Lojas com trava legal", "/retencoes"],
      ["Operação", "Falhas de envio", "/incidentes"],
      ["Operação", "Funil de ativação", "/funil"],
      ["Para o jurídico", "Registro de acessos", "/registro"],
      [null, "Minha conta e permissões", "/configuracoes"],
    ]);
    expect(entries.map((entry) => entry.account)).toEqual([
      ...new Array(8).fill(false),
      true,
    ]);
  });

  it("has no group named Auditoria and no item of billing", async () => {
    const html = await render("inicio");
    expect(NAV.exec(html)?.[1]).not.toContain("Auditoria");
    expect(NAV.exec(html)?.[1]).not.toMatch(BILLING);
  });

  it("puts Minha conta e permissões alone in the menu of the account, in the header, as the dash does", async () => {
    const html = await render("inicio");
    expect(NAV.exec(html)?.[1]).not.toContain("Minha conta");
    expect(menuEntries(html).filter((entry) => entry.account)).toEqual([
      {
        account: true,
        current: false,
        group: null,
        label: "Minha conta e permissões",
        path: "/configuracoes",
      },
    ]);
  });

  it.each(ALL_SCREENS)(
    "titles %s with the label of its menu item, which is the one marked",
    async (screen) => {
      const html = await render(screen);
      const title = H1_AND_PURPOSE.exec(html)?.[1];
      const current = menuEntries(html).filter((entry) => entry.current);
      expect(current).toHaveLength(1);
      expect(title).toBe(SCREENS[screen].title);
      const detail = ["caso", "caso-novo", "loja", "incidente"].includes(
        screen
      );
      const privacyDetail =
        screen === "privacidade-caso" || screen === "privacidade-novo";
      if (!(detail || privacyDetail)) {
        expect(current[0]?.label).toBe(title);
      }
    }
  );

  it.each([
    ["loja", "/lojas", "‹ Lojas"],
    ["caso", "/casos", "‹ Atendimentos"],
    ["caso-novo", "/casos", "‹ Atendimentos"],
    ["incidente", "/incidentes", "‹ Falhas de envio"],
    ["privacidade-caso", "/privacidade", "‹ Pedidos de dados"],
    ["privacidade-novo", "/privacidade", "‹ Pedidos de dados"],
  ] as const)(
    "takes %s back to the name of its list, ‹ and the label of the parent",
    async (screen, path, label) => {
      const back = BACK.exec(await render(screen, { id: STORE }));
      expect(back?.[1]).toBe(path);
      expect(back?.[2]).toBe(label);
    }
  );

  it.each(
    ALL_SCREENS.filter(
      (screen) =>
        !(
          ["loja", "caso", "caso-novo", "incidente"].includes(screen) ||
          screen.startsWith("privacidade-")
        )
    )
  )("shows no way back on the list %s", async (screen) => {
    expect(BACK.exec(await render(screen))).toBeNull();
  });

  it("drops a group, label included, when no item of it is open to the operator", async () => {
    const entries = menuEntries(
      await render("inicio", { capabilities: ["access_log:read"] })
    );
    expect(entries.map((entry) => entry.group)).toEqual(["Para o jurídico"]);
  });
});

describe("one sentence of purpose under every title (AC-IA2)", () => {
  it.each(ALL_SCREENS)(
    "shows the sentence of %s right after the h1, as visible text of 1 to 90 characters",
    async (screen) => {
      const html = await render(screen);
      const shown = H1_AND_PURPOSE.exec(html)?.[2];
      expect(shown).toBe(SCREENS[screen].purpose);
      expect([...(shown ?? "")].length).toBeGreaterThanOrEqual(1);
      expect([...(shown ?? "")].length).toBeLessThanOrEqual(PURPOSE_MAX_LENGTH);
    }
  );

  it("is a paragraph in the page, not a tooltip", async () => {
    const html = await render("casos");
    expect(html).not.toMatch(TOOLTIP);
    expect(html).not.toMatch(HIDDEN_PURPOSE);
  });

  it("is also shown on the page of an operator without permission", async () => {
    const html = await render("casos", { forbidden: true });
    expect(H1_AND_PURPOSE.exec(html)?.[2]).toBe(SCREENS.casos.purpose);
  });

  it("says, in each sentence of a screen that only reads, that it only reads", () => {
    for (const screen of ["configuracoes", "funil", "retencoes"] as const) {
      expect(SCREENS[screen].purpose).toContain("Só leitura");
    }
    for (const screen of ["lojas", "loja"] as const) {
      expect(SCREENS[screen].purpose).toContain("abra um atendimento");
    }
  });
});

describe("the sentences of the table (the text the user approved)", () => {
  it.each([
    ["inicio", "O que está esperando você hoje."],
    [
      "casos",
      "Para mexer em uma loja, abra um atendimento: ele autoriza e registra.",
    ],
    [
      "privacidade",
      "Pedidos do titular: acesso, correção e exclusão, etapa por etapa, com prazo.",
    ],
    [
      "incidentes",
      "Eventos que não chegaram ao provedor ou ao app; reenvie um por vez.",
    ],
    [
      "funil",
      "Quantas lojas criadas chegaram a vender, por semana. Só leitura.",
    ],
  ] as const)("keeps the sentence of %s", (screen, sentence) => {
    expect(SCREENS[screen].purpose).toBe(sentence);
  });
});

describe("only the words changed: paths and capabilities stay (AC-IA4)", () => {
  const UUID = "0199a0a0-0000-7000-8000-00000000c0de";

  it.each([
    ["/", "inicio", null],
    ["/lojas", "lojas", null],
    [`/lojas/${UUID}`, "loja", UUID],
    ["/casos", "casos", null],
    ["/casos/novo", "caso-novo", null],
    [`/casos/${UUID}`, "caso", UUID],
    ["/privacidade", "privacidade", null],
    ["/privacidade/novo", "privacidade-novo", null],
    [`/privacidade/${UUID}`, "privacidade-caso", UUID],
    ["/retencoes", "retencoes", null],
    ["/incidentes", "incidentes", null],
    [`/incidentes/${UUID}`, "incidente", UUID],
    ["/funil", "funil", null],
    ["/registro", "registro", null],
    ["/configuracoes", "configuracoes", null],
  ] as const)("keeps %s on the screen %s", (path, screen, id) => {
    expect(screenOfPath(path)).toEqual({ id, screen });
  });

  it("answers 404 to the paths the new names might suggest", () => {
    for (const path of [
      "/atendimentos",
      "/atendimentos/novo",
      "/pedidos-de-dados",
      "/falhas-de-envio",
      "/minha-conta",
      "/cobranca",
    ]) {
      expect(screenOfPath(path)).toBeNull();
    }
  });

  it("keeps the capability that opens each screen", () => {
    expect(
      Object.fromEntries(
        Object.entries(SCREENS).map(([screen, { capability }]) => [
          screen,
          capability,
        ])
      )
    ).toEqual({
      caso: "support_case:manage",
      "caso-novo": "support_case:manage",
      casos: "support_case:manage",
      configuracoes: "platform:read",
      funil: "platform:read",
      incidente: "operational_incident:read",
      incidentes: "operational_incident:read",
      inicio: "platform:read",
      loja: "organization:diagnose",
      lojas: "organization:diagnose",
      privacidade: "privacy_case:manage",
      "privacidade-caso": "privacy_case:manage",
      "privacidade-novo": "privacy_case:manage",
      registro: "access_log:read",
      retencoes: "organization:legal_hold",
    });
  });
});
