import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { $ZodType } from "zod/v4/core";
import { polarisContract } from "./index";

/**
 * Every array an input can hold needs a `.max`: an array with no ceiling is input with no limit of CPU on the Free
 * plan (the 50-value limit of the product options was the first; this is the same rule for the whole contract).
 */
interface ArrayInInput {
  bounded: boolean;
  /**
   * A schema that holds a value of any shape (`z.json()` is recursive; `z.any()`, `z.unknown()` and `z.custom()` are
   * the walk cannot see what they accept): it may hold arrays of any depth, so it is limited by something else, listed below.
   */
  opaque?: true;
  path: string;
}

/** Schemas that hold no other schema: nothing to walk into. */
const LEAVES = new Set([
  "bigint",
  "boolean",
  "date",
  "enum",
  "literal",
  "nan",
  "never",
  "null",
  "number",
  "string",
  "symbol",
  "template_literal",
  "transform",
  "undefined",
  "void",
]);

function hasMaxLength(schema: $ZodType): boolean {
  const checks = (schema._zod.def.checks ?? []) as {
    _zod: { def: { check: string } };
  }[];
  // `.length(n)` is a ceiling too
  return checks.some((check) =>
    ["length_equals", "max_length"].includes(check._zod.def.check)
  );
}

/** Walks a schema (objects, wrappers, unions, pipes...) and reports each array on the way, with its path. */
function arraysIn(schema: $ZodType, path: string): ArrayInInput[] {
  const def = schema._zod.def as unknown as Record<string, unknown>;
  const child = (key: string) => def[key] as $ZodType;
  const type = def.type as string;
  switch (type) {
    case "array":
      return [
        { bounded: hasMaxLength(schema), path },
        ...arraysIn(child("element"), `${path}[]`),
      ];
    case "object":
      return [
        ...Object.entries(def.shape as Record<string, $ZodType>).flatMap(
          ([key, value]) => arraysIn(value, `${path}.${key}`)
        ),
        // `z.looseObject` and `.catchall()`: every key the shape does not name
        ...(def.catchall ? arraysIn(child("catchall"), `${path}.*`) : []),
      ];
    case "optional":
    case "nullable":
    case "default":
    case "prefault":
    case "nonoptional":
    case "readonly":
    case "catch":
      return arraysIn(child("innerType"), path);
    case "lazy": // the getter builds a new schema on each call, so a recursive one never ends
    case "any":
    case "unknown":
    case "custom": // these three have no shape the walk can enter
      // all four are reported, not entered: the value may hold an array, and only a named exception lets it by
      return [{ bounded: false, opaque: true, path }];
    case "union":
      return (def.options as $ZodType[]).flatMap((option, index) =>
        arraysIn(option, `${path}|${index}`)
      );
    case "intersection":
      return [
        ...arraysIn(child("left"), path),
        ...arraysIn(child("right"), path),
      ];
    case "pipe":
      // both sides: `z.preprocess` puts a transform in front of the schema that holds the array
      return [...arraysIn(child("in"), path), ...arraysIn(child("out"), path)];
    case "record":
    case "map":
      return arraysIn(child("valueType"), `${path}{}`);
    case "set":
      return arraysIn(child("valueType"), `${path}[]`);
    case "tuple":
      return [
        ...(def.items as $ZodType[]).flatMap((item, index) =>
          arraysIn(item, `${path}.${index}`)
        ),
        ...(def.rest ? arraysIn(child("rest"), `${path}.*`) : []),
      ];
    default:
      // a kind of schema this walk does not know could hide an array: say so instead of passing over it
      if (!LEAVES.has(type)) {
        throw new Error(
          `input-array-limits: unknown schema type ${type} at ${path}`
        );
      }
      return [];
  }
}

/** The opaque schemas the contract may keep: each needs a limit of its own, named at the test that lists it. */
const OPAQUE_EXCEPTIONS = ["sync.push.commands[].payload"];

/** The opaque paths found that no exception names: the rule of the contract is that this is empty. */
function opaqueOutsideExceptions(found: ArrayInInput[]): string[] {
  return found
    .filter((entry) => entry.opaque)
    .map((entry) => entry.path)
    .filter((path) => !OPAQUE_EXCEPTIONS.includes(path));
}

function inputsOf(
  node: object,
  path: string
): { path: string; schema: $ZodType }[] {
  const procedure = (node as { "~orpc"?: { inputSchema?: unknown } })["~orpc"];
  if (procedure) {
    return procedure.inputSchema
      ? [{ path, schema: procedure.inputSchema as $ZodType }]
      : [];
  }
  return Object.entries(node).flatMap(([key, value]) =>
    typeof value === "object" && value !== null
      ? inputsOf(value, path ? `${path}.${key}` : key)
      : []
  );
}

describe("the input schemas of the contract", () => {
  const arrays = inputsOf(polarisContract, "").flatMap(({ path, schema }) =>
    arraysIn(schema, path)
  );

  it("walk down to every array of the inputs: the exact list, so a branch the walk stops seeing shows here", () => {
    expect(arrays.map((found) => found.path).sort()).toEqual([
      "account.acceptLegal.documents",
      "dataExport.request.formats",
      "dataExport.requestClosed.formats",
      "inventory.listBalances.variantIds",
      "paymentProfile.create.rules",
      "paymentProfile.update.rules",
      "plan.selectOperationalVariants.variantIds",
      "product.configureVariants.options",
      "product.configureVariants.options[].values",
      "product.configureVariants.variants",
      "product.importBatch.rows",
      "product.namesExisting.names",
      "publicCatalog.publishProducts.productIds",
      "publicCatalog.unpublishProducts.productIds",
      "sale.confirm.adjustments",
      "sale.confirm.items",
      "sale.return.items",
      "sync.bootstrapPage.ids",
      "sync.push.commands",
      "sync.push.commands[].payload",
    ]);
  });

  it("give every array a `.max`", () => {
    expect(
      arrays
        .filter((found) => !(found.bounded || found.opaque))
        .map((found) => found.path)
    ).toEqual([]);
  });

  it("leave open only the opaque schemas that something else limits", () => {
    // `payload` of a pushed command is JSON of any shape. The server refuses one over `MAX_COMMAND_PAYLOAD_CHARS`
    // (sync/push.ts), but only after the contract has validated it, and `/rpc` has no limit on the size of the body of
    // its own: the arrays inside it are open until that check, which is a limit of its own to add, not of this rule
    expect(opaqueOutsideExceptions(arrays)).toEqual([]);
    // and the exception is still there: one the contract no longer needs leaves the list
    expect(
      arrays.filter((found) => found.opaque).map((found) => found.path)
    ).toEqual(OPAQUE_EXCEPTIONS);
  });
});

describe("the walk over input schemas", () => {
  const open = z.array(z.number());
  const unbounded = (schema: $ZodType) =>
    arraysIn(schema, "input")
      .filter((found) => !found.bounded)
      .map((found) => found.path);

  it("reports an array with no `.max`, even with only a `.min`", () => {
    expect(unbounded(z.object({ ids: z.array(z.string()).min(1) }))).toEqual([
      "input.ids",
    ]);
  });

  it("accepts a `.max` of any size, set before other checks, and a `.length`", () => {
    expect(
      unbounded(
        z.object({
          exact: z.array(z.string()).length(2),
          ids: z.array(z.string()).max(50).min(1),
        })
      )
    ).toEqual([]);
  });

  it("finds an array under an optional, a nullable with a default, a union, an array of objects and a record", () => {
    expect(
      unbounded(
        z.object({
          a: open.optional(),
          b: z.union([z.string(), open]),
          c: open.nullable().default([]),
          d: z.array(z.object({ values: open }).strict()).max(5),
          e: z.record(z.string(), open),
        })
      )
    ).toEqual([
      "input.a",
      "input.b|1",
      "input.c",
      "input.d[].values",
      "input.e{}",
    ]);
  });

  it("finds an array under the other wrappers, a map, a set and an intersection", () => {
    expect(
      unbounded(
        z.object({
          a: open.nonoptional(),
          b: open.readonly(),
          c: open.catch([]),
          d: open.prefault([]),
          e: z.map(z.string(), open),
          f: z.set(z.array(z.string()).max(2)),
          g: z.intersection(z.object({ x: open }), z.object({ y: z.string() })),
        })
      )
    ).toEqual([
      "input.a",
      "input.b",
      "input.c",
      "input.d",
      "input.e{}",
      "input.g.x",
    ]);
  });

  it("finds an array past a transform (a preprocess), on either side of a pipe", () => {
    expect(
      unbounded(
        z.object({
          a: z.preprocess((value) => value, open),
          b: z.array(z.string()).max(3).pipe(z.array(z.string())),
        })
      )
    ).toEqual(["input.a", "input.b"]);
  });

  it("finds an array in the rest of a tuple and in the catchall of an object", () => {
    expect(
      unbounded(
        z.object({
          a: z.tuple([z.string()], open),
          b: z.looseObject({ known: z.string() }).catchall(open),
        })
      )
    ).toEqual(["input.a.*", "input.b.*"]);
  });

  it("reports a recursive schema as opaque instead of walking it for ever", () => {
    expect(arraysIn(z.object({ data: z.json() }), "input")).toEqual([
      { bounded: false, opaque: true, path: "input.data" },
    ]);
  });

  // planted controls: they go through the same rule as the contract, so a loosened rule shows here
  const outside = (schema: $ZodType, root = "input") =>
    opaqueOutsideExceptions(arraysIn(schema, root));

  it("reports `z.unknown()`, `z.any()` and `z.custom()` as opaque, so each is outside the list of exceptions", () => {
    expect(
      outside(
        z.object({
          a: z.unknown(),
          b: z.any(),
          c: z.custom<string[]>(),
          d: z.array(z.unknown()).max(3),
          e: z.unknown().optional(),
          f: z.union([z.string(), z.any()]),
          g: z.record(z.string(), z.unknown()),
          h: z.string().pipe(z.custom<string>()),
          i: z.json(),
        })
      )
    ).toEqual([
      "input.a",
      "input.b",
      "input.c",
      "input.d[]",
      "input.e",
      "input.f|1",
      "input.g{}",
      "input.h",
      "input.i",
    ]);
  });

  it("lets by only the path the list names, not its neighbours", () => {
    const at = (root: string, shape: Record<string, $ZodType>) =>
      outside(z.object(shape), root);
    expect(at("sync.push.commands[]", { payload: z.unknown() })).toEqual([]);
    expect(at("sync.push.commands[]", { other: z.unknown() })).toEqual([
      "sync.push.commands[].other",
    ]);
    expect(at("sync.push.commands[]", { payloads: z.any() })).toEqual([
      "sync.push.commands[].payloads",
    ]);
    expect(at("sync.push.commands", { payload: z.any() })).toEqual([
      "sync.push.commands.payload",
    ]);
    expect(at("sync.pull.commands[]", { payload: z.any() })).toEqual([
      "sync.pull.commands[].payload",
    ]);
  });

  it("refuses a kind of schema it does not know, instead of passing over what it may hold", () => {
    expect(() => arraysIn(z.object({ file: z.file() }), "input")).toThrow(
      "unknown schema type file at input.file"
    );
  });
});
