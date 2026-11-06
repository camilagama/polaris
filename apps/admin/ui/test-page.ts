import { mountAdmin, type ScreenContext } from "./app";
import {
  allElements,
  buttons,
  byId,
  FakeDocument,
  type FakeElement,
} from "./test-dom";
import type {
  OrganizationDiagnostics,
  OrganizationSummary,
  WhoAmI,
} from "./types";

/**
 * What the page's tests share: the operator, the simulated API (answers in the order the page asks, and every call
 * recorded) and the page mounted on a fresh small DOM (ui/test-dom.ts).
 */

export interface Call {
  init: RequestInit;
  path: string;
}

export type Answer = Response | Error | (() => Promise<Response>);

export const OWNER: WhoAmI = {
  capabilities: [
    "organization:diagnose",
    "platform:read",
    "support_case:manage",
    "billing:operate",
  ],
  principal: {
    emailSnapshot: "dona@polaris.example",
    id: "0199a0a0-0000-7000-8000-000000000001",
    role: "platform_owner",
  },
};

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });

/** The answer Access gives a `fetch` with `redirect: "manual"` once its session is over. */
export const accessRedirect = () =>
  ({ ok: false, status: 0, type: "opaqueredirect" }) as Response;

export function summary(
  overrides: Partial<OrganizationSummary> = {}
): OrganizationSummary {
  return {
    accessEndsAt: null,
    billingState: "free",
    createdAt: "2026-10-01T12:00:00.000Z",
    id: "org-free-1",
    name: "Loja da Ana",
    planInForce: "free",
    status: "active",
    ...overrides,
  };
}

// the tests run in Node; the page's own types are the browser's, which have no setImmediate
declare function setImmediate(callback: () => void): unknown;

export const flush = () =>
  new Promise<void>((resolve) => setImmediate(resolve));

/** The screen a test mounts: Buscar loja, the v1's page, unless the test names another. */
export function screenContext(
  overrides: Partial<ScreenContext> = {}
): ScreenContext {
  return {
    environment: "staging",
    flagKeys: ["offline.write", "public_catalog"],
    id: null,
    limitKeys: [
      "goals.active.max",
      "images.active.max",
      "images.per_product.max",
      "variants.active.max",
    ],
    listState: "abertos",
    screen: "lojas",
    store: null,
    ...overrides,
  };
}

/** The page mounted on a fresh document; `answers` are given in the order the page asks. */
export async function mount(
  answers: Answer[],
  who: Answer = json(OWNER),
  now: () => Date = () => new Date("2026-10-28T15:07:00.000Z"),
  context: ScreenContext = screenContext()
) {
  const document = new FakeDocument();
  const root = document.createElement("div");
  const operator = document.createElement("span");
  document.body.append(operator, root);
  const calls: Call[] = [];
  const queue = [who, ...answers];
  const fetchJson = (path: string, init: RequestInit) => {
    calls.push({ init, path });
    const answer = queue.shift();
    if (answer === undefined) {
      throw new Error(`unexpected request to ${path}`);
    }
    if (answer instanceof Error) {
      return Promise.reject(answer);
    }
    return typeof answer === "function" ? answer() : Promise.resolve(answer);
  };
  const navigations: string[] = [];
  await mountAdmin(
    root as unknown as HTMLElement,
    fetchJson,
    now,
    context,
    (path) => {
      navigations.push(path);
    },
    operator as unknown as HTMLElement
  );
  await flush();
  const search = async (text: string) => {
    byId(root, "busca").value = text;
    buttons(root, "Buscar")[0]?.click();
    await flush();
  };
  return { calls, document, navigations, operator, queue, root, search };
}

export const alertOf = (root: FakeElement) =>
  allElements(root).find(
    (element) =>
      element.getAttribute("role") === "alert" &&
      !element.hasAttribute("hidden")
  );

export function diagnostics(
  overrides: {
    attention?: OrganizationDiagnostics["attention"];
    billing?: Partial<NonNullable<OrganizationDiagnostics["billing"]>> | null;
    entitlements?: Partial<OrganizationDiagnostics["entitlements"]>;
    grants?: OrganizationDiagnostics["grants"];
    id?: string;
    lastReceivedAt?: string | null;
    name?: string;
    quotas?: OrganizationDiagnostics["quotas"];
    status?: string;
  } = {}
): OrganizationDiagnostics {
  const billing =
    overrides.billing === null
      ? null
      : {
          accessEndsAt: "2026-11-15T02:59:59.000Z",
          cancelAtPeriodEnd: false,
          cycleMonths: 1,
          lastFactAt: "2026-10-15T15:00:00.000Z",
          overLimitSince: null,
          pendingCycleMonths: null,
          provider: "asaas",
          revokedReason: null,
          revokedThrough: null,
          state: "active",
          trialStartedAt: "2026-10-01T15:00:00.000Z",
          version: 3,
          ...overrides.billing,
        };
  return {
    attention: overrides.attention ?? [],
    billing,
    billingEvents: {
      byStatus: {},
      lastReceivedAt: null,
      maxAttempts: 0,
      oldestUnprocessedAt: null,
    },
    entitlements: {
      accessEndsAt: "2026-11-15T02:59:59.000Z",
      flags: { "offline.write": true, public_catalog: true },
      overLimit: false,
      plan: "pro",
      raisedByGrant: [],
      state: "active",
      ...overrides.entitlements,
    },
    grants: overrides.grants ?? [],
    offline: { activeGrants: 0, devices: 2, lastSeenAt: null },
    organization: {
      authorizationEpoch: 1,
      createdAt: "2026-10-01T12:00:00.000Z",
      currency: "BRL",
      id: overrides.id ?? "org-pro-1",
      members: 1,
      name: overrides.name ?? "Loja do Bruno",
      status: overrides.status ?? "active",
      timezone: "America/Sao_Paulo",
    },
    quotas: overrides.quotas ?? [
      { key: "goals.active.max", limit: 10, status: "ok", used: 1 },
      { key: "images.active.max", limit: 500, status: "ok", used: 20 },
      { key: "images.per_product.max", limit: 5, status: "at_limit", used: 5 },
      { key: "variants.active.max", limit: 1000, status: "ok", used: 40 },
    ],
    sync: {
      last7Days: {},
      lastReceivedAt:
        overrides.lastReceivedAt === undefined
          ? "2026-10-27T03:30:00.000Z"
          : overrides.lastReceivedAt,
      rejectedByCode: {},
    },
    usage: {
      activeGoals: 1,
      archivedProducts: 0,
      images: 20,
      maxImagesPerProduct: 5,
      products: 12,
      variants: 40,
    },
  };
}
