import { describe, expect, it } from "vitest";
import {
  type AdminBindings,
  type AdminDependencies,
  createAdminApp,
} from "./app";

/**
 * Every route of the Admin app but `/health` is under `/api`, or is the operator's page and its files, and refuses a
 * request without an Access token (T-127a).
 * The protection is the order of `api.use("*", authentication)` before the routes; a route added with `app.get(...)`
 * outside `/api`, or before that middleware, would be public, and this is the test that would say so. The
 * dependencies are never reached: a request without a token stops at the first middleware.
 */
const bindings: AdminBindings = {
  ACCESS_AUDIENCE: "a".repeat(64),
  ACCESS_TEAM_DOMAIN: "example-team.cloudflareaccess.com",
  ADMIN_HYPERDRIVE: { connectionString: "postgresql://unused" },
};
const NEVER = new Proxy(
  {},
  {
    get: () => () => {
      throw new Error("a route reached its dependency without a login");
    },
  }
) as unknown as AdminDependencies;
const dependencies = {
  accessLog: NEVER,
  activationFunnel: NEVER,
  refundWindow: NEVER,
  authenticate: () => {
    throw new Error("no token: never asked");
  },
  incidents: NEVER,
  organizations: NEVER,
  privacy: NEVER,
  report: () => undefined,
  resolvePrincipal: NEVER,
  support: NEVER,
} as unknown as AdminDependencies;

const app = createAdminApp(dependencies, { css: "body{}", js: "export{};" });
const PUBLIC_PATHS = new Set(["/health"]);
/** The page and its two files (corte admin-tela-v1): behind the login like the API. */
const PAGE_PATHS = new Set(["/", "/ui/:file"]);
const routes = app.routes.filter((route) => route.method !== "ALL");
const PARAMETER = /:[A-Za-z]+/g;

describe("the Admin app's route surface", () => {
  it("has routes to walk (the list is not empty)", () => {
    expect(routes.length).toBeGreaterThan(30);
  });

  it("keeps everything but /health and the page under /api", () => {
    const outside = routes
      .filter(
        (route) =>
          !(
            PUBLIC_PATHS.has(route.path) ||
            PAGE_PATHS.has(route.path) ||
            route.path.startsWith("/api/")
          )
      )
      .map((route) => `${route.method} ${route.path}`);
    expect(outside).toEqual([]);
    // a route with a middleware is listed once per handler
    expect([
      ...new Set(
        routes
          .filter((route) => PAGE_PATHS.has(route.path))
          .map((route) => `${route.method} ${route.path}`)
      ),
    ]).toEqual(["GET /", "GET /ui/:file"]);
  });

  it.each(
    routes
      .filter((route) => !PUBLIC_PATHS.has(route.path))
      .map((route) => [route.method, route.path] as const)
  )(
    "%s %s refuses a request without a token with 401",
    async (method, path) => {
      const response = await app.request(
        path.replaceAll(PARAMETER, "x"),
        { method },
        bindings
      );
      expect(response.status).toBe(401);
    }
  );
});
