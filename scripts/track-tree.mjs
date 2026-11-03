import { execFileSync } from "node:child_process";
import { gitEnvironment } from "./exact-count-list.mjs";

/**
 * Turns a planted fixture folder into a git repository with every file in the index, so a check that
 * lists files through git sees the tree. `-f` keeps files under folders such as node_modules, which
 * the check must still skip by name.
 */
export function trackTree(base) {
  for (const args of [
    ["init", "-q"],
    ["add", "-f", "."],
  ]) {
    execFileSync("git", args, {
      cwd: base,
      env: gitEnvironment(),
      stdio: "pipe",
    });
  }
}
