import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import {
  test as base,
  type Page,
  expect as playwrightExpect,
  type TestInfo,
} from "@playwright/test";
import type { PolarisRpcClient } from "@polaris/contracts";
import { createDatabase } from "@polaris/db/client";
import type { BetterAuthPlugin } from "better-auth";
import { testUtils } from "better-auth/plugins";
import { PREFERRED_ORGANIZATION_KEY } from "../src/lib/current-organization-model";
import { createBetterAuth } from "../src/server/auth";
import { journeyClientIp, journeyName, uuidV5 } from "./journey-names";
import { databaseUrl } from "./run-database";
import {
  ensureRunEnvironment,
  ownerDatabaseUrl,
  runDatabaseName,
} from "./run-environment";
import { commandSeed, startCommandIds } from "./seed";

/**
 * The fixture of the journeys (T-125a): one user, one organization and one browser context per test and attempt.
 * The session is made here, in Node, with Better Auth's `testUtils` and the run secret (the same the preview signs
 * with); the Worker never loads `testUtils` (e2e-real/confinement.test.ts). The data of a journey enters through
 * the Worker's own commands (`rpc`), never by SQL; `sql` is the owner connection of the run database, for the
 * oracle only (it ignores RLS, so it never proves isolation).
 */

interface AuthHelpers {
  createUser: (overrides?: Record<string, unknown>) => { id: string };
  getAuthHeaders: (options: { userId: string }) => Promise<Headers>;
  getCookies: (options: { userId: string; domain?: string }) => Promise<
    {
      name: string;
      value: string;
      domain: string;
      path: string;
      httpOnly: boolean;
      secure: boolean;
      sameSite: "Lax" | "Strict" | "None";
      expires?: number;
    }[]
  >;
  saveUser: (user: { id: string }) => Promise<{ id: string }>;
}

type Sql = ReturnType<typeof createDatabase>["pool"];

export interface JourneyUser {
  headers: Headers;
  id: string;
  name: string;
  rpc: PolarisRpcClient;
}

export interface Journey {
  /** `qa-<project>-<journey>-t<attempt>` */
  name: string;
  organizationId: string | undefined;
  page: Page;
  user: JourneyUser;
}

export interface JourneyOptions {
  /** Creates the organization through `organization.createInitial` (the onboarding journey does it on screen). */
  organization?: { timezone: string } | false;
}

const CLIENT_IP_HEADER = "cf-connecting-ip";

/** The instant of the run, captured once by the global setup. */
export function runT0(): number {
  const value = Number(process.env.E2E_T0);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("E2E_T0 is missing: the global setup sets it.");
  }
  return value;
}

export function rpcClient(origin: string, headers: Headers): PolarisRpcClient {
  const link = new RPCLink({
    fetch: (request: Request) => {
      const withSession = new Headers(request.headers);
      for (const [key, value] of headers) {
        withSession.set(key, value);
      }
      withSession.set("origin", origin);
      return fetch(new Request(request, { headers: withSession }));
    },
    method: "POST",
    url: new URL("/rpc", origin),
  });
  return createORPCClient(link);
}

/** The browser contexts a test opened, closed when it ends (fixture `contexts`). */
const openContexts: import("@playwright/test").BrowserContext[] = [];
/** The address each /rpc/ request of those contexts carried, against the journey's own. */
const rpcAddresses: Promise<{
  clientIp: string;
  sent: string | undefined;
} | null>[] = [];

let helpersPromise:
  | Promise<{ helpers: AuthHelpers; sql: Sql; close: () => Promise<void> }>
  | undefined;

function authHelpers() {
  helpersPromise ??= (async () => {
    const run = ensureRunEnvironment();
    const { db, pool } = createDatabase(
      databaseUrl(ownerDatabaseUrl(), runDatabaseName(run.runId)),
      { maxConnections: 2 }
    );
    const auth = createBetterAuth({
      baseURL: "http://127.0.0.1",
      database: db,
      plugins: [testUtils() as unknown as BetterAuthPlugin],
      secret: run.secret,
    });
    const helpers = ((await auth.$context) as unknown as { test: AuthHelpers })
      .test;
    return { close: () => pool.end(), helpers, sql: pool };
  })();
  return helpersPromise;
}

export async function createJourneyUser(
  origin: string,
  name: string
): Promise<
  JourneyUser & { cookies: Awaited<ReturnType<AuthHelpers["getCookies"]>> }
> {
  const { helpers } = await authHelpers();
  const id = uuidV5(name);
  await helpers.saveUser(
    helpers.createUser({
      email: `${name}@e2e.invalid`,
      emailVerified: true,
      id,
      name,
    })
  );
  const headers = await helpers.getAuthHeaders({ userId: id });
  headers.set(CLIENT_IP_HEADER, journeyClientIp(name));
  const cookies = await helpers.getCookies({
    domain: new URL(origin).hostname,
    userId: id,
  });
  return { cookies, headers, id, name, rpc: rpcClient(origin, headers) };
}

export async function openJourney(
  browser: import("@playwright/test").Browser,
  testInfo: TestInfo,
  journey: string,
  options: JourneyOptions = {}
): Promise<Journey> {
  const origin = String(testInfo.project.use.baseURL);
  const name = journeyName(testInfo.project.name, journey, testInfo.retry);
  const user = await createJourneyUser(origin, name);
  let organizationId: string | undefined;
  if (options.organization !== false) {
    const created = await user.rpc.organization.createInitial({
      name,
      timezone: options.organization?.timezone ?? "America/Sao_Paulo",
    });
    organizationId = created.organization.id;
  }
  const clientIp = journeyClientIp(name);
  const context = await browser.newContext({
    baseURL: origin,
    // the same address as the user's rpc calls: one rate limit bucket per test and attempt (journeyClientIp)
    extraHTTPHeaders: { [CLIENT_IP_HEADER]: clientIp },
    storageState: {
      cookies: user.cookies.map((cookie) => ({
        ...cookie,
        expires: cookie.expires ?? -1,
      })),
      origins: organizationId
        ? [
            {
              localStorage: [
                { name: PREFERRED_ORGANIZATION_KEY, value: organizationId },
              ],
              origin,
            },
          ]
        : [],
    },
  });
  openContexts.push(context);
  // checked when the test ends: every /rpc/ of the browser left with the journey's address, not 127.0.0.1 (only the
  // finished ones: `allHeaders` of a request a navigation aborted never settles). A background request (the
  // connection probe, the sync scheduler) can finish while the context closes: its headers can no longer be read,
  // so it is left out (null) instead of failing the journey with "Target page, context or browser has been closed"
  context.on("requestfinished", (request) => {
    if (new URL(request.url()).pathname.startsWith("/rpc/")) {
      rpcAddresses.push(
        request
          .allHeaders()
          .then((headers) => ({ clientIp, sent: headers[CLIENT_IP_HEADER] }))
          .catch(() => null)
      );
    }
  });
  const page = await context.newPage();
  // fixed at T0 and RUNNING: timers (outbox, the 4 s get-session, the lease `exp`, debounce) advance as usual
  await page.clock.install({ time: runT0() });
  console.log(`journey ${name} (T0 ${new Date(runT0()).toISOString()})`);
  return { name, organizationId, page, user };
}

export const test = base.extend<{ contexts: undefined }, { sql: Sql }>({
  contexts: [
    // biome-ignore lint/correctness/noEmptyPattern: Playwright fixtures need the object pattern as first argument
    async ({}, use, testInfo) => {
      // the command ids of this attempt come from the seed: printed on failure, `E2E_SEED` reproduces them
      startCommandIds(
        `${testInfo.project.name}/${testInfo.titlePath.join("/")}/t${testInfo.retry}`
      );
      await use(undefined);
      if (testInfo.status !== testInfo.expectedStatus) {
        console.error(
          `E2E_SEED=${commandSeed()} reproduces the command ids of this attempt.`
        );
        testInfo.annotations.push({
          description: commandSeed(),
          type: "E2E_SEED",
        });
      }
      const addresses = await Promise.all(rpcAddresses.splice(0));
      await Promise.all(
        openContexts.splice(0).map((context) => context.close())
      );
      if (testInfo.status === testInfo.expectedStatus) {
        playwrightExpect(
          addresses.filter(
            (address) => address !== null && address.sent !== address.clientIp
          ),
          "every /rpc/ of the browser carries the journey's client address"
        ).toEqual([]);
      }
    },
    { auto: true },
  ],
  sql: [
    // biome-ignore lint/correctness/noEmptyPattern: Playwright fixtures need the object pattern as first argument
    async ({}, use) => {
      const { close, sql } = await authHelpers();
      await use(sql);
      helpersPromise = undefined;
      await close();
    },
    { auto: true, scope: "worker" },
  ],
});

export const expect = playwrightExpect;

/** The oRPC code of a refused call ("FORBIDDEN", "NOT_FOUND", ...); fails if the call answers. */
export async function refusedWith(call: Promise<unknown>): Promise<string> {
  try {
    await call;
  } catch (error) {
    return String((error as { code?: unknown }).code ?? "no code");
  }
  throw new Error("The call was expected to be refused, and it answered.");
}
