/// <reference lib="dom" />
// Only types from Playwright: `ui-screens.ts` is read under Vitest by the source rules.
import type { Page, Route } from "@playwright/test";
import { json, settle } from "./ui-entry-states";
import { serveHealth } from "./worker-mark";

/**
 * "Loja encerrada" as the guardrails draw it: the real route (`/loja-encerrada?loja=…`) of a store in its closing
 * window that can still be recovered, with the session, the status and the copies answered by the test
 * (`page.route`), synthetic data and a fixed page clock only.
 */
const STORE_ID = "0199c2d0-0000-7000-8000-00000000a001";
const COPY_ID = "0199c2d0-0000-7000-8000-0000000000aa";
const NOW = new Date("2026-10-30T12:00:00-03:00");
const PATH = `/loja-encerrada?loja=${STORE_ID}`;
const RPC_PREFIX = /^.*\/rpc\//;
const DOWNLOAD = /^Baixar dados\.json/;
const procedureOf = (route: Route) =>
  new URL(route.request().url()).pathname.replace(RPC_PREFIX, "");
const rpc = (body: unknown) => json(200, { json: body, meta: [] });

type Answer = Record<string, unknown>;

const closingStore = (overrides: Answer = {}): Answer => ({
  canRecover: true,
  deletableFrom: "2027-01-18T03:00:00.000Z",
  deletionDate: "2027-01-18",
  exportOpenUntil: "2027-01-18T03:00:00.000Z",
  id: STORE_ID,
  milestones: {
    closure: "2026-10-20T12:00:00.000Z",
    d7: "2027-01-11T03:00:00.000Z",
    d30: "2026-12-19T03:00:00.000Z",
    deletionDay: "2027-01-18T03:00:00.000Z",
  },
  name: "Loja do teste",
  phase: "closing",
  recoverUntil: "2026-11-19T12:00:00.000Z",
  renewal: "not_handled",
  requestedAt: "2026-10-20T12:00:00.000Z",
  timezone: "America/Sao_Paulo",
  ...overrides,
});

const READY_COPY: Answer = {
  errorCode: null,
  expiresAt: "2026-10-31T14:40:00.000Z",
  files: [{ name: "dados.json", ordinal: 1, sizeBytes: 820_400 }],
  formats: ["json", "csv"],
  id: COPY_ID,
  mode: "closed",
  readyAt: "2026-10-30T14:40:00.000Z",
  requestedAt: "2026-10-30T14:10:00.000Z",
  status: "ready",
  totalBytes: 820_400,
};

async function serve(
  page: Page,
  { copies, store }: { copies: Answer[]; store: Answer }
) {
  await page.clock.setFixedTime(NOW);
  await page.route("**/api/auth/get-session", (route) =>
    route.fulfill(
      json(200, {
        session: { id: "s" },
        user: { email: "dona@exemplo.test", id: "u", name: "Ana Dona" },
      })
    )
  );
  await serveHealth(page);
  await page.route("**/rpc/**", (route) => {
    switch (procedureOf(route)) {
      case "organization/closedStatus":
        return route.fulfill(rpc({ organization: store }));
      case "organization/listClosed":
        return route.fulfill(rpc({ organizations: [store] }));
      case "dataExport/listClosed":
        return route.fulfill(rpc({ exports: copies }));
      default:
        return route.abort("internetdisconnected");
    }
  });
}

async function open(
  page: Page,
  options: { copies: Answer[]; store: Answer },
  ready: (page: Page) => Promise<void>
) {
  await serve(page, options);
  await page.goto(PATH);
  await page
    .getByRole("heading", {
      exact: true,
      level: 1,
      name: "Loja do teste está encerrada",
    })
    .waitFor();
  await page.getByRole("region", { name: "Suas cópias" }).waitFor();
  await ready(page);
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    window.scrollTo(0, 0);
  });
  await settle(page);
}

export const closedStoreStates = {
  /** Store that can still be recovered, the copy block with no copy yet. */
  recoverable: (page: Page) =>
    open(page, { copies: [], store: closingStore() }, async (current) => {
      await current.getByText("Nenhuma cópia pedida ainda.").waitFor();
      await current
        .getByRole("button", { name: "Pedir cópia dos dados" })
        .waitFor();
    }),
  /** The same screen with one copy ready to download. */
  withCopy: (page: Page) =>
    open(page, { copies: [READY_COPY], store: closingStore() }, (current) =>
      current.getByRole("link", { name: DOWNLOAD }).waitFor()
    ),
};
