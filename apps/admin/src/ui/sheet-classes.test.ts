import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The page's script styles by class names only (the policy allows no style attribute), and the views are not a
 * `@source` of the sheet, so Tailwind never generates a utility written only there: a class the script creates that the
 * sheet has no rule for is an element that looks unstyled and says nothing. This reads every class the script writes and
 * holds it to a rule in `admin.css`.
 */

const repository = fileURLToPath(new URL("../../../..", import.meta.url));
const ui = join(repository, "apps/admin/ui");

const STRING_BODY = String.raw`"[^"\\\n]*"|'[^'\\\n]*'|\x60[^\x60\\]*\x60`;
const STRING = String.raw`"([^"\\\n]*)"|'([^'\\\n]*)'|\x60([^\x60\\]*)\x60`;
const CLASS_ATTRIBUTE = new RegExp(
  String.raw`\bclass:\s*((?:${STRING_BODY}|[^,}\n"'\x60])+)`,
  "g"
);
const SET_CLASS = new RegExp(
  String.raw`setAttribute\(\s*"class"\s*,\s*(?:${STRING})\s*\)`,
  "g"
);
const STRING_LITERAL = new RegExp(STRING, "g");
const IDENTIFIER_ONLY = /^[A-Za-z_$][\w$.]*$/;
const WHITESPACE = /\s+/;
const TEMPLATE_HOLE = /\$\{[^}]*\}/;

interface ScriptClasses {
  /** Variables written as the whole value of `class:`: their words are not in the text, so each one is listed. */
  dynamic: string[];
  /** Words that end in a template hole (`env-${x}`): the sheet must style the family, so only the prefix is held. */
  prefixes: string[];
  words: string[];
}

/** Every class word a script source writes: `class: "a b"`, both branches of a condition, a template, `setAttribute("class", …)`. */
export function classesOf(source: string): ScriptClasses {
  const words = new Set<string>();
  const prefixes = new Set<string>();
  const dynamic = new Set<string>();
  const take = (value: string) => {
    for (const word of value.split(WHITESPACE).filter(Boolean)) {
      const hole = word.search(TEMPLATE_HOLE);
      if (hole === -1) {
        words.add(word);
      } else if (hole > 0) {
        prefixes.add(word.slice(0, hole));
      }
    }
  };
  for (const [, expression = ""] of source.matchAll(CLASS_ATTRIBUTE)) {
    const literals = [...expression.matchAll(STRING_LITERAL)];
    if (literals.length === 0 && IDENTIFIER_ONLY.test(expression.trim())) {
      dynamic.add(expression.trim());
    }
    for (const literal of literals) {
      take(literal[1] ?? literal[2] ?? literal[3] ?? "");
    }
  }
  for (const match of source.matchAll(SET_CLASS)) {
    take(match[1] ?? match[2] ?? match[3] ?? "");
  }
  return {
    dynamic: [...dynamic].sort(),
    prefixes: [...prefixes].sort(),
    words: [...words].sort(),
  };
}

const COMMENT = /\/\*[\s\S]*?\*\//g;
const escapeRegExp = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

/** The words of `classes` the sheet has no rule for: a class selector `.word`, not the start of a longer name. */
export function withoutRule(sheet: string, words: readonly string[]) {
  const code = sheet.replace(COMMENT, "");
  return words.filter(
    (word) => !new RegExp(`\\.${escapeRegExp(word)}(?![\\w-])`).test(code)
  );
}

export function prefixesWithoutRule(
  sheet: string,
  prefixes: readonly string[]
) {
  const code = sheet.replace(COMMENT, "");
  return prefixes.filter(
    (prefix) => !new RegExp(`\\.${escapeRegExp(prefix)}[\\w-]`).test(code)
  );
}

function scriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return scriptFiles(path);
    }
    return entry.name.endsWith(".ts") && !entry.name.includes("test")
      ? [path]
      : [];
  });
}

/**
 * Classes the script writes as names of a part (a wrapper, a slot, the default of a variant) and the sheet has no rule
 * for on purpose. The list is exact: a class that gets a rule leaves it, and one that is new must be styled or added here.
 */
const MARKERS = [
  "access-state",
  "billing-actions",
  "case",
  "case-actions",
  "closed-case",
  "closure-notice",
  "closure-notice-slot",
  "due",
  "grant-action",
  "grant-value",
  "grants",
  "incident",
  "privacy-case",
  "purge-slot",
  "read-at",
  "report",
  "step-done",
  "steps-area",
  "suspension",
];

const adminSheet = readFileSync(join(ui, "admin.css"), "utf8");

describe("the classes the page's script creates have a rule in the sheet", () => {
  const files = scriptFiles(ui);
  const found = classesOf(
    files.map((file) => readFileSync(file, "utf8")).join("\n")
  );

  it("reads the script (the scan is not vacuous)", () => {
    expect(files.map((file) => relative(ui, file))).toContain("dom.ts");
    expect(files.length).toBeGreaterThan(10);
    expect(found.words.length).toBeGreaterThan(50);
    expect(found.words).toContain("hint");
    expect(found.words).toContain("funnel");
    expect(found.words).toContain("due-warn");
    expect(found.prefixes).toEqual(["env-"]);
  });

  it("styles every class written as a word, but the markers listed", () => {
    expect(
      withoutRule(adminSheet, found.words),
      "a class with no rule is an unstyled element: add one to apps/admin/ui/admin.source.css and run `bun run admin:sheet` (the views are not an @source, so a utility written only in them is never generated); only a pure marker goes in MARKERS"
    ).toEqual(MARKERS);
  });

  it("styles the family of every class written with a template hole", () => {
    expect(prefixesWithoutRule(adminSheet, found.prefixes)).toEqual([]);
  });

  it("lists the variables used as a whole class value, exactly (their words come from the callers)", () => {
    expect(found.dynamic).toEqual(["kind"]);
  });

  it("styles the words the callers of the variable pass", () => {
    const callers = files
      .map((file) => readFileSync(file, "utf8"))
      .join("\n")
      .matchAll(/\bline\([^)\n]*,\s*"([\w-]+)"\)/g);
    const words = [...new Set([...callers].map(([, word]) => word ?? ""))];
    expect(words).toContain("warning");
    expect(withoutRule(adminSheet, ["hint", ...words])).toEqual([]);
  });
});

describe("the scan of the script's classes (controls)", () => {
  it("reads a literal, both branches of a condition, a template and setAttribute", () => {
    expect(
      classesOf(
        [
          'dom.el("p", { class: "a b" });',
          'dom.el("p", { class: due ? "c d" : "c" });',
          `dom.el('p', { class: \`env env-$\{x}\` });`,
          'element.setAttribute("class", "grid funnel");',
          'dom.el("p", { class: kind });',
        ].join("\n")
      )
    ).toEqual({
      dynamic: ["kind"],
      prefixes: ["env-"],
      words: ["a", "b", "c", "d", "env", "funnel", "grid"],
    });
  });

  it("fails on a class the sheet has no rule for", () => {
    const invented = classesOf(
      'dom.el("p", { class: "hint invented-class" });'
    );
    expect(withoutRule(adminSheet, invented.words)).toEqual(["invented-class"]);
  });

  it("fails on a class only named in a comment or as the start of a longer name", () => {
    const text =
      "/* .ghost */ .ghost-town { color: red; } .real { color: red; }";
    expect(withoutRule(text, ["ghost", "real"])).toEqual(["ghost"]);
  });

  it("fails on a family the sheet has no selector for", () => {
    expect(prefixesWithoutRule(adminSheet, ["nothing-like-"])).toEqual([
      "nothing-like-",
    ]);
  });
});
