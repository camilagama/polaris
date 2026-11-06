import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const sheet = readFileSync(join(here, "../../ui/admin.css"), "utf8");

const TAB_CLASSES = /\.[\w-]*\btabs?\b[\w-]*/g;
const TAB_DESCENDANT = /\.case-tabs\s+(a|button|li)\b/;

describe("the tabs of the Admin", () => {
  it("have one style, the `.tabs` of Atendimentos: the tabs of Apagamento add only a wrapper's spacing", () => {
    const selectors = new Set(sheet.match(TAB_CLASSES));

    expect([...selectors].sort()).toEqual([".case-tabs", ".tabs"]);
    expect(sheet).not.toMatch(TAB_DESCENDANT);
  });
});
