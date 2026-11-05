import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CLOSURE_NOTICE_ORGANIZATION_STATUSES } from "@polaris/domain/organization/closure-deadlines";
import { ORGANIZATION_STATUSES } from "@polaris/domain/organization/closure";
import { describe, expect, it } from "vitest";
import { CLOSURE_NOTICE_ORGANIZATION_STATUSES as PAGE_STATUSES } from "../../ui/privacy";

/**
 * The page's script imports nothing of the domain, and the screen must not narrow the server's precondition: the
 * states the section is offered in are the domain's, and the domain's are the ones the database function behind both
 * acts accepts, read from the latest migration that defines it.
 */
const drizzle = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/db/drizzle"
);
const FUNCTION = "FUNCTION public.closure_notice_support_reissue(";

function latestDefinition(): string {
  const files = readdirSync(drizzle)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const name of files.reverse()) {
    const text = readFileSync(join(drizzle, name), "utf8");
    const at = text.lastIndexOf(`CREATE ${FUNCTION}`);
    const replaced = text.lastIndexOf(`CREATE OR REPLACE ${FUNCTION}`);
    const start = Math.max(at, replaced);
    if (start >= 0) {
      const end = text.indexOf("$function$;", start);
      expect(end).toBeGreaterThan(start);
      return text.slice(start, end);
    }
  }
  throw new Error("closure_notice_support_reissue is not in any migration");
}

function statusesOf(definition: string): string[] {
  const lists = [
    ...definition.matchAll(/organization\.status IN \(([^)]*)\)/g),
  ].map((match) =>
    [...(match[1] ?? "").matchAll(/'([a-z_]+)'/g)].map((word) => word[1] ?? "")
  );
  expect(lists.length).toBeGreaterThan(0);
  const [first] = lists;
  for (const list of lists) {
    expect(list).toEqual(first);
  }
  return first ?? [];
}

describe("the states the closure notice section is offered in", () => {
  it("are the ones the database function accepts, in the domain and in the page", () => {
    const database = statusesOf(latestDefinition());
    expect(database).toEqual([...CLOSURE_NOTICE_ORGANIZATION_STATUSES]);
    expect(PAGE_STATUSES).toEqual([...CLOSURE_NOTICE_ORGANIZATION_STATUSES]);
  });

  it("are all states of an organization, and leave out the ones before and after the closure", () => {
    for (const status of CLOSURE_NOTICE_ORGANIZATION_STATUSES) {
      expect(ORGANIZATION_STATUSES).toContain(status);
    }
    for (const status of ["active", "suspended", "purged"]) {
      expect(PAGE_STATUSES).not.toContain(status);
    }
  });
});
