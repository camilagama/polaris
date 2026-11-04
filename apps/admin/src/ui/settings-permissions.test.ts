import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PLATFORM_CAPABILITIES } from "@polaris/domain/admin/platform-capabilities";
import { describe, expect, it } from "vitest";

/**
 * The words of Configurações (corte admin-v2, AC-P9.1) against the capabilities the server can list. The view is read
 * as text, not imported: it is written for the browser and this project has no DOM types.
 */
const source = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../../ui/views/settings.ts"),
  "utf8"
);
const TABLE = /const PERMISSION_TEXT[^=]*=\s*\{(.*?)\n\};/s;
const KEY = /^\s*"([a-z_]+:[a-z_]+)":/gm;

describe("the permission words of Configurações", () => {
  const keys = [...(TABLE.exec(source)?.[1] ?? "").matchAll(KEY)].map(
    (match) => match[1]
  );

  it("find the table in the view (the check is not blind)", () => {
    expect(keys.length).toBeGreaterThan(10);
  });

  it("translate every capability of the domain and nothing the domain does not have", () => {
    expect([...keys].sort()).toEqual([...PLATFORM_CAPABILITIES].sort());
  });
});
