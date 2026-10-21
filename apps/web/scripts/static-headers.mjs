// The headers a Cloudflare `_headers` file gives a path, as Workers Static Assets applies them: every rule
// whose path matches (exact, or with `*` for any run of characters), in file order; a `! Name` line drops
// that header as set by an earlier rule. Used by serve-static.mjs, so the browser checks get the real CSP.

const INDENTED = /^\s/;

/** The rules of a Cloudflare `_headers` file: a path (exact or with `*`) and its header lines. */
export function parseHeadersFile(text) {
  const rules = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) {
      continue;
    }
    if (INDENTED.test(line)) {
      rules.at(-1)?.lines.push(line.trim());
    } else {
      rules.push({ lines: [], path: line.trim() });
    }
  }
  return rules;
}

const matches = (rule, pathname) =>
  new RegExp(
    `^${rule
      .split("*")
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*")}$`
  ).test(pathname);

/** The headers of a path: every matching rule in file order; `! Name` drops what came before. */
export function headersForPath(rules, pathname) {
  const headers = new Map();
  for (const rule of rules.filter((item) => matches(item.path, pathname))) {
    for (const line of rule.lines) {
      if (line.startsWith("!")) {
        headers.delete(line.slice(1).trim().toLowerCase());
        continue;
      }
      const colon = line.indexOf(":");
      const name = line.slice(0, colon).trim().toLowerCase();
      const value = line.slice(colon + 1).trim();
      headers.set(
        name,
        headers.has(name) ? `${headers.get(name)}, ${value}` : value
      );
    }
  }
  return Object.fromEntries(headers);
}
