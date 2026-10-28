import { mountAdmin } from "./app";
import {
  allElements,
  buttons,
  byId,
  FakeDocument,
  type FakeElement,
} from "./test-dom";
import type { OrganizationSummary, WhoAmI } from "./types";

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

/** The page mounted on a fresh document; `answers` are given in the order the page asks. */
export async function mount(
  answers: Answer[],
  who: Answer = json(OWNER),
  now: () => Date = () => new Date("2026-10-28T15:07:00.000Z")
) {
  const document = new FakeDocument();
  const root = document.createElement("div");
  document.body.append(root);
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
  await mountAdmin(root as unknown as HTMLElement, fetchJson, now);
  await flush();
  const search = async (text: string) => {
    byId(root, "busca").value = text;
    buttons(root, "Buscar")[0]?.click();
    await flush();
  };
  return { calls, document, queue, root, search };
}

export const alertOf = (root: FakeElement) =>
  allElements(root).find(
    (element) =>
      element.getAttribute("role") === "alert" &&
      !element.hasAttribute("hidden")
  );
