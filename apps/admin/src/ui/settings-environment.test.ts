import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  ENVIRONMENT_BANNER,
  type EnvironmentKind,
} from "../../ui/environment-banner";
import type { AccessClaims } from "../access-jwt";
import {
  type AdminBindings,
  type AdminDependencies,
  createAdminApp,
} from "../app";

/**
 * The environment of Configurações is the banner of the menu (corte admin-v2, AC-P9.2): the Worker writes it into the
 * page and the script writes it again, both read the words from `ui/environment-banner.ts`, so they exist once.
 */
const here = dirname(fileURLToPath(import.meta.url));
const adminRoot = join(here, "../..");
const KINDS: readonly [string | undefined, EnvironmentKind][] = [
  ["production", "production"],
  ["staging", "staging"],
  [undefined, "unknown"],
  ["preview", "unknown"],
];

function sourcesOf(directory: string): string[] {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith(".ts") &&
        !entry.name.endsWith(".test.ts") &&
        !entry.parentPath.includes("node_modules")
    )
    .map((entry) => join(entry.parentPath, entry.name));
}

async function bannerOfPage(environment: string | undefined) {
  const bindings: AdminBindings = {
    ACCESS_AUDIENCE: "a".repeat(64),
    ACCESS_TEAM_DOMAIN: "polaris.cloudflareaccess.com",
    ADMIN_HYPERDRIVE: { connectionString: "postgresql://admin.invalid/db" },
    ...(environment === undefined ? {} : { POLARIS_ENVIRONMENT: environment }),
  };
  const claims: AccessClaims = {
    email: "owner@example.com",
    expiresAt: 2_000_000_000,
    issuedAt: 1_000_000_000,
    issuer: "https://polaris.cloudflareaccess.com",
    subject: "subject-1",
  };
  const dependencies = {
    authenticate: vi.fn(() => Promise.resolve(claims)),
    report: vi.fn(),
    resolvePrincipal: vi.fn(() =>
      Promise.resolve({
        emailSnapshot: "owner@example.com",
        id: "0199a0a0-0000-7000-8000-000000000001",
        issuer: claims.issuer,
        role: "platform_owner",
        subject: "subject-1",
      })
    ),
  } as unknown as AdminDependencies;
  const admin = createAdminApp(dependencies, {
    css: "body{}",
    js: "export{};",
  });
  const response = await admin.fetch(
    new Request("https://admin.example.invalid/configuracoes", {
      headers: { "cf-access-jwt-assertion": "token" },
    }),
    bindings
  );
  return response.text();
}

describe("the environment words of Configurações", () => {
  it("cover the three environments with words that differ", () => {
    expect(Object.keys(ENVIRONMENT_BANNER).sort()).toEqual([
      "production",
      "staging",
      "unknown",
    ]);
    expect(new Set(Object.values(ENVIRONMENT_BANNER)).size).toBe(3);
  });

  it.each(KINDS)(
    "are what the Worker writes in the page for %s",
    async (environment, kind) => {
      const page = await bannerOfPage(environment);
      expect(page).toContain(
        `<p class="env env-${kind}">${ENVIRONMENT_BANNER[kind]}</p>`
      );
    }
  );

  it("are written in one file only: the Worker and the screen import them", () => {
    const owners = [
      ...sourcesOf(join(adminRoot, "src")),
      ...sourcesOf(join(adminRoot, "ui")),
    ].filter((file) =>
      Object.values(ENVIRONMENT_BANNER).some((words) =>
        readFileSync(file, "utf8").includes(words)
      )
    );
    expect(owners.map((file) => file.slice(adminRoot.length + 1))).toEqual([
      "ui/environment-banner.ts",
    ]);
  });
});
