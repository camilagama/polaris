/// <reference lib="dom" />
// Only types from Playwright: `ui-screens.ts` is read under Vitest by the source rules.
import type { Page, Route } from "@playwright/test";
import { json, settle } from "./ui-entry-states";
import { PAYMENT_PROFILES } from "./ui-payment-states";
import { serveHealth } from "./worker-mark";

/**
 * Ajuda, Configurações and Seus dados as the visual regression draws them: the real routes of the shell
 * (`/ajuda`, `/configuracoes`, `/configuracoes?aba=seus-dados`) with the session, the store and the lists answered by
 * the test (`page.route`), synthetic data and a fixed page clock only.
 */
const ORGANIZATION = {
  id: "0199c2d0-0000-7000-8000-00000000a001",
  name: "Loja do teste",
  role: "owner",
  timezone: "America/Sao_Paulo",
};
const NOW = new Date("2026-10-30T15:00:00.000Z");
const DOWNLOAD = /^Baixar dados\.json/;
const RPC_PREFIX = /^.*\/rpc\//;
const procedureOf = (route: Route) =>
  new URL(route.request().url()).pathname.replace(RPC_PREFIX, "");
const rpc = (body: unknown) => json(200, { json: body, meta: [] });

const dataCopy = (overrides: Record<string, unknown>) => ({
  errorCode: null,
  expiresAt: null,
  files: [],
  formats: ["json", "csv"],
  readyAt: null,
  totalBytes: null,
  ...overrides,
});

/** One copy ready to download and one past its expiry: the two shapes of a row of "Suas cópias" with data. */
const DATA_COPIES = [
  dataCopy({
    expiresAt: "2026-10-31T14:40:00.000Z",
    files: [{ name: "dados.json", ordinal: 1, sizeBytes: 820_400 }],
    id: "0199c2d0-0000-7000-8000-0000000000aa",
    readyAt: "2026-10-30T14:40:00.000Z",
    requestedAt: "2026-10-30T14:10:00.000Z",
    status: "ready",
    totalBytes: 820_400,
  }),
  dataCopy({
    expiresAt: "2026-10-24T14:40:00.000Z",
    id: "0199c2d0-0000-7000-8000-0000000000ab",
    readyAt: "2026-10-23T14:40:00.000Z",
    requestedAt: "2026-10-23T14:10:00.000Z",
    status: "expired",
  }),
];

async function serveShell(page: Page) {
  await page.clock.setFixedTime(NOW);
  await page.route("**/api/auth/get-session", (route) =>
    route.fulfill(
      json(200, {
        session: { id: "s" },
        user: { email: "ana@lojadaana.com.br", id: "u", name: "Ana" },
      })
    )
  );
  await serveHealth(page);
  await page.route("**/rpc/**", (route) => {
    switch (procedureOf(route)) {
      case "organization/listMine":
        return route.fulfill(
          rpc({ billingSelfService: true, organizations: [ORGANIZATION] })
        );
      case "paymentProfile/list":
        return route.fulfill(rpc({ profiles: PAYMENT_PROFILES }));
      case "dataExport/list":
        return route.fulfill(rpc({ exports: DATA_COPIES }));
      case "account/emailPreference":
        return route.fulfill(rpc({ sent: 0, tips: true }));
      default:
        return route.abort("internetdisconnected");
    }
  });
}

async function open(
  page: Page,
  path: string,
  ready: (page: Page) => Promise<void>
) {
  await serveShell(page);
  await page.goto(path);
  await ready(page);
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    window.scrollTo(0, 0);
  });
  await settle(page);
}

export const settingsStates = {
  /** Ajuda: the two contacts, the list of what to do before writing and the legal links (no request of its own). */
  help: (page: Page) =>
    open(page, "/ajuda", (current) =>
      current.getByRole("heading", { level: 1, name: "Ajuda" }).waitFor()
    ),
  /** Configurações: the strip of tabs and the first tab (Formas de receber) on the desktop, the list of rows on a phone. */
  list: (page: Page) =>
    open(page, "/configuracoes", async (current) => {
      await current
        .getByRole("heading", { level: 1, name: "Configurações da loja" })
        .waitFor();
      const phone = (current.viewportSize()?.width ?? 0) < 760;
      if (!phone) {
        await current.getByText("Maquininha da loja").first().waitFor();
      }
    }),
  /** Seus dados with a copy ready and one expired. */
  yourData: (page: Page) =>
    open(page, "/configuracoes?aba=seus-dados", async (current) => {
      await current.getByRole("region", { name: "Suas cópias" }).waitFor();
      await current.getByRole("link", { name: DOWNLOAD }).waitFor();
    }),
};
