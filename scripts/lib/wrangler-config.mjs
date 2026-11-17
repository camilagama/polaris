import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/** Reading of the `wrangler.jsonc` of the three Workers and of what a build generates, shared by the deploy checks. */

export const WORKERS = ["web", "catalog", "admin"];

/**
 * Calls `visit(char, index)` for every character outside a string literal and copies string literals
 * as they are; `visit` returns how many characters it consumed and what to write.
 */
function scanOutsideStrings(text, visit) {
  let out = "";
  let index = 0;
  while (index < text.length) {
    if (text[index] === '"') {
      const start = index;
      index += 1;
      while (index < text.length && text[index] !== '"') {
        index += text[index] === "\\" ? 2 : 1;
      }
      index += 1;
      out += text.slice(start, index);
    } else {
      const { length, write } = visit(text[index], index);
      out += write;
      index += length;
    }
  }
  return out;
}

const NEXT_NON_SPACE = /\S/g;

/** JSON with comments and trailing commas (the wrangler.jsonc format), without touching strings. */
export function parseJsonc(text) {
  const withoutComments = scanOutsideStrings(text, (char, index) => {
    if (char === "/" && text[index + 1] === "/") {
      const end = text.indexOf("\n", index);
      return { length: (end === -1 ? text.length : end) - index, write: "" };
    }
    if (char === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2);
      if (end === -1) {
        throw new Error("unterminated comment");
      }
      return { length: end + 2 - index, write: "" };
    }
    return { length: 1, write: char };
  });
  const withoutTrailingCommas = scanOutsideStrings(
    withoutComments,
    (char, index) => {
      if (char !== ",") {
        return { length: 1, write: char };
      }
      NEXT_NON_SPACE.lastIndex = index + 1;
      const next = NEXT_NON_SPACE.exec(withoutComments)?.[0];
      return { length: 1, write: next === "}" || next === "]" ? "" : char };
    }
  );
  return JSON.parse(withoutTrailingCommas);
}

/** The resources a config binds, by binding name. */
export function bindingsOf(config) {
  const hyperdrive = new Map(
    (config.hyperdrive ?? []).map((item) => [item.binding, item.id])
  );
  const buckets = new Map(
    (config.r2_buckets ?? []).map((item) => [item.binding, item.bucket_name])
  );
  const producers = new Map(
    (config.queues?.producers ?? []).map((item) => [item.binding, item.queue])
  );
  const consumers = (config.queues?.consumers ?? []).flatMap((item) =>
    [item.queue, item.dead_letter_queue].filter(Boolean)
  );
  const ratelimits = new Map(
    (config.ratelimits ?? []).map((item) => [
      item.name,
      String(item.namespace_id),
    ])
  );
  const images = config.images?.binding ? [config.images.binding] : [];
  return {
    buckets,
    consumers,
    hyperdrive,
    images,
    producers,
    ratelimits,
  };
}

export function stringsOf(value, path = "") {
  if (typeof value === "string") {
    return [[path, value]];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => stringsOf(item, `${path}[${index}]`));
  }
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, item]) =>
      stringsOf(item, path ? `${path}.${key}` : key)
    );
  }
  return [];
}

export function bindingsSnapshot(config) {
  const b = bindingsOf(config);
  return {
    account: config.account_id,
    buckets: [...b.buckets].sort(),
    consumers: [...b.consumers].sort(),
    hyperdrive: [...b.hyperdrive].sort(),
    producers: [...b.producers].sort(),
    ratelimits: [...b.ratelimits].sort(),
  };
}

/** Pinned to one account, so a token that sees several accounts never reads another one. */
export function hyperdriveDetails(id, cwd, accountId) {
  const result = spawnSync(
    "bunx",
    ["--no-install", "wrangler", "hyperdrive", "get", id],
    {
      cwd,
      encoding: "utf8",
      env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId },
    }
  );
  if (result.status !== 0) {
    return null;
  }
  const start = result.stdout.indexOf("{");
  try {
    return start === -1 ? null : JSON.parse(result.stdout.slice(start));
  } catch {
    return null;
  }
}

export function readBuilt(appDir) {
  // the deploy follows .wrangler/deploy/config.json to the generated wrangler.json; so does this check
  const redirect = resolve(appDir, ".wrangler/deploy/config.json");
  if (!existsSync(redirect)) {
    return null;
  }
  const { configPath } = JSON.parse(readFileSync(redirect, "utf8"));
  const file = resolve(dirname(redirect), configPath);
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
}
