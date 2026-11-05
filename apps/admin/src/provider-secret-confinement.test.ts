import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The Admin calls the payment providers for the operator's two commands and nothing else (ADR 0105). What only
 * receives the providers' calls (the webhook token of Asaas and its next one, the public keys of Woovi's webhooks,
 * the key that hides the payer's document) never comes to the Admin: no file of the Admin names it, so neither the
 * code nor the configuration a deploy reads can ask for it. And the provider's port is built in one place, the
 * ports of the two commands in `worker.ts`: no other module of the Admin builds one, so no other route can reach the
 * provider.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const admin = join(root, "apps/admin");
const SELF = "apps/admin/src/provider-secret-confinement.test.ts";
const SKIPPED_DIRECTORIES = new Set([
  ".turbo",
  ".wrangler",
  "dist",
  "generated",
  "node_modules",
]);
const TEXT_FILE = /\.(c|m)?(j|t)sx?$|\.jsonc?$|\.toml$|\.md$|\.vars$/;

const WEBHOOK_SECRETS = [
  "ASAAS_WEBHOOK_TOKEN",
  "WOOVI_WEBHOOK_PUBLIC_KEYS",
  "BILLING_PAYER_KEY",
  "asaas/webhook",
  "woovi/webhook",
  "woovi/signature",
];
/** The builders of a provider's port, and the clients under them. */
const PORT_BUILDERS = [
  "operatorProviderPortOf",
  "billingProviderPortOf",
  "createAsaasPort",
  "createWooviPort",
  "createAsaasClient",
  "createWooviClient",
];

function walk(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (SKIPPED_DIRECTORIES.has(entry.name)) {
      continue;
    }
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...walk(path));
    } else if (TEXT_FILE.test(entry.name) || entry.name.startsWith(".dev")) {
      found.push(path);
    }
  }
  return found;
}

const files = walk(admin)
  .map((path) => ({
    path: relative(root, path),
    text: readFileSync(path, "utf8"),
  }))
  .filter((file) => file.path !== SELF);

function naming(markers: readonly string[], scanned = files): string[] {
  return scanned
    .filter((file) => markers.some((marker) => file.text.includes(marker)))
    .map((file) => file.path)
    .sort();
}

describe("the providers' secrets in the Admin", () => {
  it("walks the Admin's code and its configuration (the scan is not vacuous)", () => {
    const paths = files.map((file) => file.path);
    expect(paths).toContain("apps/admin/src/worker.ts");
    expect(paths).toContain("apps/admin/wrangler.jsonc");
    expect(paths).toContain("apps/admin/package.json");
    expect(naming(["withProviderPorts"])).toEqual(["apps/admin/src/worker.ts"]);
  });

  it("names no secret or module of the webhooks anywhere", () => {
    expect(naming(WEBHOOK_SECRETS)).toEqual([]);
  });

  it("would catch one: a planted file that names the webhook token is found", () => {
    expect(
      naming(WEBHOOK_SECRETS, [
        {
          path: "apps/admin/src/planted.ts",
          text: "const token = env.ASAAS_WEBHOOK_TOKEN_NEXT;",
        },
      ])
    ).toEqual(["apps/admin/src/planted.ts"]);
  });

  it("builds a provider's port only in the ports of the two commands", () => {
    expect(
      naming(PORT_BUILDERS).filter((path) => !path.endsWith(".test.ts"))
    ).toEqual(["apps/admin/src/worker.ts"]);
    const worker = files.find(
      (file) => file.path === "apps/admin/src/worker.ts"
    )?.text;
    const start = worker?.indexOf("async function withProviderPorts") ?? -1;
    const end = worker?.indexOf("\nconst dependencies", start) ?? -1;
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const outside = `${worker?.slice(0, start)}${worker?.slice(end)}`;
    expect(
      PORT_BUILDERS.filter(
        (builder) =>
          outside.includes(`${builder}(`) || outside.includes(`${builder}<`)
      )
    ).toEqual([]);
    // and withProviderPorts serves exactly the two commands
    expect(outside.match(/withProviderPorts\(/g)?.length).toBe(2);
  });
});
