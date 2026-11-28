import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { __unstable__loadDesignSystem } from "tailwindcss";
import { describe, expect, it } from "vitest";
import {
  ADMIN_SHEET_OUTPUT,
  ADMIN_SHEET_SOURCE,
  buildAdminSheet,
  candidatesIn,
  themeByMedia,
} from "./admin-sheet";

/**
 * The Admin's sheet is the dash's Tailwind compiled from `apps/admin/ui/admin.source.css` (admin-sheet.ts): the file in
 * the repository is the one the script writes now, every class the Admin borrows is a class of the dash's component it
 * names, and no class the page's script puts on an element is also a class of Tailwind.
 */

const repository = fileURLToPath(new URL("../../../", import.meta.url));
const read = (path: string) => readFileSync(join(repository, path), "utf8");
const requireFromAdmin = createRequire(
  join(repository, "apps/admin/package.json")
);
/** Whether a word is a class of Tailwind, with the dash's theme. */
const isUtility = await tailwindUtility();

const COMMENT = /\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm;
const LITERAL = /"([^"\n]*)"|`([^`]*)`/g;
const INTERPOLATION = /\$\{[^}]*\}/g;

/**
 * The classes a file of the dash writes: every token of a string of two or more tokens outside the comments (a class
 * list), and a string of one token only when it is a class of Tailwind (`cn("text-section", …)`), never prose nor a
 * lone word such as `data-sidebar="content"`.
 */
function dashClasses(
  text: string,
  utility: (token: string) => boolean
): Set<string> {
  const classes = new Set<string>();
  for (const [, quoted, template] of text
    .replace(COMMENT, "")
    .matchAll(LITERAL)) {
    const tokens = (quoted ?? template ?? "")
      .replace(INTERPOLATION, " ")
      .split(WHITESPACE)
      .filter(Boolean);
    for (const token of tokens) {
      if (tokens.length > 1 || utility(token)) {
        classes.add(token);
      }
    }
  }
  return classes;
}

/** A class is the dash's when a class list has it alone or after a variant (`bg-card` in `data-active:bg-card`). */
function inFile(token: string, classes: ReadonlySet<string>): boolean {
  return (
    classes.has(token) ||
    [...classes].some((name) => name.endsWith(`:${token}`))
  );
}

interface Borrowed {
  files: string[];
  tokens: string[];
}

const WHITESPACE = /\s+/;
const LOADS = /@import|url\(|@font-face|https?:/i;
const DARK_CLASS = /\.dark\b/;
const DARK_BLOCK = /^\.dark \{/m;
const DASH_FILE = /^apps\/web\/src\//;
const APPLY = /@apply /g;
const BORROWED = /\/\* dash: ([^*]+?) \*\/\s*@apply ([^;]+);/g;

/** Each `@apply` of the source with the dash's files its comment names. */
function borrowedOf(source: string): Borrowed[] {
  return [...source.matchAll(BORROWED)].map(([, files, tokens]) => ({
    files: (files ?? "").split(" "),
    tokens: (tokens ?? "").split(WHITESPACE).filter(Boolean),
  }));
}

function notInDash({ files, tokens }: Borrowed): string[] {
  const classes = dashClasses(files.map(read).join("\n"), isUtility);
  return tokens.filter((token) => !inFile(token, classes));
}

describe("the Admin's sheet", () => {
  it(`is what the script writes now (run bun run admin:sheet after changing ${ADMIN_SHEET_SOURCE})`, async () => {
    expect(read(ADMIN_SHEET_OUTPUT)).toBe(await buildAdminSheet());
  }, 60_000);

  it("loads nothing and has the dark theme by the system, not by a class the page has no script to set", () => {
    const sheet = read(ADMIN_SHEET_OUTPUT);
    expect(sheet).not.toMatch(LOADS);
    expect(sheet).toContain("@media (prefers-color-scheme: dark)");
    expect(sheet).not.toMatch(DARK_CLASS);
  });

  it("moves each part of the dark theme, and stops when the theme changed under it (control)", () => {
    const theme = read("packages/ui/src/theme.css");
    const moved = themeByMedia(theme);
    expect(moved).not.toContain("(&:is(.dark *))");
    expect(moved).not.toMatch(DARK_BLOCK);
    expect(() =>
      themeByMedia(theme.replace("@custom-variant dark", "@custom-variant x"))
    ).toThrow("the dark variant");
    expect(() => themeByMedia(theme.replace(DARK_BLOCK, ".escuro {"))).toThrow(
      "the dark tokens"
    );
  });
});

/**
 * The declarations of the rule written with exactly this selector (alone or in a list), by selector and property:
 * a rule that was deleted, or lost the property that gives the measure, is what the layout tests below cannot see in a
 * jsdom, and the sheet test above only compares the file with its source.
 */
function declarationsOf(sheet: string, selector: string): string[] {
  const rule = sheet.match(
    new RegExp(
      `(?:^|[,{}]\\s*)${escapeRegExp(selector)}\\s*(?:,[^{}]*)?\\{([^{}]*)\\}`,
      "m"
    )
  );
  return (rule?.[1] ?? "")
    .split(";")
    .map((line) => line.trim().replace(WHITESPACE_RUN, " "))
    .filter(Boolean);
}

/** The at-rules (`@container (…)`, `@layer …`) open around the first rule with this selector, outermost first. */
function enclosingAtRules(sheet: string, selector: string): string[] {
  const at = sheet.indexOf(`${selector} {`);
  const open: string[] = [];
  let prelude = "";
  for (const char of at < 0 ? "" : sheet.slice(0, at)) {
    if (char === "{") {
      open.push(prelude.trim());
      prelude = "";
    } else if (char === "}") {
      open.pop();
      prelude = "";
    } else if (char === ";") {
      prelude = "";
    } else {
      prelude += char;
    }
  }
  return open.filter((rule) => rule.startsWith("@"));
}

const WHITESPACE_RUN = /\s+/g;
const SPECIAL = /[.*+?^${}()|[\]\\]/g;
function escapeRegExp(text: string): string {
  return text.replace(SPECIAL, "\\$&");
}

describe("the rules that give the Admin's nested area and quota rows their measure", () => {
  const sheet = read(ADMIN_SHEET_OUTPUT);

  it("keeps `.area .area` as the lowered block: a radius, the muted ground and no shadow", () => {
    expect(declarationsOf(sheet, ".area .area")).toEqual([
      "border-radius: var(--radius)",
      "background-color: var(--muted)",
      "box-shadow: none",
    ]);
  });

  it("keeps `.grid.quotas tr` as a grid of the name and three auto columns, and its cells in one line", () => {
    expect(declarationsOf(sheet, ".grid.quotas tr")).toEqual([
      "display: grid",
      "grid-template-columns: minmax(6rem, 1fr) auto auto auto",
      "align-items: baseline",
      "row-gap: 0.125rem",
    ]);
    expect(enclosingAtRules(sheet, ".grid.quotas tr")).toContain(
      "@container (max-width: 40rem)"
    );
    expect(declarationsOf(sheet, ".grid.quotas td")).toEqual(
      expect.arrayContaining([
        "display: block",
        "padding: 0",
        "white-space: nowrap",
      ])
    );
  });

  it("sees a rule that is gone or lost its property (control)", () => {
    const planted =
      "@container (max-width: 40rem) {\n  .grid.quotas tr {\n    display: grid;\n    row-gap: 0.125rem;\n  }\n}\n.area .area {\n  box-shadow: none;\n}\n";
    expect(declarationsOf(planted, ".grid.quotas tr")).toEqual([
      "display: grid",
      "row-gap: 0.125rem",
    ]);
    expect(declarationsOf(planted, ".area .area")).toEqual([
      "box-shadow: none",
    ]);
    expect(declarationsOf(planted, ".quotas tr")).toEqual([]);
    expect(enclosingAtRules(planted, ".grid.quotas tr")).toEqual([
      "@container (max-width: 40rem)",
    ]);
    expect(enclosingAtRules(planted, ".area .area")).toEqual([]);
    expect(
      declarationsOf(planted.replace("display: grid;", ""), ".grid.quotas tr")
    ).toEqual(["row-gap: 0.125rem"]);
  });
});

describe("the classes the Admin borrows from the dash", () => {
  const source = read(ADMIN_SHEET_SOURCE);
  const borrowed = borrowedOf(source);

  it("are many, each from a file of the dash that exists, and every @apply of the source names its files", () => {
    expect(borrowed.length).toBeGreaterThan(15);
    expect(source.match(APPLY)).toHaveLength(borrowed.length);
    for (const { files } of borrowed) {
      for (const file of files) {
        expect(file).toMatch(DASH_FILE);
        expect(() => read(file)).not.toThrow();
      }
    }
  });

  it("are, in the sheet, each a class of the component the comment names", () => {
    expect(
      borrowed
        .map((entry) => ({
          missing: notInDash(entry),
          tokens: entry.tokens[0],
        }))
        .filter((entry) => entry.missing.length > 0)
    ).toEqual([]);
  });

  it("reads only class lists of the dash: a word of a comment or a lone attribute value is no class (control)", () => {
    const classes = dashClasses(
      '/* the content */\n<div data-sidebar="content" className="flex min-h-0" />',
      isUtility
    );
    expect(inFile("content", classes)).toBe(false);
    expect(inFile("min-h-0", classes)).toBe(true);
  });

  it("would see a class the dash does not have (control)", () => {
    const planted = borrowedOf(
      "/* dash: apps/web/src/ui/button.tsx */\n@apply h-ctl-md rounded-[3px];"
    );
    expect(planted.map(notInDash)).toEqual([["rounded-[3px]"]]);
  });
});

/**
 * The class strings of the shell in page.ts and what in each is the Admin's own (the dash has no `<details>`: its menus
 * are Base UI components). The list is exact: a class that leaves the shell or comes from the dash leaves it too.
 */
const SHELL_FILES = [
  "apps/web/src/app-shell/screen-title.tsx",
  "apps/web/src/ui/title-class.ts",
  "apps/web/src/ui/sidebar.tsx",
  "apps/web/src/app-shell/app-shell.tsx",
  "apps/web/src/app-shell/shell-header.tsx",
  "apps/web/src/ui/badge.tsx",
  "apps/web/src/ui/dropdown-menu.tsx",
];
const ADMIN_OWN: Readonly<Record<string, readonly string[]>> = {
  ACCOUNT_AVATAR: [],
  ACCOUNT_BUTTON: [
    "h-10",
    "max-w-[18rem]",
    "[&::-webkit-details-marker]:hidden",
  ],
  ACCOUNT_EMAIL: [],
  ACCOUNT_ITEM: [],
  ACCOUNT_MENU: [],
  ACCOUNT_POPUP: ["top-full", "mt-1", "w-64", "max-w-[calc(100vw-1rem)]"],
  BADGE: [],
  BRAND: [],
  BRAND_ROW: [],
  COMPACT_ENV: ["compact-env"],
  COMPACT_MENU: ["compact-menu"],
  CURRENT_DOT: [],
  HEADER: [],
  HEADER_BRAND: [],
  HEADER_BUTTON: [
    "size-10",
    "[&::-webkit-details-marker]:hidden",
    "[&_svg]:size-4.5",
  ],
  HEADER_END: [],
  HEADER_ROW: ["md:pl-6"],
  MAIN: [
    "content",
    "w-[min(100%_-_2rem,72rem)]",
    "pt-[clamp(1.5rem,5vw,4.25rem)]",
  ],
  MOBILE_MENU: ["top-full", "max-h-[calc(100dvh-var(--app-header))]"],
  PANEL: [],
  SHELL: [],
  SIDEBAR: [],
  SIDEBAR_CONTAINER: ["h-svh"],
  SIDEBAR_CONTENT: [],
  SIDEBAR_GAP: [],
  SIDEBAR_GROUP: [],
  SIDEBAR_GROUP_CONTENT: [],
  SIDEBAR_GROUP_LABEL: [],
  SIDEBAR_HEADER: [],
  SIDEBAR_INNER: [],
  SIDEBAR_INSET: [],
  SIDEBAR_MENU: [],
  SIDEBAR_MENU_BUTTON: [],
  SIDEBAR_MENU_ITEM: [],
  SKIP_LINK: [],
  TITLE: [],
};

const CLASS_CONSTANT = /^const ([A-Z_]+) =\s*"([^"]+)";/gm;

function shellClasses(page: string): Record<string, string[]> {
  return Object.fromEntries(
    [...page.matchAll(CLASS_CONSTANT)].map(([, name, value]) => [
      name,
      (value ?? "").split(" "),
    ])
  );
}

describe("the shell of the Admin's page", () => {
  const classes = shellClasses(read("apps/admin/src/ui/page.ts"));
  const dash = dashClasses(SHELL_FILES.map(read).join("\n"), isUtility);

  it("has the class strings of the list, and only them", () => {
    expect(Object.keys(classes).sort()).toEqual(Object.keys(ADMIN_OWN).sort());
  });

  it("writes the dash's classes, and as the Admin's own exactly the ones listed", () => {
    expect(
      Object.fromEntries(
        Object.entries(classes).map(([name, tokens]) => [
          name,
          tokens.filter((token) => !inFile(token, dash)),
        ])
      )
    ).toEqual(ADMIN_OWN);
  });
});

/** Every file of the page's script but the tests. */
function scriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return scriptFiles(path);
    }
    return entry.name.endsWith(".ts") && !entry.name.includes("test")
      ? [relative(repository, path)]
      : [];
  });
}

function scriptClasses(sources: readonly string[]): string[] {
  const classes = new Set<string>();
  for (const source of sources) {
    for (const [, value] of source.matchAll(/\bclass: "([^"]*)"/g)) {
      for (const name of (value ?? "").split(" ").filter(Boolean)) {
        classes.add(name);
      }
    }
  }
  return [...classes].sort();
}

async function tailwindUtility() {
  const tailwind = join(repository, "apps/web/node_modules/tailwindcss");
  const stylesheetOf = (id: string, base: string) => {
    if (id.startsWith("tailwindcss/")) {
      return join(tailwind, id.slice("tailwindcss/".length));
    }
    if (id.startsWith("@polaris/")) {
      return requireFromAdmin.resolve(id);
    }
    return join(base, id);
  };
  const design = await __unstable__loadDesignSystem(
    '@import "tailwindcss/theme.css";\n@import "tailwindcss/utilities.css";\n@import "@polaris/ui/theme.css";',
    {
      base: join(repository, "apps/admin/ui"),
      loadStylesheet: (id, base) => {
        const path = stylesheetOf(id, base);
        return Promise.resolve({
          base: dirname(path),
          content: readFileSync(path, "utf8"),
          path,
        });
      },
    }
  );
  return (token: string) => design.candidatesToCss([token])[0] !== null;
}

describe("the classes of the page's script", () => {
  it("are not classes of Tailwind that the shell writes, so the sheet has no utility for them (sr-only is the same rule)", () => {
    const classes = scriptClasses(
      scriptFiles(join(repository, "apps/admin/ui")).map(read)
    );
    const page = read("apps/admin/src/ui/page.ts");
    const generated = (text: string) => {
      const words = new Set(candidatesIn(text));
      return classes.filter((name) => isUtility(name) && words.has(name));
    };
    expect(classes.length).toBeGreaterThan(50);
    expect(generated(page)).toEqual(["sr-only"]);
    // control: the tables' class, `grid`, is one of Tailwind's, and a shell that wrote it would give them `display: grid`
    expect(generated(`${page}\nconst X = "grid size-8";`)).toEqual([
      "grid",
      "sr-only",
    ]);
  });
});
