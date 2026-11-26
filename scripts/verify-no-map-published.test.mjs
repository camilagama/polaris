import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  findPublishedMaps,
  readIgnoreRules,
} from "./verify-no-map-published.mjs";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const script = path.join(root, "scripts/verify-no-map-published.mjs");
const REAL_ASSETSIGNORE = readFileSync(
  path.join(root, "apps/web/public/.assetsignore"),
  "utf8"
);

const directories = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

/** A client build as the Vite config writes it with the browser Sentry on: hidden maps beside the scripts, and the real `.assetsignore`. */
function fakeClient(extra = {}, assetsignore = REAL_ASSETSIGNORE) {
  const directory = mkdtempSync(path.join(tmpdir(), "no-map-published-"));
  directories.push(directory);
  const files = {
    ".assetsignore": assetsignore,
    _headers: "/*\n  X-Content-Type-Options: nosniff\n",
    "assets/index-AbC123.js": "const a=1;export{a}",
    "assets/index-AbC123.js.map": JSON.stringify({
      mappings: "AAAA",
      sources: ["../../src/main.tsx"],
      version: 3,
    }),
    "assets/index-Xy9.css": "body{margin:0}",
    "assets/sentry-sdk-Q1w.js": "export const init=()=>{}",
    "assets/sentry-sdk-Q1w.js.map": JSON.stringify({
      mappings: "",
      version: 3,
    }),
    "index.html":
      "<!doctype html><script src=/assets/index-AbC123.js></script>",
    "manifest.webmanifest": JSON.stringify({ name: "Polaris" }),
    ...extra,
  };
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(directory, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  return directory;
}

const problemsOf = (directory) => findPublishedMaps(directory).problems;

describe("the committed .assetsignore", () => {
  it("keeps every source map out, at any depth, and says nothing this check cannot read", () => {
    const { isIgnored, problems } = readIgnoreRules(REAL_ASSETSIGNORE);
    expect(problems).toEqual([]);
    expect(isIgnored("assets/index-AbC123.js.map")).toBe(true);
    expect(isIgnored("index.js.map")).toBe(true);
    expect(isIgnored("assets/index-AbC123.js")).toBe(false);
  });
});

describe("the patterns of .assetsignore", () => {
  const ignored = (patterns, relative) =>
    readIgnoreRules(patterns).isIgnored(relative);

  it("matches a plain name at any depth and under a folder of that name", () => {
    expect(ignored("foo.map\n", "assets/deep/foo.map")).toBe(true);
    expect(ignored("assets\n", "assets/sub/x.js")).toBe(true);
    expect(ignored("foo.map\n", "assets/bar.map")).toBe(false);
  });

  it("anchors a pattern with a slash, and a star does not cross a folder", () => {
    expect(ignored("/assets/*.map\n", "assets/x.map")).toBe(true);
    expect(ignored("/assets/*.map\n", "assets/sub/x.map")).toBe(false);
    expect(ignored("/assets/*.map\n", "other/assets/x.map")).toBe(false);
  });

  it("skips blank lines and comments, and always leaves out the files that configure the upload", () => {
    const rules = readIgnoreRules("# kept out\n\n*.map\n");
    expect(rules.problems).toEqual([]);
    for (const file of [".assetsignore", "_headers", "_redirects"]) {
      expect(rules.isIgnored(file), file).toBe(true);
    }
  });

  it("reports, in order, each pattern it cannot read", () => {
    expect(
      readIgnoreRules("**/*.map\nfile?.map\n[ab].map\n*.map\n").problems
    ).toEqual(
      ["**/*.map", "file?.map", "[ab].map"].map(
        (line) =>
          `.assetsignore: the pattern "${line}" is not one this check reads (only plain names and * globs, no "!"); a map could be re-included by it`
      )
    );
  });
});

describe("a client build whose maps stay out of the deploy", () => {
  it("passes, counting the maps kept out", () => {
    const result = findPublishedMaps(fakeClient());
    expect(result.problems).toEqual([]);
    expect(result.ignoredMaps).toBe(2);
    expect(result.published).toBe(5);
  });

  it("is what the command line says: exit 0 and the counts", () => {
    const run = spawnSync(process.execPath, [script, fakeClient()], {
      encoding: "utf8",
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain(
      "5 files would be published, none a source map (2 maps kept out"
    );
  });
});

describe("a client build that would publish a source map fails", () => {
  it("fails when .assetsignore no longer lists the maps", () => {
    expect(problemsOf(fakeClient({}, "wrangler.json\n"))).toEqual([
      "assets/index-AbC123.js.map: a source map that would be published",
      "assets/sentry-sdk-Q1w.js.map: a source map that would be published",
    ]);
  });

  it("fails when .assetsignore is missing from the build", () => {
    const directory = fakeClient();
    rmSync(path.join(directory, ".assetsignore"));
    expect(problemsOf(directory)).toContain(
      ".assetsignore: missing from the build, so nothing keeps the source maps out of the deploy"
    );
  });

  it("fails for a map in a folder the pattern does not reach", () => {
    const build = fakeClient({ "other/app.js.map": "{}" }, "/assets/*.map\n");
    expect(problemsOf(build)).toEqual([
      "other/app.js.map: a source map that would be published",
    ]);
  });

  it("fails for a negation that would let a map back in, because the check cannot follow it", () => {
    const build = fakeClient({}, "*.map\n!assets/index-AbC123.js.map\n");
    expect(problemsOf(build)).toEqual([
      '.assetsignore: the pattern "!assets/index-AbC123.js.map" is not one this check reads (only plain names and * globs, no "!"); a map could be re-included by it',
    ]);
  });

  it("fails for a script with its map inline, which is what an inline source map build writes", () => {
    const build = fakeClient({
      "assets/index-AbC123.js":
        "const a=1;\n//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozfQ==",
    });
    expect(problemsOf(build)).toEqual([
      "assets/index-AbC123.js: carries its source map inline (sourceMappingURL=data:)",
    ]);
  });

  it("lets a script keep a sourceMappingURL comment for a file that is not there, as a vendored worker bundle does", () => {
    const build = fakeClient({
      "assets/opfs-worker-Zz1.js":
        "const a=1;\n//# sourceMappingURL=opfs-worker.js.map",
    });
    expect(problemsOf(build)).toEqual([]);
  });

  it("fails for a style sheet with its map inline", () => {
    const build = fakeClient({
      "assets/index-Xy9.css":
        "body{margin:0}\n/*# sourceMappingURL=data:application/json;base64,e30= */",
    });
    expect(problemsOf(build)).toEqual([
      "assets/index-Xy9.css: carries its source map inline (sourceMappingURL=data:)",
    ]);
  });

  it("fails for a source map published under another name", () => {
    const build = fakeClient({
      "assets/index-AbC123.json": JSON.stringify({
        mappings: "AAAA",
        sources: [],
        version: 3,
      }),
    });
    expect(problemsOf(build)).toEqual([
      "assets/index-AbC123.json: looks like a source map under another name",
    ]);
  });

  it("does not take another JSON file for a source map", () => {
    const build = fakeClient({
      "assets/data.json": JSON.stringify({ items: [1, 2], version: 3 }),
    });
    expect(problemsOf(build)).toEqual([]);
  });

  it("fails with exit 1 and names the file on the command line", () => {
    const build = fakeClient({ "assets/extra.js.map": "{}" }, "*.txt\n");
    const run = spawnSync(process.execPath, [script, build], {
      encoding: "utf8",
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("No-source-map-published check failed");
    expect(run.stderr).toContain("assets/extra.js.map");
  });

  it("fails for a folder that is not a client build, because a check that scanned nothing proves nothing", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "no-map-published-"));
    directories.push(directory);
    expect(problemsOf(directory)).toContain(
      `${directory}: no index.html, so this is not the client build of apps/web`
    );
    expect(problemsOf(path.join(directory, "missing"))).toEqual([
      `${path.join(directory, "missing")}: no build found (run the build of apps/web first)`,
    ]);
  });
});
