import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { app } from "./app";

interface AssetsBlock {
  run_worker_first?: boolean | string[];
}

interface WranglerConfig {
  assets?: AssetsBlock;
  env?: Record<string, { assets?: AssetsBlock }>;
}

// wrangler.jsonc is JSON with comments and trailing commas, which is also a valid JavaScript expression
const config = new Function(
  `return (${readFileSync(new URL("../../wrangler.jsonc", import.meta.url), "utf8")});`
)() as WranglerConfig;

const environments: [string, AssetsBlock | undefined][] = [
  ["top level", config.assets],
  ...Object.entries(config.env ?? {}).map(
    ([name, block]): [string, AssetsBlock | undefined] => [
      `env.${name}`,
      block.assets,
    ]
  ),
];

/** The path patterns the Hono app answers, as the platform sees them (the middleware entries are not routes). */
function routedPaths(): string[] {
  const paths = new Set<string>();
  for (const route of app.routes) {
    if (route.method !== "ALL") {
      paths.add(route.path);
    }
  }
  return [...paths].sort();
}

/** A request path that the pattern `route` matches, with each parameter filled in. */
function samplePath(route: string): string {
  return route.replaceAll(/:[A-Za-z]+/g, "x").replaceAll("*", "x");
}

/** The platform's matching: a trailing `*` is a prefix, anything else is the exact path. */
function matchesPattern(pattern: string, path: string): boolean {
  return pattern.endsWith("*")
    ? path.startsWith(pattern.slice(0, -1))
    : path === pattern;
}

describe("the paths the Worker answers", () => {
  it("are read from the app itself, so the coverage check below has real routes to compare", () => {
    expect(routedPaths()).toContain("/webhooks/billing/:provider");
    expect(routedPaths()).toContain("/health");
    expect(routedPaths()).toContain("/api/auth/*");
  });

  describe.each(environments)(
    "run_worker_first of %s in wrangler.jsonc",
    (name, assets) => {
      if (name !== "top level" && assets === undefined) {
        it("is inherited from the top level (the block is not repeated)", () => {
          expect(config.assets?.run_worker_first).toBeInstanceOf(Array);
        });
        return;
      }

      it("covers every path the Worker serves, or the assets handler answers it (405 to a POST, the shell to a GET)", () => {
        const patterns = assets?.run_worker_first;
        expect(patterns).toBeInstanceOf(Array);
        const uncovered = routedPaths().filter(
          (route) =>
            !(patterns as string[]).some((pattern) =>
              matchesPattern(pattern, samplePath(route))
            )
        );
        expect(uncovered).toEqual([]);
      });
    }
  );
});
