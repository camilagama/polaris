/// <reference lib="dom" />
// Only types from Playwright: `ui-screens.ts` is read under Vitest by the source rules.
import type { Page, Route } from "@playwright/test";
import { hold, json, settle } from "./ui-entry-states";

/**
 * The states of the first access (no organization yet), of the acceptance (`/aceite`) and of the legal texts the
 * interface guardrails measure: the pages of the pwa-e2e build under the CSP of `_headers`, with the session
 * and the server answered by the test (`page.route`) and synthetic data only.
 */
const ORGANIZATION = {
  id: "0199c2d0-0000-7000-8000-00000000a001",
  name: "Loja do teste",
  role: "owner",
  timezone: "America/Sao_Paulo",
};

const rpc = (body: unknown, status = 200) =>
  json(status, { json: body, meta: [] });
const rpcError = (code: string, status: number) =>
  rpc({ code, defined: false, message: code, status }, status);
const RPC_PREFIX = /^.*\/rpc\//;
const procedureOf = (route: Route) =>
  new URL(route.request().url()).pathname.replace(RPC_PREFIX, "");

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

async function signedIn(page: Page) {
  await page.route("**/api/auth-methods", (route) =>
    route.fulfill(
      json(200, { emailPassword: true, google: true, turnstileSiteKey: null })
    )
  );
  await page.route("**/api/auth/get-session", (route) =>
    route.fulfill(
      json(200, {
        session: { id: "s" },
        user: { email: "ana@lojadaana.com.br", id: "u" },
      })
    )
  );
}

type Answer = (route: Route) => Promise<void> | void;

/** The app of someone with no organization: `organization.listMine` answers an empty list. */
async function serveFirstAccess(
  page: Page,
  { create, list }: { create?: Answer; list?: Answer } = {}
) {
  await signedIn(page);
  await page.route("**/rpc/**", (route) => {
    const procedure = procedureOf(route);
    if (procedure === "organization/listMine") {
      return list ? list(route) : route.fulfill(rpc({ organizations: [] }));
    }
    if (procedure === "organization/createInitial") {
      return create
        ? create(route)
        : route.fulfill(rpc({ organization: ORGANIZATION }));
    }
    return route.abort("internetdisconnected");
  });
}

const submitSetup = (page: Page) =>
  page.getByRole("button", { name: "Abrir loja" }).click();

async function openFirstAccess(page: Page) {
  await page.goto("/");
  await page
    .getByRole("heading", { level: 1, name: "Abra a sua loja" })
    .waitFor();
}

async function serveAcceptance(
  page: Page,
  { accept, status }: { accept?: Answer; status?: Answer } = {}
) {
  await signedIn(page);
  await page.route("**/rpc/**", (route) => {
    const procedure = procedureOf(route);
    if (procedure === "account/legalStatus") {
      return status
        ? status(route)
        : route.fulfill(rpc({ pending: BOTH_PENDING }));
    }
    if (procedure === "account/acceptLegal") {
      return accept ? accept(route) : route.fulfill(rpc({ pending: [] }));
    }
    return route.abort("internetdisconnected");
  });
}

async function openAcceptance(page: Page, ready: string | RegExp) {
  await page.goto("/aceite");
  await page
    .getByRole("heading", {
      level: 1,
      name: "Termos de Uso e Política de Privacidade",
    })
    .waitFor();
  await page.getByText(ready).first().waitFor();
}

export const firstAccessStates = {
  /** The state of the first visit: the form, as it opens. */
  empty: async (page: Page) => {
    await serveFirstAccess(page);
    await openFirstAccess(page);
    await settle(page);
  },
  /** The server refused: an alert above the button, the form as it was. */
  failed: async (page: Page) => {
    await serveFirstAccess(page, {
      create: (route) => route.fulfill(rpcError("SERVICE_UNAVAILABLE", 503)),
    });
    await openFirstAccess(page);
    await page.getByLabel("Nome da loja").fill("Loja Horizonte");
    await submitSetup(page);
    await page
      .getByText("O Polaris está temporariamente indisponível.")
      .waitFor();
    await settle(page);
  },
  /** "Abrir loja" with the name empty: the error at the field, the focus on it. */
  fieldErrors: async (page: Page) => {
    await serveFirstAccess(page);
    await openFirstAccess(page);
    await submitSetup(page);
    await page.getByText("Informe o nome da loja.").waitFor();
    await settle(page);
  },
  /** The server did not answer yet: the button says so and takes no second send. */
  opening: async (page: Page) => {
    await serveFirstAccess(page, { create: hold });
    await openFirstAccess(page);
    await page.getByLabel("Nome da loja").fill("Loja Horizonte");
    await submitSetup(page);
    await page.getByRole("button", { name: "Abrindo…" }).waitFor();
    await settle(page);
  },
};

export const acceptanceStates = {
  /** "Continuar" with the box unticked: the box says what is missing. */
  boxMissing: async (page: Page) => {
    await serveAcceptance(page);
    await openAcceptance(page, "Para usar o Polaris, leia e aceite.");
    await page.getByRole("button", { name: "Continuar" }).click();
    await page.getByText("Marque a caixa para aceitar e continuar.").waitFor();
    await settle(page);
  },
  /** Everything accepted already: the way into the app. */
  done: async (page: Page) => {
    await serveAcceptance(page, {
      status: (route) => route.fulfill(rpc({ pending: [] })),
    });
    await page.goto("/aceite");
    await page
      .getByText("Tudo certo: você já aceitou os termos em vigor.")
      .waitFor();
    await settle(page);
  },
  /** The first access: both documents, the box unticked. */
  first: async (page: Page) => {
    await serveAcceptance(page);
    await openAcceptance(page, "Para usar o Polaris, leia e aceite.");
    await settle(page);
  },
  loadFailed: async (page: Page) => {
    await serveAcceptance(page, {
      status: (route) => route.fulfill(rpcError("INTERNAL_SERVER_ERROR", 500)),
    });
    await page.goto("/aceite");
    await page.getByText("Não foi possível carregar os termos.").waitFor();
    await settle(page);
  },
  loading: async (page: Page) => {
    await serveAcceptance(page, { status: hold });
    await page.goto("/aceite");
    await page.getByText("Carregando os termos…").waitFor();
    await settle(page);
  },
  /** A new version of one document, with what changed. */
  newVersion: async (page: Page) => {
    await serveAcceptance(page, {
      status: (route) => route.fulfill(rpc({ pending: PRIVACY_CHANGED })),
    });
    await openAcceptance(page, "O que mudou");
    await settle(page);
  },
  /** The server did not save: an alert, the box still ticked. */
  saveFailed: async (page: Page) => {
    await serveAcceptance(page, {
      accept: (route) => route.fulfill(rpcError("SERVICE_UNAVAILABLE", 503)),
    });
    await openAcceptance(page, "Para usar o Polaris, leia e aceite.");
    await page.getByRole("checkbox").click();
    await page.getByRole("button", { name: "Continuar" }).click();
    await page.getByText("Não foi possível registrar o aceite.").waitFor();
    await settle(page);
  },
  saving: async (page: Page) => {
    await serveAcceptance(page, { accept: hold });
    await openAcceptance(page, "Para usar o Polaris, leia e aceite.");
    await page.getByRole("checkbox").click();
    await page.getByRole("button", { name: "Continuar" }).click();
    await page.getByRole("button", { name: "Registrando o aceite…" }).waitFor();
    await settle(page);
  },
};

export const legalStates = {
  /** The text of a legal page does not load: the brand, the title and a new try. */
  failed: async (page: Page) => {
    await page.route("**/assets/legal-page*.js", (route) => route.abort());
    await page.goto("/privacidade");
    await page
      .getByText("Não foi possível abrir esta página. Tente de novo.")
      .waitFor();
    await settle(page);
  },
  /** The text is still on its way. */
  loading: async (page: Page) => {
    await page.route("**/assets/legal-page*.js", hold);
    await page.goto("/privacidade");
    await page.getByRole("status").getByText("Carregando…").waitFor();
    await settle(page);
  },
};
