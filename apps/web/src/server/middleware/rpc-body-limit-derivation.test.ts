import { traverseContractProcedures } from "@orpc/server";
import { polarisContract } from "@polaris/contracts";
import { STRING_LIMIT_EXCEPTIONS } from "@polaris/contracts/input-string-limits";
import { describe, expect, it } from "vitest";
import { OUTBOX_MAX_PAYLOAD_BYTES } from "../../offline/outbox/command";
import { PUSH_BATCH_TARGET_BYTES } from "../../offline/sync-runner";
import { RPC_BODY_MAX_BYTES } from "./rpc-body-limit";

/**
 * Why the ceiling is the number it is, from the contract and not from a guess: no input of a procedure may be able
 * to reach it, except the `sync.push` command, whose payload (`z.json()`) is bounded by the outbox and not by the
 * contract. If someone raises a `.max` of the contract or `OUTBOX_MAX_PAYLOAD_BYTES`, this fails and the ceiling is
 * looked at again, instead of a legitimate call turning into a 413.
 *
 * The walk gives the largest JSON text a value can take, in bytes. A string the contract does not bound by a `.max`
 * (the option values and the SKU of a variant) counts as `UNBOUNDED_STRING_BYTES`, and the fields that do this are
 * exactly the exceptions of the contract (`STRING_LIMIT_EXCEPTIONS`): a new one fails there first. The ceiling is what
 * bounds those in practice; the walk only shows that an ordinary use of them is far below it (the most that stacks is
 * 300 option and variant values of `product.configureVariants`).
 */
const BYTES_PER_CODE_UNIT = 3; // the BMP in UTF-8; an escaped control character is not what a person types
const NUMBER_BYTES = 25;
const KEY_OVERHEAD = 4; // the quotes, the colon and the comma
const UNBOUNDED_STRING_BYTES = 1024;
/** What oRPC adds around the input (`{"json":…,"meta":[…]}`), with room. */
const FRAME_BYTES = 256;

const FORMAT_BYTES: Record<string, number> = {
  date: 12,
  datetime: 40, // with a fraction and an offset
  guid: 38,
  uuid: 38,
};

interface Walk {
  /** A path that a bound outside the schema holds: the bytes it takes (the outbox for the payload of a command). */
  fixed: Record<string, number>;
  /** An array whose length the walk takes as this, instead of its `.max` (the one command of the sync). */
  lengths: Record<string, number>;
  /** The paths of the strings no `.max` bounds. */
  unbounded: Set<string>;
}

const newWalk = (overrides: Partial<Walk> = {}): Walk => ({
  fixed: {},
  lengths: {},
  unbounded: new Set(),
  ...overrides,
});

/** The part of a zod schema the walk reads (`apps/web` has no `zod` of its own: the contract owns it). */
interface $ZodType {
  _zod: { def: { checks?: unknown[]; type?: string } };
}

interface Check {
  _zod: { def: Record<string, unknown> };
}

function checksOf(schema: $ZodType): Check[] {
  return (schema._zod.def.checks ?? []) as unknown as Check[];
}

function maxLengthOf(schema: $ZodType): number | undefined {
  const found = checksOf(schema)
    .filter((check) =>
      ["max_length", "length_equals"].includes(check._zod.def.check as string)
    )
    .map(
      (check) => (check._zod.def.maximum ?? check._zod.def.length) as number
    );
  return found.length > 0 ? Math.min(...found) : undefined;
}

function stringBytes(schema: $ZodType, path: string, walk: Walk): number {
  const max = maxLengthOf(schema);
  if (max !== undefined) {
    return 2 + max * BYTES_PER_CODE_UNIT;
  }
  const formats = [
    (schema._zod.def as { format?: string }).format,
    ...checksOf(schema).map((check) => check._zod.def.format as string),
  ];
  for (const format of formats) {
    const known = format === undefined ? undefined : FORMAT_BYTES[format];
    if (known !== undefined) {
      return known;
    }
  }
  walk.unbounded.add(path);
  return UNBOUNDED_STRING_BYTES;
}

function objectBytes(
  def: Record<string, unknown>,
  path: string,
  walk: Walk
): number {
  // `z.strictObject` has a `never` catchall: it takes no other key
  const catchall = def.catchall as $ZodType | undefined;
  if (catchall && catchall._zod.def.type !== "never") {
    return Number.POSITIVE_INFINITY;
  }
  let total = 2;
  for (const [key, value] of Object.entries(
    def.shape as Record<string, $ZodType>
  )) {
    total +=
      key.length + KEY_OVERHEAD + maxBytes(value, `${path}.${key}`, walk);
  }
  return total;
}

function maxBytes(schema: $ZodType, path: string, walk: Walk): number {
  const fixed = walk.fixed[path];
  if (fixed !== undefined) {
    return fixed;
  }
  const def = schema._zod.def as unknown as Record<string, unknown>;
  const child = (key: string) => def[key] as $ZodType;
  switch (def.type as string) {
    case "string":
      return stringBytes(schema, path, walk);
    case "number":
    case "int":
      return NUMBER_BYTES;
    case "boolean":
      return 5;
    case "null":
      return 4;
    case "undefined":
    case "void":
      return 0;
    case "enum":
      return (
        2 +
        Math.max(
          ...Object.values(def.entries as Record<string, string | number>).map(
            (value) => String(value).length
          )
        )
      );
    case "literal":
      return Math.max(
        ...(def.values as unknown[]).map(
          (value) => JSON.stringify(value).length
        )
      );
    case "optional":
    case "default":
    case "prefault":
    case "nonoptional":
    case "readonly":
    case "catch":
      return maxBytes(child("innerType"), path, walk);
    case "nullable":
      return Math.max(4, maxBytes(child("innerType"), path, walk));
    case "array": {
      const length = walk.lengths[path] ?? maxLengthOf(schema);
      return length === undefined
        ? Number.POSITIVE_INFINITY
        : 2 + length * (maxBytes(child("element"), `${path}[]`, walk) + 1);
    }
    case "object":
      return objectBytes(def, path, walk);
    case "union":
      return Math.max(
        ...(def.options as $ZodType[]).map((option, index) =>
          maxBytes(option, `${path}|${index}`, walk)
        )
      );
    case "pipe": {
      // a preprocess puts a transform in front of the schema that holds the value
      const input = child("in");
      return maxBytes(
        input._zod.def.type === "transform" ? child("out") : input,
        path,
        walk
      );
    }
    default:
      // a shape this walk does not know is not taken as small: it fails until it is taught
      return Number.POSITIVE_INFINITY;
  }
}

/** The input schema of every procedure of the contract, by its path (`sale/confirm`). */
function inputs(): Map<string, $ZodType> {
  const found = new Map<string, $ZodType>();
  traverseContractProcedures(
    { path: [], router: polarisContract },
    ({ contract, path }) => {
      const schema = contract["~orpc"].inputSchema as $ZodType | undefined;
      if (schema) {
        found.set(path.join("/"), schema);
      }
    }
  );
  return found;
}

/** One command of the sync with the largest payload the outbox keeps, and the envelope the contract allows. */
function oneCommandBytes(): number {
  const schema = inputs().get("sync/push") as $ZodType;
  return (
    FRAME_BYTES +
    maxBytes(
      schema,
      "",
      newWalk({
        fixed: { ".commands[].payload": OUTBOX_MAX_PAYLOAD_BYTES },
        lengths: { ".commands": 1 },
      })
    )
  );
}

/** Every input but the sync's: the largest, the ones nothing bounds, and the fields without a `.max`, by procedure. */
function otherInputs() {
  const unbounded: string[] = [];
  const loose: string[] = [];
  let largest = { bytes: 0, path: "" };
  for (const [path, schema] of inputs()) {
    if (path === "sync/push") {
      continue;
    }
    const walk = newWalk();
    const bytes = FRAME_BYTES + maxBytes(schema, "", walk);
    loose.push(...[...walk.unbounded].map((field) => `${path}${field}`));
    if (!Number.isFinite(bytes)) {
      unbounded.push(path);
    } else if (bytes > largest.bytes) {
      largest = { bytes, path };
    }
  }
  return { largest, loose: loose.sort(), unbounded };
}

/**
 * The fields no `.max` of the contract bounds, by procedure (each counted as 1 KiB): the list of the contract, which
 * only shrinks, less the `sync/push`, whose input the walk reads apart.
 */
const LOOSE_FIELDS = STRING_LIMIT_EXCEPTIONS.filter(
  (path) => !path.startsWith("sync/push")
);

describe("how the body ceiling of /rpc is derived", () => {
  it("is at least twice the largest payload the outbox keeps", () => {
    expect(RPC_BODY_MAX_BYTES).toBeGreaterThanOrEqual(
      2 * OUTBOX_MAX_PAYLOAD_BYTES
    );
  });

  it("holds one command of the sync at its largest, with its envelope", () => {
    const bytes = oneCommandBytes();
    expect(Number.isFinite(bytes)).toBe(true);
    expect(bytes).toBeGreaterThan(OUTBOX_MAX_PAYLOAD_BYTES);
    expect(bytes).toBeLessThan(RPC_BODY_MAX_BYTES);
  });

  it("is above the largest input of every other procedure, and every one is bounded", () => {
    const { largest, unbounded } = otherInputs();

    // an input nothing bounds is an input the ceiling could refuse in use: it has to be bounded
    expect(unbounded).toEqual([]);
    expect(largest.path).not.toBe("");
    expect(largest.bytes).toBeLessThan(RPC_BODY_MAX_BYTES);
  });

  it("names every field the contract leaves without a .max", () => {
    expect(otherInputs().loose).toEqual(LOOSE_FIELDS);
  });

  it("closes the batch of the sync below the ceiling, with room for the envelope", () => {
    expect(PUSH_BATCH_TARGET_BYTES).toBeLessThan(RPC_BODY_MAX_BYTES);
    expect(RPC_BODY_MAX_BYTES - PUSH_BATCH_TARGET_BYTES).toBeGreaterThan(
      64 * 1024
    );
  });

  it("sees a string with no .max, and an array with none, in a schema planted for the purpose", () => {
    const planted = (def: object) => ({ _zod: { def } }) as unknown as $ZodType;
    const text = planted({ checks: [], type: "string" });
    const walk = newWalk();

    expect(maxBytes(text, ".planted", walk)).toBe(UNBOUNDED_STRING_BYTES);
    expect([...walk.unbounded]).toEqual([".planted"]);
    expect(
      maxBytes(
        planted({ checks: [], element: text, type: "array" }),
        "",
        newWalk()
      )
    ).toBe(Number.POSITIVE_INFINITY);
  });
});
