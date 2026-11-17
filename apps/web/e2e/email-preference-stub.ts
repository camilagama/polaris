/// <reference lib="dom" />
import type { Page, Route } from "@playwright/test";
import { serveHealth, WORKER_MARK } from "./worker-mark";

/**
 * The server of the specs of the card "E-mails que você recebe": a signed-in person with one store, the two
 * procedures of the preference answered from a state the test owns, and the other reads of Seus dados empty.
 */
const ORGANIZATION = {
  id: "0199c2d0-0000-7000-8000-00000000a001",
  name: "Loja do teste",
  timezone: "America/Sao_Paulo",
};
const PATH = "/configuracoes?aba=seus-dados";

const SESSION_USER = {
  email: "dona@exemplo.test",
  id: "u",
  name: "Ana Dona",
};

export const rpc = (json: unknown, status = 200) => ({
  body: JSON.stringify({ json, meta: [] }),
  contentType: "application/json",
  headers: { ...WORKER_MARK },
  status,
});

interface PreferenceState {
  sent: number;
  tips: boolean;
}

export interface PreferenceServer {
  reads: number;
  state: PreferenceState;
  writes: Record<string, unknown>[];
}

interface Options {
  role?: string;
  /** Answers `account/setTips` instead of the default (which saves the state and answers it). */
  setTips?: (route: Route, server: PreferenceServer) => Promise<void>;
  state?: PreferenceState;
}

export async function openPreferenceScreen(
  page: Page,
  { role = "owner", setTips, state = { sent: 0, tips: true } }: Options = {}
): Promise<PreferenceServer> {
  const server: PreferenceServer = {
    reads: 0,
    state: { ...state },
    writes: [],
  };
  await page.route("**/api/auth/get-session", (route) =>
    route.fulfill({
      body: JSON.stringify({ session: { id: "s" }, user: SESSION_USER }),
      contentType: "application/json",
      headers: { ...WORKER_MARK },
    })
  );
  await serveHealth(page);
  await page.route("**/rpc/**", (route) => {
    const procedure = new URL(route.request().url()).pathname.replace(
      "/rpc/",
      ""
    );
    if (procedure === "organization/listMine") {
      return route.fulfill(
        rpc({
          billingSelfService: false,
          organizations: [{ ...ORGANIZATION, role }],
        })
      );
    }
    if (procedure === "account/emailPreference") {
      server.reads += 1;
      return route.fulfill(rpc(server.state));
    }
    if (procedure === "account/setTips") {
      const { json } = route.request().postDataJSON() as {
        json: Record<string, unknown>;
      };
      server.writes.push(json);
      if (setTips) {
        return setTips(route, server);
      }
      server.state = { ...server.state, tips: json.on === true };
      return route.fulfill(rpc(server.state));
    }
    if (procedure === "dataExport/list") {
      return route.fulfill(rpc({ exports: [] }));
    }
    return route.abort("internetdisconnected");
  });
  await page.goto(PATH);
  return server;
}
