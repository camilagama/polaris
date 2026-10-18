import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The plan asks for "zero dependency circular" between packages and modules.
 * Knip does not detect cycles, so this script builds the runtime import graph
 * (type-only imports are erased and ignored) of every workspace source folder
 * and fails when a strongly connected component has more than one file.
 * Workspace package specifiers (`@polaris/<name>/<subpath>`) are resolved
 * through each package's `exports` map.
 */
const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const sourceExtensions = [".ts", ".tsx"];
const ignoredFolders = new Set([
  "node_modules",
  "dist",
  ".wrangler",
  "drizzle",
  "scripts",
  "e2e",
]);
const workspaceSpecifier = /^(@polaris\/[^/]+)(?:\/(.+))?$/;
const sourceSuffix = /\.tsx?$/;
const importPattern =
  /(?:^|\n)\s*(?:import|export)\s+(type\s+)?(?:[^"'`;]*?\sfrom\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

function walk(directory, found) {
  for (const entry of readdirSync(directory)) {
    if (ignoredFolders.has(entry)) {
      continue;
    }
    const full = path.join(directory, entry);
    if (statSync(full).isDirectory()) {
      walk(full, found);
    } else if (
      sourceExtensions.includes(path.extname(full)) &&
      !full.endsWith(".test.ts") &&
      !full.endsWith(".test.tsx") &&
      !full.endsWith(".d.ts") &&
      // generated files omit semicolons, which the import scan below needs to tell statements apart
      !full.endsWith(".gen.ts")
    ) {
      found.push(full);
    }
  }
}

const workspaceRoots = [];
for (const group of ["packages", "apps"]) {
  for (const name of readdirSync(path.join(root, group))) {
    const folder = path.join(root, group, name);
    if (statSync(folder).isDirectory()) {
      workspaceRoots.push(folder);
    }
  }
}

const exportsByPackage = new Map();
for (const folder of workspaceRoots) {
  try {
    const manifest = JSON.parse(
      readFileSync(path.join(folder, "package.json"), "utf8")
    );
    if (manifest.name?.startsWith("@polaris/")) {
      exportsByPackage.set(manifest.name, {
        exports: manifest.exports ?? {},
        folder,
      });
    }
  } catch {
    // a folder without a manifest is not a package
  }
}

const files = [];
for (const folder of workspaceRoots) {
  for (const sub of ["src", "worker", "poc"]) {
    const candidate = path.join(folder, sub);
    try {
      if (statSync(candidate).isDirectory()) {
        walk(candidate, files);
      }
    } catch {
      // optional folder
    }
  }
}
const fileSet = new Set(files);

function withExtension(base) {
  for (const extension of sourceExtensions) {
    if (fileSet.has(base + extension)) {
      return base + extension;
    }
    if (fileSet.has(path.join(base, `index${extension}`))) {
      return path.join(base, `index${extension}`);
    }
  }
  return fileSet.has(base) ? base : null;
}

function resolveSpecifier(from, specifier) {
  if (specifier.startsWith(".")) {
    return withExtension(path.resolve(path.dirname(from), specifier));
  }
  const match = workspaceSpecifier.exec(specifier);
  if (!match) {
    return null;
  }
  const entry = exportsByPackage.get(match[1]);
  if (!entry) {
    return null;
  }
  const key = match[2] ? `./${match[2]}` : ".";
  const target = entry.exports[key];
  const resolved = typeof target === "string" ? target : target?.default;
  return resolved
    ? withExtension(
        path.resolve(entry.folder, resolved).replace(sourceSuffix, "")
      )
    : null;
}

const graph = new Map();
for (const file of files) {
  const source = readFileSync(file, "utf8");
  const targets = new Set();
  for (const match of source.matchAll(importPattern)) {
    const isTypeOnly = Boolean(match[1]);
    const specifier = match[2] ?? match[3];
    if (isTypeOnly || !specifier) {
      continue;
    }
    const resolved = resolveSpecifier(file, specifier);
    if (resolved && resolved !== file) {
      targets.add(resolved);
    }
  }
  graph.set(file, [...targets]);
}

// Tarjan's strongly connected components.
let counter = 0;
const indexOf = new Map();
const lowlink = new Map();
const onStack = new Set();
const stack = [];
const cycles = [];

function connect(node) {
  indexOf.set(node, counter);
  lowlink.set(node, counter);
  counter += 1;
  stack.push(node);
  onStack.add(node);
  for (const next of graph.get(node) ?? []) {
    if (!indexOf.has(next)) {
      connect(next);
      lowlink.set(node, Math.min(lowlink.get(node), lowlink.get(next)));
    } else if (onStack.has(next)) {
      lowlink.set(node, Math.min(lowlink.get(node), indexOf.get(next)));
    }
  }
  if (lowlink.get(node) === indexOf.get(node)) {
    const component = [];
    let member;
    do {
      member = stack.pop();
      onStack.delete(member);
      component.push(member);
    } while (member !== node);
    if (component.length > 1) {
      cycles.push(component);
    }
  }
}

for (const node of graph.keys()) {
  if (!indexOf.has(node)) {
    connect(node);
  }
}

if (cycles.length > 0) {
  console.error("Circular runtime imports found:");
  for (const cycle of cycles) {
    console.error(
      `- ${cycle.map((file) => path.relative(root, file)).join("\n  -> ")}`
    );
  }
  process.exit(1);
}
console.log(`No circular runtime imports across ${files.length} source files.`);
