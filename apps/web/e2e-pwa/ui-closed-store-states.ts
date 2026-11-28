/// <reference lib="dom" />
// Only types from Playwright: `ui-screens.ts` is read under Vitest by the source rules.
import type { Page, Route } from "@playwright/test";
import {
  CLOSED_STORE_ID,
  closingStore,
  fixClosedStoreClock,
  READY_COPY,
} from "../e2e/closed-store-fixture";
import { json, settle } from "./ui-entry-states";
import { serveHealth } from "./worker-mark";

/**
 * "Loja encerrada" as the guardrails draw it: the real route (`/loja-encerrada?loja=…`) of a store in its closing
 * window that can still be recovered, with the session, the status and the copies answered by the test
 * (`page.route`), synthetic data and a fixed page clock only.
 */
const STORE_ID = CLOSED_STORE_ID;
const PATH = `/loja-encerrada?loja=${STORE_ID}`;
const RPC_PREFIX = /^.*\/rpc\//;
const DOWNLOAD = /^Baixar dados\.json \(820 KB\)$/;
/** What the fields of `READY_COPY` that the screen shows read as: a change in one of them fails here. */
const READY_COPY_ON_SCREEN = [
  "Pedida em 30/10/2026, 11:10",
  "JSON e planilha",
  "Sua cópia está pronta. Baixe até 31/10/2026, 11:40.",
];
const procedureOf = (route: Route) =>
  new URL(route.request().url()).pathname.replace(RPC_PREFIX, "");
const rpc = (body: unknown) => json(200, { json: body, meta: [] });

type Answer = Record<string, unknown>;

async function serve(
  page: Page,
  { copies, store }: { copies: Answer[]; store: Answer }
) {
  await fixClosedStoreClock(page);
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
    open(
      page,
      { copies: [READY_COPY], store: closingStore() },
      async (current) => {
        await current.getByRole("link", { name: DOWNLOAD }).waitFor();
        await Promise.all(
          READY_COPY_ON_SCREEN.map((text) =>
            current
              .getByRole("region", { name: "Suas cópias" })
              .getByText(text, { exact: true })
              .waitFor()
          )
        );
      }
    ),
};
