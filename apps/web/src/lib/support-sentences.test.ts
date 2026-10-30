import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SOURCE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SOURCE_FILE = /\.(ts|tsx)$/;
const TEST_FILE = /\.test\.tsx?$/;
const MENTIONS_SUPPORT = /suporte/iu;
/** `via: "suporte"` is a value of the contract, not a sentence: only the whole quoted word is set aside. */
const THE_BARE_VALUE = /(["'`])suporte\1/gu;
const READS_THE_SOURCE =
  /^import\s[^;]*from\s+["'](?:\.{1,2}\/)+(?:lib\/)?support-contact["'];?$/mu;

/** The server has its own box and the legal texts fill theirs at build time: neither is a sentence of the app. */
const OUT_OF_THE_APP = [/^server\//u, /^legal\/content\//u];

/**
 * The files that say "suporte" and do not read the address: they only tell a fact ("o nosso suporte") and send nobody
 * to write. Exact paths, and the test below keeps the list honest.
 */
const SAYS_SUPPORT_WITHOUT_AN_ADDRESS: readonly string[] = [
  "subscription/subscription-model.ts",
];

const mentionsSupport = (text: string) =>
  MENTIONS_SUPPORT.test(text.replaceAll(THE_BARE_VALUE, ""));

interface SourceFile {
  path: string;
  text: string;
}

function unsourcedSupportSentences(
  files: readonly SourceFile[],
  exempt: readonly string[]
): string[] {
  return files
    .filter(
      ({ path, text }) =>
        mentionsSupport(text) &&
        !READS_THE_SOURCE.test(text) &&
        !exempt.includes(path)
    )
    .map(({ path }) => path);
}

function sourceFiles(directory: string): SourceFile[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(path);
    }
    if (!SOURCE_FILE.test(entry.name) || TEST_FILE.test(entry.name)) {
      return [];
    }
    return [
      {
        path: relative(SOURCE_ROOT, path).replaceAll("\\", "/"),
        text: readFileSync(path, "utf8"),
      },
    ];
  });
}

describe("the sentences that send the person to the support (AC-4)", () => {
  const files = sourceFiles(SOURCE_ROOT).filter(
    ({ path }) => !OUT_OF_THE_APP.some((place) => place.test(path))
  );

  it("finds the files of the app, and the ones that mention the support are these", () => {
    expect(files.length).toBeGreaterThan(100);
    const mentioning = files
      .filter(({ text }) => mentionsSupport(text))
      .map(({ path }) => path)
      .sort();
    expect(mentioning).toEqual([
      "help/help-page.tsx",
      "organization/organization-setup-model.ts",
      "sign-in/entry-ui.tsx",
      "subscription/subscription-commands-model.ts",
      "subscription/subscription-model.ts",
    ]);
  });

  it("every file that mentions the support reads the address from lib/support-contact", () => {
    expect(
      unsourcedSupportSentences(files, SAYS_SUPPORT_WITHOUT_AN_ADDRESS)
    ).toEqual([]);
  });

  it("keeps in the exempt list only files that say 'suporte' and do not read the source", () => {
    for (const path of SAYS_SUPPORT_WITHOUT_AN_ADDRESS) {
      const file = files.find((item) => item.path === path);
      expect(file, path).toBeDefined();
      expect(mentionsSupport(file?.text ?? ""), path).toBe(true);
      expect(READS_THE_SOURCE.test(file?.text ?? ""), path).toBe(false);
    }
  });

  describe("controls: what the scan must stop", () => {
    const sentence = 'const text = "Fale com o suporte.";';

    it("a new sentence that cites the support without the source is found", () => {
      expect(
        unsourcedSupportSentences(
          [{ path: "sales/new-text.ts", text: sentence }],
          SAYS_SUPPORT_WITHOUT_AN_ADDRESS
        )
      ).toEqual(["sales/new-text.ts"]);
    });

    it("the same sentence in a file that reads the source passes", () => {
      const source = 'import { SUPPORT_EMAIL } from "../lib/support-contact";';
      expect(
        unsourcedSupportSentences(
          [{ path: "sales/new-text.ts", text: `${source}\n${sentence}` }],
          SAYS_SUPPORT_WITHOUT_AN_ADDRESS
        )
      ).toEqual([]);
    });

    it("an import of another module, one of a similar name, or a comment does not count as the source", () => {
      for (const other of [
        'import { SUPPORT_EMAIL } from "../lib/support-contact-copy";',
        'import { SUPPORT_EMAIL } from "../lib/other";',
        '// import { SUPPORT_EMAIL } from "../lib/support-contact";',
        'const text = "import x from \\"../lib/support-contact\\"";',
      ]) {
        expect(
          unsourcedSupportSentences(
            [{ path: "sales/new-text.ts", text: `${other}\n${sentence}` }],
            SAYS_SUPPORT_WITHOUT_AN_ADDRESS
          ),
          other
        ).toEqual(["sales/new-text.ts"]);
      }
    });

    it("the exemption is by exact path: a file of the same name elsewhere is found", () => {
      expect(
        unsourcedSupportSentences(
          [{ path: "sales/subscription-model.ts", text: sentence }],
          SAYS_SUPPORT_WITHOUT_AN_ADDRESS
        )
      ).toEqual(["sales/subscription-model.ts"]);
    });

    it("the bare value of the contract is no sentence, but a sentence around it is", () => {
      expect(
        unsourcedSupportSentences(
          [{ path: "a.ts", text: 'const via = refund.via === "suporte";' }],
          []
        )
      ).toEqual([]);
      expect(
        unsourcedSupportSentences(
          [{ path: "a.ts", text: 'const t = "Fale com o suporte";' }],
          []
        )
      ).toEqual(["a.ts"]);
    });

    it("another case of the word is found as well", () => {
      expect(
        unsourcedSupportSentences(
          [{ path: "a.ts", text: 'const t = "Fale com o SUPORTE";' }],
          []
        )
      ).toEqual(["a.ts"]);
    });
  });
});
