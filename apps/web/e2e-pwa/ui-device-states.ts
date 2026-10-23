/// <reference lib="dom" />
// Only types from Playwright: `ui-screens.ts` is read under Vitest by the source rules.
import type { Page, Route } from "@playwright/test";

/**
 * The states of Aparelhos, Pendências and the notice of the offline access that expired, as the interface
 * guardrails measure them (t237): each screen in the lab of the screens (`/offline-screens-lab?screen=…`), Aparelhos
 * over the real offline runtime with the server answered by the test (`page.route`), the other two over synthetic data
 * (`src/offline-poc/notice-lab-pages.tsx`). The lab's own controls are hidden at the end of each state, so what is
 * measured is the screen alone. Same shape as `ui-stock-states.ts`.
 */
const rpc = (body: unknown, status = 200) => ({
  body: JSON.stringify({ json: body, meta: [] }),
  contentType: "application/json",
  status,
});

const failure = (status: number, code: string, reason?: string) =>
  rpc(
    {
      code,
      data: reason ? { reason } : undefined,
      defined: false,
      message: code,
      status,
    },
    status
  );

const uuid = (n: number) =>
  `0199c2d0-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const device = (n: number, label: string | null, lastSeenAt: string) => ({
  createdAt: "2026-10-01T12:00:00.000Z",
  id: uuid(n),
  label,
  lastSeenAt,
  revokedAt: null,
});

/** The first is this browser's device in the lab (`registerDevice` answers `uuid(7001)`). */
const DEVICES = [
  device(7001, "Chrome no Android", "2026-10-14T10:00:00.000Z"),
  device(2, "Celular da Ana", "2026-10-13T10:00:00.000Z"),
  device(
    3,
    "Tablet do estoque da loja do centro com um nome bem comprido",
    "2026-10-12T10:00:00.000Z"
  ),
  device(4, null, "2026-10-11T10:00:00.000Z"),
];

const REVOKE_OTHER = /^Revogar o aparelho Celular da Ana/;

async function serveAuthMethods(page: Page) {
  await page.route("**/api/auth-methods", (route) =>
    route.fulfill({
      body: JSON.stringify({
        emailPassword: true,
        google: true,
        turnstileSiteKey: null,
      }),
      contentType: "application/json",
    })
  );
}

interface Served {
  /** Answers the read of the list. */
  list?: (route: Route) => Promise<void> | void;
  /** Answers the revocation. */
  revoke?: (route: Route) => Promise<void> | void;
}

async function serveDevices(page: Page, served: Served) {
  await serveAuthMethods(page);
  await page.route("**/rpc/device/list", (route) =>
    served.list ? served.list(route) : route.fulfill(rpc({ devices: DEVICES }))
  );
  await page.route("**/rpc/device/revoke", (route) =>
    served.revoke
      ? served.revoke(route)
      : route.fulfill(failure(500, "INTERNAL_SERVER_ERROR"))
  );
}

/** Starts the lab's runtime on a screen of it; the network is the lab's checkbox. */
async function startLab(page: Page, query: string) {
  await page.goto(`/offline-screens-lab?${query}`);
  await page.getByLabel("Usuário").fill(`guardrails-${crypto.randomUUID()}`);
  await page.getByRole("button", { exact: true, name: "Iniciar" }).click();
  await page
    .getByTestId("message")
    .filter({ hasText: "Iniciar: ok (ready)" })
    .waitFor({ timeout: 20_000 });
}

async function openDevicesLab(page: Page, served: Served) {
  await serveDevices(page, served);
  await startLab(page, "screen=devices");
  await page
    .getByRole("heading", { exact: true, level: 1, name: "Aparelhos" })
    .waitFor();
}

/** Hides the lab's own controls and waits for the fonts: what stays is the screen. */
async function showScreenAlone(page: Page) {
  await page.evaluate(() => {
    for (const element of document.querySelectorAll("[data-lab-chrome]")) {
      (element as HTMLElement).hidden = true;
    }
    (document.activeElement as HTMLElement | null)?.blur();
    window.scrollTo(0, 0);
  });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(200);
}

/** Opens the list and waits for the rows, the connection and the security section to be drawn. */
async function openList(page: Page) {
  await openDevicesLab(page, {});
  await page.getByText("Celular da Ana").waitFor();
  await page.getByRole("link", { name: "Trocar senha" }).waitFor();
}

export const deviceStates = {
  /** The list has no device at all. */
  async empty(page: Page) {
    await openDevicesLab(page, {
      list: (route) => route.fulfill(rpc({ devices: [] })),
    });
    await page.getByText("Nenhum aparelho registrado nesta conta.").waitFor();
    await showScreenAlone(page);
  },

  /** The read failed: the message and the retry. */
  async error(page: Page) {
    await openDevicesLab(page, {
      list: (route) => route.fulfill(failure(500, "INTERNAL_SERVER_ERROR")),
    });
    await page.getByRole("button", { name: "Tentar novamente" }).waitFor();
    await showScreenAlone(page);
  },

  /** This device, three others (one with a name too long for the line, one without a name) and "Trocar senha". */
  async list(page: Page) {
    await openList(page);
    await showScreenAlone(page);
  },

  /** The read does not answer: the screen waits. */
  async loading(page: Page) {
    await openDevicesLab(page, {
      list: () => new Promise<void>(() => undefined),
    });
    await page.getByText("Carregando seus aparelhos…").waitFor();
    await showScreenAlone(page);
  },

  /** Without a network the buttons are off and the screen says why. */
  async offline(page: Page) {
    await openList(page);
    await page.getByLabel("Rede disponível").uncheck();
    await page.getByText("Sem conexão.", { exact: false }).first().waitFor();
    await showScreenAlone(page);
  },

  /** The login is too old to revoke: nothing was revoked, and the panel sends the person to sign in again. */
  async sessionOld(page: Page) {
    await openDevicesLab(page, {
      revoke: (route) =>
        route.fulfill(failure(403, "FORBIDDEN", "fresh_session_required")),
    });
    await page.getByText("Celular da Ana").waitFor();
    await page.getByRole("button", { name: REVOKE_OTHER }).click();
    await page
      .getByRole("button", { exact: true, name: "Sim, revogar este aparelho" })
      .click();
    await page
      .getByRole("heading", { name: "Entre de novo para continuar" })
      .waitFor();
    await showScreenAlone(page);
  },
};

async function openNoticeLab(
  page: Page,
  query: string,
  ready: () => Promise<void>
) {
  await startLab(page, query);
  await ready();
  await showScreenAlone(page);
}

export const attentionStates = {
  /** The last attempt to resolve an item failed: the message, and the discard asking for its confirmation. */
  async discarding(page: Page) {
    await startLab(page, "screen=attention&state=error");
    await page.getByText("Venda de 2 itens").waitFor();
    await page.getByRole("button", { name: "Descartar…" }).first().click();
    await page.getByRole("button", { name: "Confirmar descarte" }).waitFor();
    await showScreenAlone(page);
  },
  /** Nothing was refused. */
  async empty(page: Page) {
    await openNoticeLab(page, "screen=attention&state=empty", () =>
      page.getByText("Nada precisa de atenção.", { exact: false }).waitFor()
    );
  },

  /** A refused sale holding the queue, a refused product and an account change. */
  async items(page: Page) {
    await openNoticeLab(page, "screen=attention", () =>
      page.getByText("Venda de 2 itens").waitFor()
    );
  },
};

export const accessStates = {
  /** The access ended with the app open and there is no connection: the sale is not kept, and it comes back by itself. */
  async offline(page: Page) {
    await openNoticeLab(page, "screen=access-expired&open=1", () =>
      page
        .getByRole("heading", { name: "O acesso sem internet venceu" })
        .waitFor()
    );
  },

  /** The connection is back and the renewal did not start: the person can try now. */
  async online(page: Page) {
    await openNoticeLab(page, "screen=access-expired&online=1", () =>
      page.getByRole("button", { name: "Tentar agora" }).waitFor()
    );
  },
};
