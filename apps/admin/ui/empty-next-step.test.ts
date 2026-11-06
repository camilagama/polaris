import { describe, expect, it } from "vitest";
import { allElements, byTag, type FakeElement, visibleText } from "./test-dom";
import { diagnostics, json, mount, OWNER, screenContext } from "./test-page";
import type { PrivacyCaseDetail, SupportCaseDetail } from "./types";

/**
 * The next step of each empty state of the Admin, in a small DOM (AC-CL1): the sentence that says what is missing and,
 * in the same sentence or the line after it, what to do or where to go, with a link when the destination is in the
 * menu. The list of the texts is in `src/ui/empty-states-list.test.ts`.
 */

const CASE = "0199a0a0-0000-7000-8000-00000000c0de";
const STORE = "0199a0a0-0000-7000-8000-0000000000a1";
const OPENED_AT = "2026-10-28T13:05:00.000Z";
const NOW = new Date("2026-11-05T15:00:00.000Z");

const WHO = (...capabilities: string[]) => json({ ...OWNER, capabilities });
const OWNERS_WITH_STORES = () =>
  WHO("platform:read", "organization:diagnose", "support_case:manage");

const isShown = (element: FakeElement): boolean => {
  for (
    let current: FakeElement | null = element;
    current !== null;
    current = current.parent
  ) {
    if (current.hasAttribute("hidden")) {
      return false;
    }
  }
  return true;
};

const linksShown = (root: FakeElement) =>
  byTag(root, "a")
    .filter(isShown)
    .map((link) => link.getAttribute("href"));

const linkTo = (root: FakeElement, href: string) =>
  byTag(root, "a")
    .filter(isShown)
    .find((link) => link.getAttribute("href") === href);

const blockOf = (root: FakeElement, sentence: string) =>
  allElements(root)
    .filter(isShown)
    .filter((element) => element.tagName === "p")
    .find((element) => element.textContent.includes(sentence));

const emptyBlock = (root: FakeElement, sentence: string): string =>
  blockOf(root, sentence)?.textContent ?? "";

const linkIn = (root: FakeElement, sentence: string, href: string) =>
  byTag(blockOf(root, sentence) ?? root, "a").find(
    (link) => link.getAttribute("href") === href
  );

describe("Início", () => {
  const home = (who: ReturnType<typeof WHO>, answers: Response[] = []) =>
    mount(answers, who, undefined, screenContext({ screen: "inicio" }));

  it("sends the operator who can read stores to Lojas", async () => {
    const { root } = await home(
      WHO("platform:read", "organization:diagnose", "support_case:manage"),
      [json({ cases: [], next: null })]
    );
    const text = visibleText(root);

    expect(text).toContain(
      "Nada esperando por você. Para atender uma loja, comece por Lojas."
    );
    expect(linkTo(root, "/lojas")?.textContent).toBe("Lojas");
  });

  it("sends the one who cannot to the page with what they can do", async () => {
    const { root } = await home(WHO("platform:read"));

    expect(visibleText(root)).toContain(
      "Nada esperando por você. Para ver o que você pode fazer, abra Minha conta e permissões."
    );
    expect(linkTo(root, "/configuracoes")?.textContent).toBe(
      "Minha conta e permissões"
    );
  });
});

describe("Lojas", () => {
  it("tells to try fewer letters, or to leave the field empty, after a search with no store", async () => {
    const mounted = await mount(
      [json({ next: null, organizations: [] })],
      undefined,
      undefined,
      screenContext({ screen: "lojas" })
    );
    await mounted.search("zzz");
    const text = visibleText(mounted.root);

    expect(text).toContain("Nenhuma loja encontrada.");
    expect(text).toContain(
      "Tente menos letras do nome ou deixe o campo vazio para ver todas as lojas."
    );
  });

  it("tells to check the environment when the list of every store is empty", async () => {
    const mounted = await mount(
      [json({ next: null, organizations: [] })],
      undefined,
      undefined,
      screenContext({ screen: "lojas" })
    );
    await mounted.search("");
    const text = visibleText(mounted.root);

    expect(text).toContain("Nenhuma loja encontrada.");
    expect(text).toContain(
      "Este ambiente ainda não tem loja. Confira o ambiente no alto da página."
    );
    expect(text).not.toContain("Tente menos letras");
  });
});

describe("Atendimentos", () => {
  const list = (who: ReturnType<typeof WHO>, context = {}) =>
    mount(
      [json({ cases: [], next: null })],
      who,
      undefined,
      screenContext({ screen: "casos", ...context })
    );

  it("sends the open list to Lojas, where a case is opened", async () => {
    const { root } = await list(OWNERS_WITH_STORES());

    expect(visibleText(root)).toContain("Nenhum atendimento aberto.");
    expect(emptyBlock(root, "Para mexer em uma loja")).toBe(
      "Para mexer em uma loja, abra um em Lojas."
    );
    expect(linkIn(root, "Para mexer em uma loja", "/lojas")?.textContent).toBe(
      "Lojas"
    );
  });

  it("sends the one who cannot read stores to Abrir atendimento", async () => {
    const { root } = await list(WHO("platform:read", "support_case:manage"));

    expect(emptyBlock(root, "Para mexer em uma loja")).toBe(
      "Para mexer em uma loja, use Abrir atendimento."
    );
    expect(
      linkIn(root, "Para mexer em uma loja", "/casos/novo")?.textContent
    ).toBe("Abrir atendimento");
  });

  it("sends the closed list to the open one", async () => {
    const { root } = await list(OWNERS_WITH_STORES(), {
      listState: "fechados",
    });

    expect(visibleText(root)).toContain("Nenhum atendimento fechado.");
    expect(emptyBlock(root, "Para ver os que estão")).toBe(
      "Para ver os que estão em andamento, abra Atendimentos abertos."
    );
    expect(linkIn(root, "Para ver os que estão", "/casos")?.textContent).toBe(
      "Atendimentos abertos"
    );
  });

  it("tells to clear the filter when a store is filtered", async () => {
    const { root } = await mount(
      [
        json({ cases: [], next: null }),
        json({ next: null, organizations: [] }),
      ],
      OWNERS_WITH_STORES(),
      undefined,
      screenContext({ screen: "casos", store: STORE })
    );

    expect(visibleText(root)).toContain("Nenhum atendimento aberto.");
    expect(emptyBlock(root, "Esta loja não tem atendimentos")).toBe(
      "Esta loja não tem atendimentos aqui. Deixe o campo vazio e filtre para ver os de todas as lojas."
    );
  });
});

function supportDetail(
  overrides: Partial<SupportCaseDetail["case"]> = {}
): SupportCaseDetail {
  return {
    audit: [],
    case: {
      closedAt: null,
      context: null,
      id: CASE,
      kind: "support",
      openedAt: OPENED_AT,
      openedBy: OWNER.principal.id,
      organizationId: STORE,
      organizationName: "Loja da Ana",
      reason: "Dono pediu ajuda com o estoque",
      resolution: null,
      status: "open",
      ...overrides,
    },
    grants: [],
  };
}

describe("Atendimento: o que foi feito", () => {
  const open = (who: ReturnType<typeof WHO>, body = supportDetail()) =>
    mount(
      [json(body)],
      who,
      undefined,
      screenContext({ id: CASE, screen: "caso" })
    );

  it("tells where to give the access when the operator may give it", async () => {
    const { root } = await open(
      WHO("platform:read", "support_case:manage", "tenant_access:grant")
    );

    expect(emptyBlock(root, "Nenhum acesso temporário")).toBe(
      "Nenhum acesso temporário neste atendimento. Para ver os clientes da loja (com dados escondidos), use Dar acesso aos clientes, em Ver clientes da loja, acima: o acesso acaba sozinho e fica registrado."
    );
    expect(emptyBlock(root, "Nada registrado ainda")).toBe(
      "Nada registrado ainda. Cada ação feita neste atendimento aparece aqui."
    );
  });

  it("sends the one who may not give it to the page with their permissions", async () => {
    const { root } = await open(WHO("platform:read", "support_case:manage"));

    expect(emptyBlock(root, "Nenhum acesso temporário")).toContain(
      "Quem pode dar o acesso temporário é outra pessoa do painel: veja o que você pode fazer em Minha conta e permissões."
    );
    expect(linksShown(root)).toContain("/configuracoes");
  });

  it("sends a closed case to Lojas to open another", async () => {
    const { root } = await open(
      OWNERS_WITH_STORES(),
      supportDetail({ closedAt: OPENED_AT, status: "closed" })
    );

    expect(emptyBlock(root, "Nenhum acesso temporário")).toBe(
      "Nenhum acesso temporário neste atendimento. Para ver os clientes de uma loja, abra um atendimento de suporte em Lojas."
    );
    expect(linksShown(root)).toContain("/lojas");
  });

  it("sends the one who cannot read stores to Abrir atendimento", async () => {
    const { root } = await open(
      WHO("platform:read", "support_case:manage"),
      supportDetail({ closedAt: OPENED_AT, status: "closed" })
    );

    expect(
      linkIn(root, "Nenhum acesso temporário", "/casos/novo")?.textContent
    ).toBe("Abrir atendimento");
    expect(linksShown(root)).not.toContain("/lojas");
  });

  it("sends a privacy case to Lojas as well", async () => {
    const { root } = await open(
      OWNERS_WITH_STORES(),
      supportDetail({ kind: "privacy" } as never)
    );

    expect(emptyBlock(root, "Nenhum acesso temporário")).toContain(
      "abra um atendimento de suporte em Lojas."
    );
  });
});

const PRIVACY = () => WHO("platform:read", "privacy_case:manage");

describe("Pedidos de dados", () => {
  const list = (listState: "abertos" | "fechados") =>
    mount(
      [json({ cases: [], next: null })],
      PRIVACY(),
      () => NOW,
      screenContext({ listState, screen: "privacidade" })
    );

  it("sends the open list to Abrir atendimento de privacidade", async () => {
    const { root } = await list("abertos");

    expect(visibleText(root)).toContain(
      "Nenhum atendimento de privacidade aberto."
    );
    expect(emptyBlock(root, "Quando um titular")).toBe(
      "Quando um titular pedir os dados dele, registre o pedido em Abrir atendimento de privacidade."
    );
    expect(
      linksShown(root).filter((href) => href === "/privacidade/novo")
    ).toHaveLength(2);
  });

  it("sends the closed list to the open one", async () => {
    const { root } = await list("fechados");

    expect(visibleText(root)).toContain(
      "Nenhum atendimento de privacidade fechado."
    );
    expect(emptyBlock(root, "Para ver os que estão")).toBe(
      "Para ver os que estão em andamento, abra Pedidos de dados abertos."
    );
    expect(
      linkIn(root, "Para ver os que estão", "/privacidade")?.textContent
    ).toBe("Pedidos de dados abertos");
  });
});

function privacyDetail(): PrivacyCaseDetail {
  return {
    actions: [],
    audit: [],
    case: {
      closedAt: null,
      id: CASE,
      openedAt: OPENED_AT,
      organizationId: STORE,
      organizationName: "Loja da Ana",
      resolution: null,
      status: "open",
    },
    privacy: {
      channel: "email",
      decision: null,
      decisionNote: null,
      decisionReason: null,
      dueAt: "2026-11-14T15:00:00.000Z",
      identityMethod: null,
      identityStatus: null,
      note: null,
      overdue: false,
      polarisRole: null,
      receivedAt: OPENED_AT,
      requesterKind: "data_subject",
      requestType: "deletion",
      resolvedAt: null,
      scopeCategories: null,
      stage: "requested",
      subjectReference: null,
    },
  } as PrivacyCaseDetail;
}

describe("Pedido de dados: o que foi feito", () => {
  it("says the next step is the first stage", async () => {
    const { root } = await mount(
      [json(privacyDetail())],
      PRIVACY(),
      () => NOW,
      screenContext({ id: CASE, screen: "privacidade-caso" })
    );

    expect(emptyBlock(root, "Nada registrado ainda")).toBe(
      "Nada registrado ainda. Cada etapa registrada neste atendimento aparece aqui."
    );
  });
});

describe("Apagamento e trava legal", () => {
  const hold = (who: ReturnType<typeof WHO>, status: string) =>
    mount(
      [
        json(
          (() => {
            const detail = privacyDetail();
            return {
              ...detail,
              privacy: { ...detail.privacy, stage: "decided" },
            };
          })()
        ),
        json(diagnostics({ id: STORE, name: "Loja da Ana", status })),
        json({ dueForReview: 0, holds: [], next: null }),
      ],
      who,
      () => NOW,
      screenContext({ action: "purge", id: CASE, screen: "privacidade-caso" })
    );
  const MAY = () =>
    WHO(
      "platform:read",
      "organization:diagnose",
      "privacy_case:manage",
      "organization:purge",
      "organization:legal_hold"
    );

  it("points to the button that puts a hold, below", async () => {
    const { root } = await hold(MAY(), "closed");

    expect(visibleText(root)).toContain(
      "Nenhuma trava legal vigente. Para pôr uma, use Pôr trava legal, abaixo."
    );
  });

  it("does not point to the hold button when the operator cannot put a hold", async () => {
    const { root } = await hold(
      WHO(
        "platform:read",
        "organization:diagnose",
        "privacy_case:manage",
        "organization:purge"
      ),
      "closed"
    );

    expect(visibleText(root)).toContain(
      "Trava legalO servidor confere ao agendar."
    );
    expect(visibleText(root)).not.toContain("Nenhuma trava legal vigente");
    expect(visibleText(root)).not.toContain("abaixo");
    expect(visibleText(root)).not.toContain("Pôr trava legal");
  });

  it("says a purged store has nothing left to hold", async () => {
    const { root } = await hold(MAY(), "purged");

    expect(visibleText(root)).toContain(
      "Nenhuma trava legal vigente. A loja já foi apagada: não há o que travar."
    );
  });
});

describe("Lojas com trava legal", () => {
  const open = (who: ReturnType<typeof WHO>) =>
    mount(
      [json({ dueForReview: 0, holds: [], next: null })],
      who,
      () => NOW,
      screenContext({ screen: "retencoes" })
    );

  it("sends the operator to Pedidos de dados, where a hold is put", async () => {
    const { root } = await open(
      WHO("platform:read", "organization:legal_hold", "privacy_case:manage")
    );

    expect(visibleText(root)).toContain("Nenhuma loja com trava legal.");
    expect(emptyBlock(root, "Para pôr uma trava")).toBe(
      "Para pôr uma trava, abra o pedido de dados da loja e use a aba Apagamento e trava legal. Ir para Pedidos de dados"
    );
    expect(linkTo(root, "/privacidade")?.textContent).toBe(
      "Ir para Pedidos de dados"
    );
  });

  it("says the same without a link when the operator cannot open Pedidos de dados", async () => {
    const { root } = await open(
      WHO("platform:read", "organization:legal_hold")
    );

    expect(emptyBlock(root, "Quem atende os pedidos")).toBe(
      "Quem atende os pedidos de dados da loja põe a trava, na aba Apagamento e trava legal."
    );
    expect(linksShown(root)).not.toContain("/privacidade");
  });
});
