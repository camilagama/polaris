/// <reference lib="dom" />
import type { Locator, Page, Route } from "@playwright/test";
import { expect, test } from "@playwright/test";

/**
 * O aceite dos Termos de Uso e da Política de Privacidade (ADR 0100; AC-67 a AC-70 e L5): a tela
 * `/aceite`, fora do shell, e a ida até ela no primeiro acesso. O servidor é simulado pelas rotas.
 */
const ORGANIZATION = {
  id: "0199c2d0-0000-7000-8000-00000000a001",
  name: "Loja do teste",
  role: "owner",
  timezone: "America/Sao_Paulo",
};

const rpc = (json: unknown, status = 200) => ({
  body: JSON.stringify({ json, meta: [] }),
  contentType: "application/json",
  status,
});
const rpcError = (
  code: string,
  status: number,
  data?: Record<string, unknown>
) => rpc({ code, data, defined: false, message: code, status }, status);
const legalRefusal = rpcError("FORBIDDEN", 403, {
  pending: [
    { document: "terms", version: 1 },
    { document: "privacy", version: 1 },
  ],
  reason: "legal_acceptance_required",
});

const BOTH_PENDING = [
  { changes: null, document: "terms", effectiveFrom: null, version: 1 },
  { changes: null, document: "privacy", effectiveFrom: null, version: 1 },
];
const PRIVACY_CHANGED = [
  {
    changes:
      "Passamos a dizer por quanto tempo guardamos o registro de acesso. Nada mudou no que coletamos.",
    document: "privacy",
    effectiveFrom: "2026-11-01",
    version: 2,
  },
];

interface Server {
  accepted: unknown[];
  legalStatus: Array<() => ReturnType<typeof rpc>>;
}

const procedureOf = (route: Route) =>
  new URL(route.request().url()).pathname.replace("/rpc/", "");

async function serve(
  page: Page,
  options: {
    accept?: (input: unknown) => ReturnType<typeof rpc>;
    pending?: unknown[];
  } = {}
): Promise<Server> {
  const server: Server = { accepted: [], legalStatus: [] };
  await page.route("**/api/auth/get-session", (route) =>
    route.fulfill({
      body: JSON.stringify({ session: { id: "s" }, user: { id: "u" } }),
      contentType: "application/json",
    })
  );
  await page.route("**/rpc/**", (route) => {
    const procedure = procedureOf(route);
    if (procedure === "account/legalStatus") {
      const next = server.legalStatus.shift();
      return route.fulfill(
        next ? next() : rpc({ pending: options.pending ?? BOTH_PENDING })
      );
    }
    if (procedure === "account/acceptLegal") {
      const input = (route.request().postDataJSON() as { json: unknown }).json;
      server.accepted.push(input);
      return route.fulfill(
        options.accept ? options.accept(input) : rpc({ pending: [] })
      );
    }
    return route.abort("internetdisconnected");
  });
  return server;
}

const READ_AND_ACCEPT = /Ler e aceitar/;
const NOOPENER = /noopener/;

/** A link to a legal page opens in another tab, without a handle back to this one. */
async function expectNewTabLink(link: Locator, href: string) {
  await expect(link).toHaveAttribute("href", href);
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", NOOPENER);
}
const LINK_PATTERNS = {
  "Ler a Política de Privacidade": /Ler a Política de Privacidade/,
  "Ler os Termos de Uso": /Ler os Termos de Uso/,
} as const;

const checkbox = (page: Page) => page.getByRole("checkbox");
const continueButton = (page: Page) =>
  page.getByRole("button", { name: "Continuar" });

test("o aceite pendente mostra os dois documentos com link em outra aba, a caixa desmarcada, e sem menu do app", async ({
  page,
}) => {
  await serve(page);
  await page.goto("/aceite?voltar=/sales/history");

  await expect(page).toHaveTitle(
    "Termos de Uso e Política de Privacidade · Polaris"
  );
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: "Termos de Uso e Política de Privacidade",
    })
  ).toBeVisible();
  await expect(
    page.getByText("Para usar o Polaris, leia e aceite.")
  ).toBeVisible();
  await expect(page.getByText("Versão 1. Em vigor desde:")).toHaveCount(2);
  await expect(checkbox(page)).not.toBeChecked();
  await expect(page.getByRole("navigation")).toHaveCount(0);

  await expectNewTabLink(
    page.getByRole("link", { name: LINK_PATTERNS["Ler os Termos de Uso"] }),
    "/termos"
  );
  await expectNewTabLink(
    page.getByRole("link", {
      name: LINK_PATTERNS["Ler a Política de Privacidade"],
    }),
    "/privacidade"
  );
});

test("'Continuar' sem marcar a caixa diz o que falta e não grava nada; marcada, grava e volta ao destino", async ({
  page,
}) => {
  const server = await serve(page);
  await page.goto("/aceite?voltar=/sales/history");

  // never disabled for want of the box: the screen says what is missing (V6)
  await expect(continueButton(page)).toBeEnabled();
  await continueButton(page).click();
  await expect(page.getByRole("alert")).toContainText(
    "Marque a caixa para aceitar e continuar."
  );
  await expect(checkbox(page)).toBeFocused();
  expect(server.accepted).toEqual([]);

  await checkbox(page).check();
  await continueButton(page).click();
  await page.waitForURL("**/sales/history");
  expect(server.accepted).toEqual([
    {
      documents: [
        { document: "terms", version: 1 },
        { document: "privacy", version: 1 },
      ],
    },
  ]);
});

test("uma versão nova de um documento pede o aceite só dele e mostra o que mudou (L5)", async ({
  page,
}) => {
  const server = await serve(page, { pending: PRIVACY_CHANGED });
  await page.goto("/aceite");

  await expect(
    page.getByText("Atualizamos os termos. Leia e aceite para continuar.")
  ).toBeVisible();
  await expect(page.getByText("O que mudou")).toBeVisible();
  await expect(
    page.getByText("Passamos a dizer por quanto tempo")
  ).toBeVisible();
  await expect(
    page.getByText("Versão 2. Em vigor desde: 01/11/2026.")
  ).toBeVisible();
  await expect(
    page.getByLabel("Li e aceito a Política de Privacidade.")
  ).toBeVisible();

  await checkbox(page).check();
  await continueButton(page).click();
  // without `voltar` the app opens at the start
  await page.waitForURL((url) => url.pathname === "/");
  expect(server.accepted).toEqual([
    { documents: [{ document: "privacy", version: 2 }] },
  ]);
});

test("se a versão mudou com a tela aberta, lê de novo, desmarca a caixa e explica", async ({
  page,
}) => {
  const server = await serve(page, {
    accept: () =>
      rpcError("CONFLICT", 409, { reason: "legal_version_mismatch" }),
  });
  await page.goto("/aceite");
  await checkbox(page).check();
  await continueButton(page).click();

  await expect(page.getByRole("alert")).toContainText(
    "Os termos mudaram enquanto esta tela estava aberta."
  );
  await expect(checkbox(page)).not.toBeChecked();
  expect(server.accepted).toHaveLength(1);
  expect(new URL(page.url()).pathname).toBe("/aceite");
});

test("sem sessão, vai à tela de entrada e volta ao aceite depois", async ({
  page,
}) => {
  const server = await serve(page);
  server.legalStatus.push(() => rpcError("UNAUTHORIZED", 401));
  await page.goto("/aceite?voltar=/sales");

  await page.waitForURL(
    (url) =>
      url.pathname === "/entrar" && url.searchParams.get("motivo") === "sessao"
  );
  const voltar = new URL(page.url()).searchParams.get("voltar");
  expect(voltar).toBe("/aceite?voltar=/sales");
});

test("uma falha ao carregar diz o que houve e oferece 'Tentar de novo'", async ({
  page,
}) => {
  const server = await serve(page);
  server.legalStatus.push(() => rpcError("INTERNAL_SERVER_ERROR", 500));
  await page.goto("/aceite");

  await expect(page.getByRole("alert")).toContainText(
    "Não foi possível carregar os termos. Tente de novo."
  );
  await page.getByRole("button", { name: "Tentar de novo" }).click();
  await expect(checkbox(page)).toBeVisible();
});

test("no primeiro acesso sem aceite, o app vai sozinho a /aceite com a tela de destino, sem apagar nada (AC-69)", async ({
  page,
}) => {
  const listMine: string[] = [];
  await page.route("**/api/auth/get-session", (route) =>
    route.fulfill({
      body: JSON.stringify({ session: { id: "s" }, user: { id: "u" } }),
      contentType: "application/json",
    })
  );
  await page.route("**/rpc/**", (route) => {
    const procedure = procedureOf(route);
    if (procedure === "organization/listMine") {
      listMine.push(procedure);
      return route.fulfill(legalRefusal);
    }
    if (procedure === "account/legalStatus") {
      return route.fulfill(rpc({ pending: BOTH_PENDING }));
    }
    return route.abort("internetdisconnected");
  });
  // a public page with no call of its own, to leave something on the device before the app opens
  await page.goto("/termos");
  await page.evaluate(() =>
    window.localStorage.setItem("polaris.test.marker", "kept")
  );
  await page.goto("/categories");

  await page.waitForURL("**/aceite?voltar=/categories");
  await expect(
    page.getByRole("heading", {
      name: "Termos de Uso e Política de Privacidade",
    })
  ).toBeVisible();
  expect(listMine.length).toBeGreaterThan(0);
  expect(
    await page.evaluate(() =>
      window.localStorage.getItem("polaris.test.marker")
    )
  ).toBe("kept");
});

test("o rodapé do app tem os links das duas páginas legais, em outra aba (AC-70)", async ({
  page,
}) => {
  await page.route("**/api/auth/get-session", (route) =>
    route.fulfill({
      body: JSON.stringify({ session: { id: "s" }, user: { id: "u" } }),
      contentType: "application/json",
    })
  );
  await page.route("**/rpc/**", (route) => {
    const procedure = procedureOf(route);
    if (procedure === "organization/listMine") {
      return route.fulfill(rpc({ organizations: [ORGANIZATION] }));
    }
    if (procedure === "category/list") {
      return route.fulfill(rpc({ categories: [] }));
    }
    return route.abort("internetdisconnected");
  });
  await page.goto("/categories");
  const footer = page.getByRole("contentinfo");
  await expectNewTabLink(
    footer.getByRole("link", { name: "Termos de Uso" }),
    "/termos"
  );
  await expectNewTabLink(
    footer.getByRole("link", { name: "Política de Privacidade" }),
    "/privacidade"
  );
});

test("uma recusa por aceite com a tela em uso não navega: mostra o aviso fixo com 'Ler e aceitar' e mantém o digitado", async ({
  page,
}) => {
  await page.route("**/api/auth/get-session", (route) =>
    route.fulfill({
      body: JSON.stringify({ session: { id: "s" }, user: { id: "u" } }),
      contentType: "application/json",
    })
  );
  await page.route("**/rpc/**", (route) => {
    const procedure = procedureOf(route);
    if (procedure === "organization/listMine") {
      return route.fulfill(rpc({ organizations: [ORGANIZATION] }));
    }
    if (procedure === "category/list") {
      return route.fulfill(rpc({ categories: [] }));
    }
    if (procedure === "category/create") {
      return route.fulfill(legalRefusal);
    }
    return route.abort("internetdisconnected");
  });
  await page.goto("/categories");
  await page.getByLabel("Nova categoria").fill("Acessórios");
  await page.getByRole("button", { name: "Adicionar categoria" }).click();

  const notice = page.locator(".legal-acceptance-notice");
  await expect(notice).toContainText(
    "Para continuar usando o Polaris, leia e aceite os Termos de Uso e a Política de Privacidade."
  );
  await expect(
    notice.getByRole("link", { name: READ_AND_ACCEPT })
  ).toHaveAttribute("href", "/aceite?voltar=/categories");
  // it is not a refused session
  await expect(
    page.locator(".session-ended-notice:not(.legal-acceptance-notice)")
  ).toHaveCount(0);
  expect(new URL(page.url()).pathname).toBe("/categories");
  await expect(page.getByLabel("Nova categoria")).toHaveValue("Acessórios");
  // the error beside the button says what is missing, never "sua conta não tem acesso"
  await expect(page.getByRole("alert")).toContainText(
    "Não foi feito: falta aceitar os Termos de Uso e a Política de Privacidade."
  );
  await expect(page.getByText("Sua conta não tem acesso")).toHaveCount(0);
  await expect(
    notice.getByText("(abre em outra aba; o que você digitou fica nesta)")
  ).toBeVisible();
});
