import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LEGAL_PATHS } from "@polaris/domain/legal/legal-documents";
import { describe, expect, it } from "vitest";
import {
  ATTENTION_NAV_ITEM,
  entryPageFor,
  legacyAddress,
  NAV_ITEMS,
  resolveRoute,
  SCREEN_TABS,
  type TabScreenId,
  tabHref,
} from "../src/app-shell/navigation-model";
import { isClosedStorePath } from "../src/lib/closed-store-path";
import { isLegalAcceptancePath } from "../src/lib/legal-acceptance";

/**
 * The feature map of the verification skill (`.claude/skills/verify-polaris/features/`) names every address the app
 * opens in the deployed build: each route of the shell, each tab (`<screen>?aba=`), each page outside the shell
 * (sign-in, legal, acceptance) and each old address that now opens a tab. A route added to the router without a
 * line in a destination file fails here, so an agent that reads the map never meets a screen it does not know how
 * to reach. No exclusion list. The labs of main.tsx (`/offline-*-lab`, `/ui-galeria`) are not routes of the
 * deployed build (only the dev, offline-poc and pwa-e2e builds open them) and are not read.
 *
 * The tables of the router are private to navigation-model.ts and legal-acceptance.ts: their keys are read from the
 * source, counted against a second marker of the same table, and checked against the exported resolvers, so a
 * reading that drifts from the code fails. The index (README.md) does not count as mapping an address: each
 * address must be in a destination file, and each destination file keeps the four sections of the map.
 */
const web = fileURLToPath(new URL("..", import.meta.url));
const featuresDir = join(web, "../../.claude/skills/verify-polaris/features");
const navigationSource = readFileSync(
  join(web, "src/app-shell/navigation-model.ts"),
  "utf8"
);
const acceptanceSource = readFileSync(
  join(web, "src/lib/legal-acceptance.ts"),
  "utf8"
);

const closedStoreSource = readFileSync(
  join(web, "src/lib/closed-store-path.ts"),
  "utf8"
);

const KEY = /^\s*"(\/[^"]*)":/gm;
const ANY_KEY = /^\s*(?:"[^"]*"|'[^']*'|[\w$]+|\[[^\]]+\]):/gm;
const ACCEPTANCE = /const LEGAL_ACCEPTANCE_PATH = "(\/[^"]*)";/;
const CLOSED_STORE = /const CLOSED_STORE_PATH = "(\/[^"]*)";/;
const ENTRY_IDS = /export type EntryPageId =([^;]*);/;
const UNION_MEMBER = /\| "/g;
const H2 = /^## (.+)$/gm;
const H1 = /^# (.+)$/m;
const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g;
const SECTIONS = [
  "Sub-features",
  "How to get to it (user POV)",
  "Driving it with verify.sh (Playwright)",
  "Gotchas",
];

/** The body of the object literal `const <name> ... = { ... };` of a source file, or "" when there is none. */
function objectBody(source: string, name: string): string {
  // from after the opening brace: the type annotation (`Record<string, { path: string }>`) is not the table
  const opening = new RegExp(`const ${name}\\b[^=]*= ?\\{`).exec(source);
  if (!opening) {
    return "";
  }
  const start = opening.index + opening[0].length;
  const end = source.indexOf("\n};", start);
  return source.slice(start, end < 0 ? undefined : end);
}

/** The quoted path keys of a table, and how many keys of any shape its top level has (to catch one not read). */
function tableKeys(source: string, name: string) {
  const body = objectBody(source, name);
  const topLevel = body
    .split("\n")
    .filter((line) => line.startsWith("  ") && !line.startsWith("   "))
    .join("\n");
  return {
    keys: [...body.matchAll(KEY)].map((match) => match[1] as string),
    shapes: topLevel.match(ANY_KEY)?.length ?? 0,
  };
}

/** A path is mapped when it stands as a code span, alone or with a query: `/sales` does not count for `/sales/x`. */
function mentionsPath(text: string, path: string): boolean {
  const escaped = path.replace(REGEX_SPECIAL, "\\$&");
  return new RegExp(`\`${escaped}(?:[?#][^\`]*)?\``).test(text);
}

/** A tab is mapped when a code span opens with its screen's path and its `?aba=`, nothing glued to the value. */
function mentionsTab(text: string, path: string, value: string): boolean {
  const escaped = `${path}?aba=${value}`.replace(REGEX_SPECIAL, "\\$&");
  return new RegExp(`\`${escaped}(?:[&#][^\`]*)?\``).test(text);
}

interface Tab {
  path: string;
  value: string;
}

function missingFromMap(
  text: string,
  paths: readonly string[],
  tabs: readonly Tab[]
): string[] {
  return [
    ...paths.filter((path) => !mentionsPath(text, path)),
    ...tabs
      .filter((tab) => !mentionsTab(text, tab.path, tab.value))
      .map((tab) => `${tab.path}?aba=${tab.value}`),
  ];
}

/** What breaks the contract of a destination file: the four H2 in order, the drive starting with its preconditions. */
function contractFaults(name: string, text: string): string[] {
  const faults: string[] = [];
  if (!H1.test(text)) {
    faults.push(`${name}: no H1`);
  }
  const sections = [...text.matchAll(H2)].map((match) => match[1]);
  if (JSON.stringify(sections) !== JSON.stringify(SECTIONS)) {
    faults.push(`${name}: sections ${JSON.stringify(sections)}`);
  }
  const drive = text.split(`## ${SECTIONS[2]}`)[1] ?? "";
  if (!drive.trimStart().startsWith("Preconditions:")) {
    faults.push(`${name}: the drive section does not open with Preconditions:`);
  }
  return faults;
}

const shellRoutes = tableKeys(navigationSource, "ROUTES");
const entryPages = tableKeys(navigationSource, "ENTRY_PAGES");
const legacyAddresses = tableKeys(navigationSource, "LEGACY_ADDRESSES");
const acceptancePath = ACCEPTANCE.exec(acceptanceSource)?.[1];
const closedStorePath = CLOSED_STORE.exec(closedStoreSource)?.[1];
const entryIds =
  ENTRY_IDS.exec(navigationSource)?.[1]?.match(UNION_MEMBER)?.length ?? 0;
const appTabs: Tab[] = (Object.keys(SCREEN_TABS) as TabScreenId[]).flatMap(
  (screen) =>
    SCREEN_TABS[screen].map((tab) => ({
      path: new URL(tabHref(screen, tab.value), "https://polaris.invalid")
        .pathname,
      value: tab.value,
    }))
);

const destinationFiles = readdirSync(featuresDir)
  .filter((file) => file.endsWith(".md") && file !== "README.md")
  .sort()
  .map((file) => ({
    file,
    text: readFileSync(join(featuresDir, file), "utf8"),
  }));
const destinationsText = destinationFiles.map(({ text }) => text).join("\n");

describe("the router read from the source is the router the app resolves", () => {
  it("every key of each table is read: as many path keys as keys of any shape, and as many as its second marker", () => {
    const routesBody = objectBody(navigationSource, "ROUTES");
    const legacyBody = objectBody(navigationSource, "LEGACY_ADDRESSES");
    expect(shellRoutes.keys.length).toBeGreaterThan(0);
    expect(shellRoutes.keys).toHaveLength(shellRoutes.shapes);
    expect(shellRoutes.keys).toHaveLength(
      routesBody.match(/\bscreen:/g)?.length ?? 0
    );
    expect(legacyAddresses.keys.length).toBeGreaterThan(0);
    expect(legacyAddresses.keys).toHaveLength(legacyAddresses.shapes);
    expect(legacyAddresses.keys).toHaveLength(
      legacyBody.match(/\bpath:/g)?.length ?? 0
    );
    expect(entryPages.keys.length).toBeGreaterThan(0);
    expect(entryPages.keys).toHaveLength(entryPages.shapes);
    expect(entryPages.keys).toHaveLength(entryIds);
  });

  it("every route of the shell resolves to a page, and the menu links are among them", () => {
    for (const path of shellRoutes.keys) {
      expect(resolveRoute(path).kind, path).toBe("page");
    }
    for (const item of [...NAV_ITEMS, ATTENTION_NAV_ITEM]) {
      expect(shellRoutes.keys).toContain(item.href);
    }
  });

  it("every page of the sign-in group, old address, the acceptance path and the closed store's panel is one the app opens", () => {
    for (const path of entryPages.keys) {
      expect(entryPageFor(path), path).not.toBeNull();
    }
    for (const path of legacyAddresses.keys) {
      expect(legacyAddress(path, "", ""), path).not.toBeNull();
    }
    expect(acceptancePath && isLegalAcceptancePath(acceptancePath)).toBe(true);
    expect(closedStorePath && isClosedStorePath(closedStorePath)).toBe(true);
  });
});

describe("the feature map of verify-polaris names every address of the app", () => {
  it("lists, in a destination file, every route, tab, page outside the shell and old address", () => {
    const paths = [
      ...shellRoutes.keys,
      ...entryPages.keys,
      ...legacyAddresses.keys,
      ...Object.values(LEGAL_PATHS),
      acceptancePath as string,
      closedStorePath as string,
    ];
    expect(missingFromMap(destinationsText, paths, appTabs)).toEqual([]);
  });

  it("has the index and one file for each of the eight destinations of the menu, titled by it", () => {
    expect(readdirSync(featuresDir)).toContain("README.md");
    const titles = destinationFiles.map(({ text }) => H1.exec(text)?.[1] ?? "");
    for (const item of NAV_ITEMS) {
      expect(
        titles.filter((title) => title.startsWith(item.label)),
        item.label
      ).toHaveLength(1);
    }
  });

  it("keeps the four sections of the map in every destination file", () => {
    expect(destinationFiles.length).toBeGreaterThanOrEqual(NAV_ITEMS.length);
    expect(
      destinationFiles.flatMap(({ file, text }) => contractFaults(file, text))
    ).toEqual([]);
  });
});

describe("control cases: a map that misses an address fails", () => {
  const map = "Abra `/sales/history` e `/products?aba=categorias`.";
  const categories = { path: "/products", value: "categorias" };

  it("a path only inside a longer one is missing", () => {
    expect(missingFromMap(map, ["/sales", "/sales/history"], [])).toEqual([
      "/sales",
    ]);
  });

  it("a path outside a code span is missing", () => {
    expect(
      missingFromMap("Abra /customers no menu.", ["/customers"], [])
    ).toEqual(["/customers"]);
  });

  it("a tab under another screen, or whose value is the start of another, is missing", () => {
    expect(missingFromMap(map, [], [categories])).toEqual([]);
    expect(
      missingFromMap("`/dashboard?aba=categorias`", [], [categories])
    ).toEqual(["/products?aba=categorias"]);
    expect(
      missingFromMap(
        "`/configuracoes?aba=formas-de-receber`",
        [],
        [{ path: "/configuracoes", value: "formas" }]
      )
    ).toEqual(["/configuracoes?aba=formas"]);
  });

  it("an address only in the index does not count", () => {
    const readme = readFileSync(join(featuresDir, "README.md"), "utf8");
    expect(mentionsPath(readme, "/sales/history")).toBe(true);
    expect(missingFromMap("", ["/sales/history"], [])).toEqual([
      "/sales/history",
    ]);
  });

  it("a route added to the source is read and missing; a key the reading skips breaks the count", () => {
    const planted = navigationSource.replace(
      '"/": { navId: "home"',
      '"/nova-tela": { navId: null, screen: "home", title: "Nova" },\n  "/": { navId: "home"'
    );
    expect(planted).not.toBe(navigationSource);
    const read = tableKeys(planted, "ROUTES");
    expect(read.keys).toContain("/nova-tela");
    expect(missingFromMap(destinationsText, read.keys, [])).toEqual([
      "/nova-tela",
    ]);
    const unread = tableKeys(
      navigationSource.replace(
        '"/": { navId: "home"',
        '\'/nova-tela\': { navId: null, screen: "home", title: "Nova" },\n  "/": { navId: "home"'
      ),
      "ROUTES"
    );
    expect(unread.keys.length).not.toBe(unread.shapes);
    expect(tableKeys(navigationSource, "NO_SUCH_TABLE")).toEqual({
      keys: [],
      shapes: 0,
    });
  });

  it("a destination file without a section, out of order or without preconditions breaks the contract", () => {
    const good = destinationFiles[0]?.text ?? "";
    expect(contractFaults("good.md", good)).toEqual([]);
    expect(
      contractFaults(
        "sem-gotchas.md",
        good.replace("## Gotchas", "## Armadilhas")
      )
    ).toHaveLength(1);
    expect(
      contractFaults(
        "sem-pre.md",
        good.replace("Preconditions:", "Antes de tudo:")
      )
    ).toHaveLength(1);
  });
});
