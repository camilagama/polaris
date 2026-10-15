import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * Which expensive CI jobs a change can affect. The browser gate costs about
 * nine minutes a run, so it only runs when something it exercises changed; the
 * dependency audit only when dependencies changed. Everything unknown runs.
 */

/**
 * Paths that cannot change what the browser gate proves: prose; the database
 * package; and the web app's server, Worker and gate scripts. The gate serves
 * the static client bundle and answers the `/rpc` calls itself (page.route), so
 * none of that code runs in it, and the client never imports it.
 */
const BROWSER_IRRELEVANT = [
  /^docs\//,
  /^doc\//,
  /\.md$/,
  /^packages\/db\//,
  /^apps\/web\/(src\/server|worker|scripts)\//,
];

/** Files that can change which dependencies are installed. */
const DEPENDENCY_FILES = [
  /(^|\/)package\.json$/,
  /^bun\.lock$/,
  /^\.bun-version$/,
  /^\.node-version$/,
];

/**
 * `files` is the list of changed paths, or null when it could not be
 * determined (then everything runs).
 */
export function classifyChanges(files) {
  if (files === null) {
    return { browser: true, dependencies: true };
  }
  const changed = files.filter(Boolean);
  return {
    browser: changed.some(
      (file) => !BROWSER_IRRELEVANT.some((pattern) => pattern.test(file))
    ),
    dependencies: changed.some((file) =>
      DEPENDENCY_FILES.some((pattern) => pattern.test(file))
    ),
  };
}

/** The paths changed by the commit under test against its first parent (the base of a pull request merge). */
function changedFiles() {
  const result = spawnSync("git", ["diff", "--name-only", "HEAD^1", "HEAD"], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    return null;
  }
  return result.stdout.split("\n");
}

function main() {
  const manual = process.env.GITHUB_EVENT_NAME === "workflow_dispatch";
  const result = manual
    ? { browser: true, dependencies: true }
    : classifyChanges(changedFiles());
  const lines = Object.entries(result).map(
    ([name, value]) => `${name}=${value}`
  );
  console.log(lines.join("\n"));
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
