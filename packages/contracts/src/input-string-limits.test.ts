import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { $ZodType } from "zod/v4/core";
import { polarisContract } from "./index";
import { STRING_LIMIT_EXCEPTIONS } from "./input-string-limits";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const X_PATTERN = /^x+$/;

/**
 * Every string an input can hold needs a `.max` or a `.length`: a string with no ceiling can take the whole body of
 * `/rpc`, and a `refine` that walks it (`[...text]`) then spends CPU of the Free plan on it. A `regex`, a `refine`,
 * a `trim` or an `email` alone do not count: the walk cannot read a size out of them.
 */
interface StringInInput {
  bounded: boolean;
  max?: number;
  /** A schema that holds a value of any shape: the walk cannot see the strings inside it. */
  opaque?: true;
  path: string;
  schema: $ZodType;
}

/** Formats whose text has a fixed size, the same the derivation of the ceiling of `/rpc` reads. */
const FIXED_SIZE_FORMATS = new Set(["date", "datetime", "guid", "uuid"]);

/** Schemas that hold no string and no other schema. */
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
  "symbol",
  "transform",
  "undefined",
  "void",
]);

/** The opaque schemas the contract may keep: the outbox bounds the payload of a command, not the contract. */
const OPAQUE_EXCEPTIONS = ["sync/push.commands[].payload"];

/**
 * The 133 paths that had no ceiling when this rule came in, frozen: `STRING_LIMIT_EXCEPTIONS` may only be a part of
 * them. Listing a new field as an exception means editing this list too, and that shows in the diff.
 */
const STRING_LIMIT_BASELINE = [
  "billing/cancelRenewal.organizationId",
  "billing/cancelRenewal.requestId",
  "billing/openOverduePayment.organizationId",
  "billing/openOverduePayment.requestId",
  "billing/readPlan.organizationId",
  "billing/requestRefund.organizationId",
  "billing/requestRefund.requestId",
  "billing/startCheckout|0.organizationId",
  "billing/startCheckout|1.organizationId",
  "billing/startCheckout|1.payer.taxId",
  "category/archive.organizationId",
  "category/create.name",
  "category/create.organizationId",
  "category/delete.organizationId",
  "category/list.organizationId",
  "category/rename.name",
  "category/rename.organizationId",
  "category/restore.organizationId",
  "customer/anonymizeForPrivacy.organizationId",
  "customer/archive.organizationId",
  "customer/create.organizationId",
  "customer/findPossibleDuplicates.organizationId",
  "customer/list.organizationId",
  "customer/restore.organizationId",
  "customer/update.organizationId",
  "dataExport/list.organizationId",
  "dataExport/listClosed.organizationId",
  "dataExport/request.organizationId",
  "dataExport/requestClosed.organizationId",
  "expense/archiveCategory.organizationId",
  "expense/archiveRule.organizationId",
  "expense/create.competenceOn",
  "expense/create.description",
  "expense/create.organizationId",
  "expense/create.payee",
  "expense/createCategory.name",
  "expense/createCategory.organizationId",
  "expense/createRule.description",
  "expense/createRule.endsOn",
  "expense/createRule.organizationId",
  "expense/createRule.payee",
  "expense/createRule.startsOn",
  "expense/list.from",
  "expense/list.organizationId",
  "expense/list.to",
  "expense/listCategories.organizationId",
  "expense/listRules.organizationId",
  "expense/renameCategory.name",
  "expense/renameCategory.organizationId",
  "expense/restore.organizationId",
  "expense/restoreCategory.organizationId",
  "expense/restoreRule.organizationId",
  "expense/update.competenceOn",
  "expense/update.description",
  "expense/update.organizationId",
  "expense/update.payee",
  "expense/updateRule.description",
  "expense/updateRule.endsOn",
  "expense/updateRule.organizationId",
  "expense/updateRule.payee",
  "expense/void.organizationId",
  "goal/cancel.organizationId",
  "goal/create.endsOn",
  "goal/create.organizationId",
  "goal/create.startsOn",
  "goal/list.organizationId",
  "goal/targetChanges.organizationId",
  "goal/update.organizationId",
  "inventory/getBalance.organizationId",
  "inventory/inventoryCount.occurredOn",
  "inventory/inventoryCount.organizationId",
  "inventory/listBalances.organizationId",
  "inventory/receiveStock.occurredOn",
  "inventory/receiveStock.organizationId",
  "inventory/writeOffStock.occurredOn",
  "inventory/writeOffStock.organizationId",
  "inventory/writeOffStock.reasonNote",
  "offline/issueLease.organizationId",
  "organization/closedStatus.organizationId",
  "organization/recoverClosure.organizationId",
  "organization/requestClosure.organizationId",
  "paymentProfile/archive.organizationId",
  "paymentProfile/create.organizationId",
  "paymentProfile/list.organizationId",
  "paymentProfile/restore.organizationId",
  "paymentProfile/update.organizationId",
  "plan/operationalSelection.organizationId",
  "plan/selectOperationalVariants.organizationId",
  "product/archive.organizationId",
  "product/configureVariants.options[].values[]",
  "product/configureVariants.organizationId",
  "product/configureVariants.variants[].values.color",
  "product/configureVariants.variants[].values.model",
  "product/configureVariants.variants[].values.size",
  "product/create.organizationId",
  "product/delete.organizationId",
  "product/getVariants.organizationId",
  "product/importBatch.organizationId",
  "product/list.organizationId",
  "product/namesExisting.organizationId",
  "product/restore.organizationId",
  "product/setVariantListPrice.organizationId",
  "product/setVariantSku.organizationId",
  "product/setVariantSku.sku",
  "product/update.description",
  "product/update.organizationId",
  "publicCatalog/publishProducts.organizationId",
  "publicCatalog/saveProfile.organizationId",
  "publicCatalog/setPublished.organizationId",
  "publicCatalog/setup.organizationId",
  "publicCatalog/unpublishProducts.organizationId",
  "report/dailySales.from",
  "report/dailySales.organizationId",
  "report/dailySales.to",
  "report/periodSummary.from",
  "report/periodSummary.organizationId",
  "report/periodSummary.to",
  "sale/assignCustomer.organizationId",
  "sale/cancel.organizationId",
  "sale/confirm.organizationId",
  "sale/get.organizationId",
  "sale/getCustomerLink.organizationId",
  "sale/list.occurredFrom",
  "sale/list.occurredTo",
  "sale/list.organizationId",
  "sale/reassignCustomer.organizationId",
  "sale/return.organizationId",
  "sale/unassignCustomer.organizationId",
  "sync/bootstrapPage.organizationId",
  "sync/getCursor.organizationId",
  "sync/pull.cursor",
  "sync/pull.organizationId",
  "sync/push.organizationId",
];

interface Check {
  _zod: { check: (payload: unknown) => unknown; def: Record<string, unknown> };
}

function checksOf(schema: $ZodType): Check[] {
  return (schema._zod.def.checks ?? []) as unknown as Check[];
}

function maxLengthOf(schema: $ZodType): number | undefined {
  const found = checksOf(schema)
    .filter((check) =>
      ["length_equals", "max_length"].includes(check._zod.def.check as string)
    )
    .map(
      (check) => (check._zod.def.maximum ?? check._zod.def.length) as number
    );
  return found.length > 0 ? Math.min(...found) : undefined;
}

function hasFixedSizeFormat(schema: $ZodType): boolean {
  return [
    (schema._zod.def as { format?: string }).format,
    ...checksOf(schema).map((check) => check._zod.def.format as string),
  ].some((format) => format !== undefined && FIXED_SIZE_FORMATS.has(format));
}

function stringFound(schema: $ZodType, path: string): StringInInput {
  const max = maxLengthOf(schema);
  return {
    bounded: max !== undefined || hasFixedSizeFormat(schema),
    path,
    schema,
    ...(max === undefined ? {} : { max }),
  };
}

const WRAPPERS = new Set([
  "catch",
  "default",
  "nonoptional",
  "nullable",
  "optional",
  "prefault",
  "readonly",
]);

/** `z.lazy` builds a new schema on each call (a recursive one never ends); the other three have no shape to enter. */
const OPAQUE = new Set(["any", "custom", "lazy", "unknown"]);

/** Walks a schema (objects, wrappers, unions, pipes...) and reports each string on the way, with its path. */
function stringsIn(schema: $ZodType, path: string): StringInInput[] {
  const def = schema._zod.def as unknown as Record<string, unknown>;
  const child = (key: string) => def[key] as $ZodType;
  const type = def.type as string;
  if (WRAPPERS.has(type)) {
    return stringsIn(child("innerType"), path);
  }
  if (OPAQUE.has(type)) {
    return [{ bounded: false, opaque: true, path, schema }];
  }
  switch (type) {
    case "string":
      return [stringFound(schema, path)];
    case "template_literal":
      // its parts may hold a `z.string()` of any length, and the whole has no `.max` of its own
      return [{ bounded: false, path, schema }];
    case "object":
      return [
        ...Object.entries(def.shape as Record<string, $ZodType>).flatMap(
          ([key, value]) => stringsIn(value, `${path}.${key}`)
        ),
        ...(def.catchall ? stringsIn(child("catchall"), `${path}.*`) : []),
      ];
    case "array":
    case "set":
      return stringsIn(child("element") ?? child("valueType"), `${path}[]`);
    case "union":
      return (def.options as $ZodType[]).flatMap((option, index) =>
        stringsIn(option, `${path}|${index}`)
      );
    case "intersection":
      return [
        ...stringsIn(child("left"), path),
        ...stringsIn(child("right"), path),
      ];
    case "pipe":
      // both sides: `z.preprocess` puts a transform in front of the schema that holds the string
      return [
        ...stringsIn(child("in"), path),
        ...stringsIn(child("out"), path),
      ];
    case "record":
    case "map":
      return [
        ...stringsIn(child("keyType"), `${path}{key}`),
        ...stringsIn(child("valueType"), `${path}{}`),
      ];
    case "tuple":
      return [
        ...(def.items as $ZodType[]).flatMap((item, index) =>
          stringsIn(item, `${path}.${index}`)
        ),
        ...(def.rest ? stringsIn(child("rest"), `${path}.*`) : []),
      ];
    default:
      // a kind of schema this walk does not know could hide a string: say so instead of passing over it
      if (!LEAVES.has(type)) {
        throw new Error(
          `input-string-limits: unknown schema type ${type} at ${path}`
        );
      }
      return [];
  }
}

/** The paths with no ceiling: unbounded strings, and opaque schemas other than the named ones. */
function looseIn(found: StringInInput[]): string[] {
  return [
    ...new Set(
      found
        .filter(
          (entry) =>
            !(
              entry.bounded ||
              (entry.opaque && OPAQUE_EXCEPTIONS.includes(entry.path))
            )
        )
        .map((entry) => entry.path)
    ),
  ].sort();
}

/** What breaks the rule, for a set of found strings, a list of exceptions and the frozen baseline. */
function problemsOf(
  found: StringInInput[],
  exceptions: readonly string[],
  baseline: readonly string[]
): string[] {
  const loose = looseIn(found);
  return [
    ...loose
      .filter((path) => !exceptions.includes(path))
      .map((path) => `no ceiling: ${path}`),
    ...exceptions
      .filter((path) => !loose.includes(path))
      .map((path) => `bounded but still an exception: ${path}`),
    ...exceptions
      .filter((path) => !baseline.includes(path))
      .map((path) => `exception outside the baseline: ${path}`),
    ...(exceptions.join("\n") === [...exceptions].sort().join("\n")
      ? []
      : ["exceptions out of order"]),
  ];
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
      ? inputsOf(value, path ? `${path}/${key}` : key)
      : []
  );
}

const contractStrings = inputsOf(polarisContract, "").flatMap(
  ({ path, schema }) => stringsIn(schema, path)
);

function contractString(path: string): $ZodType {
  const found = contractStrings.find((entry) => entry.path === path);
  if (!found) {
    throw new Error(`no input string at ${path}`);
  }
  return found.schema;
}

describe("the input strings of the contract", () => {
  it("leave without a ceiling exactly the listed exceptions", () => {
    expect(looseIn(contractStrings)).toEqual([...STRING_LIMIT_EXCEPTIONS]);
    expect(
      problemsOf(
        contractStrings,
        STRING_LIMIT_EXCEPTIONS,
        STRING_LIMIT_BASELINE
      )
    ).toEqual([]);
  });

  it("only shrink: the exceptions are a part of the frozen baseline of 133", () => {
    expect(STRING_LIMIT_BASELINE).toHaveLength(133);
    expect(new Set(STRING_LIMIT_BASELINE).size).toBe(133);
    expect(STRING_LIMIT_BASELINE).toEqual([...STRING_LIMIT_BASELINE].sort());
    expect(
      STRING_LIMIT_EXCEPTIONS.filter(
        (path) => !STRING_LIMIT_BASELINE.includes(path)
      )
    ).toEqual([]);
  });

  it("leave opaque only the payload of a pushed command, which the outbox bounds", () => {
    expect(
      contractStrings.filter((entry) => entry.opaque).map((entry) => entry.path)
    ).toEqual(OPAQUE_EXCEPTIONS);
  });

  it("bound every organizationId at 255, the envelope of the sync included: it is a context asked for, never proof", () => {
    const ids = contractStrings.filter((entry) =>
      entry.path.endsWith(".organizationId")
    );
    expect(ids).toHaveLength(91);
    expect(
      ids.filter((entry) => entry.max !== 255).map((entry) => entry.path)
    ).toEqual([]);
    expect(ids.map((entry) => entry.path)).toContain(
      "sync/push.organizationId"
    );
  });
});

describe("the walk over input strings, on planted schemas", () => {
  const loose = (shape: Record<string, $ZodType>) =>
    looseIn(stringsIn(z.object(shape), "input"));

  it("reports a string held only by a regex, a refine, a trim with a min, or an email", () => {
    expect(
      loose({
        a: z.string().regex(DATE_PATTERN),
        b: z.string().refine((text) => [...text].length <= 10),
        c: z.string().trim().min(1),
        d: z.string().email(),
        e: z.email(),
        f: z.coerce.string(),
      })
    ).toEqual([
      "input.a",
      "input.b",
      "input.c",
      "input.d",
      "input.e",
      "input.f",
    ]);
  });

  it("accepts a `.max` or a `.length` set anywhere among the checks, an abort included, and a fixed-size format", () => {
    expect(
      loose({
        a: z.string().trim().max(10, { abort: true }).min(1),
        b: z.string().length(10).regex(DATE_PATTERN),
        c: z.string().regex(X_PATTERN).max(3),
        d: z.string().uuid(),
        e: z.uuid(),
        f: z.string().datetime(),
        g: z.iso.date(),
        h: z.coerce.string().max(4),
        i: z.email().max(254),
        j: z.enum(["x", "y"]),
        k: z.literal("x"),
      })
    ).toEqual([]);
  });

  it("finds a string under the wrappers, an array, a union, a discriminated union, a pipe and a preprocess", () => {
    const open = z.string().trim().min(1);
    expect(
      loose({
        a: open.optional(),
        b: open.nullable(),
        c: open.nullish(),
        d: open.default("x"),
        e: z.array(open).max(5),
        f: z.union([z.number(), open]),
        g: z.discriminatedUnion("kind", [
          z.object({ kind: z.literal("x"), name: open }),
          z.object({ kind: z.literal("y"), size: z.number() }),
        ]),
        h: open.pipe(z.string().max(3)),
        i: z.preprocess((value) => value, open),
        j: z.string().max(3).pipe(open),
        k: z.set(open).max(2),
        l: z.tuple([open], open),
        m: z.looseObject({}).catchall(open),
        n: z.intersection(z.object({ x: open }), z.object({ y: z.number() })),
      })
    ).toEqual([
      "input.a",
      "input.b",
      "input.c",
      "input.d",
      "input.e[]",
      "input.f|1",
      "input.g|0.name",
      "input.h",
      "input.i",
      "input.j",
      "input.k[]",
      "input.l.*",
      "input.l.0",
      "input.m.*",
      "input.n.x",
    ]);
  });

  it("reports the key of a record or a map, not only its value", () => {
    expect(
      loose({
        a: z.record(z.string(), z.number()),
        b: z.record(z.string().max(10), z.string()),
        c: z.map(z.string(), z.number()),
      })
    ).toEqual(["input.a{key}", "input.b{}", "input.c{key}"]);
  });

  it("reports `z.any()`, `z.unknown()`, `z.custom()`, `z.json()`, `z.lazy()` and `z.templateLiteral()` as having no ceiling", () => {
    expect(
      loose({
        a: z.any(),
        b: z.unknown(),
        c: z.custom<string>(),
        d: z.json(),
        e: z.lazy(() => z.string().max(3)),
        f: z.templateLiteral(["id-", z.string()]),
        g: z.string().pipe(z.custom<string>()),
      })
    ).toEqual([
      "input.a",
      "input.b",
      "input.c",
      "input.d",
      "input.e",
      "input.f",
      "input.g",
    ]);
  });

  it("lets an opaque schema by only at the path the list names, not at its neighbours", () => {
    const at = (root: string, shape: Record<string, $ZodType>) =>
      looseIn(stringsIn(z.object(shape), root));
    expect(at("sync/push.commands[]", { payload: z.json() })).toEqual([]);
    expect(at("sync/push.commands[]", { other: z.json() })).toEqual([
      "sync/push.commands[].other",
    ]);
    expect(at("sync/push.commands", { payload: z.any() })).toEqual([
      "sync/push.commands.payload",
    ]);
    expect(at("sync/pull.commands[]", { payload: z.unknown() })).toEqual([
      "sync/pull.commands[].payload",
    ]);
  });

  it("refuses a kind of schema it does not know, instead of passing over what it may hold", () => {
    expect(() => stringsIn(z.object({ file: z.file() }), "input")).toThrow(
      "unknown schema type file at input.file"
    );
  });
});

describe("the rule over the list of exceptions, on planted lists", () => {
  const found = stringsIn(
    z.object({ a: z.string(), b: z.string().max(3), c: z.string() }),
    "p"
  );
  const baseline = ["p.a", "p.b", "p.c"];

  it("passes when the exceptions are exactly the strings without a ceiling", () => {
    expect(problemsOf(found, ["p.a", "p.c"], baseline)).toEqual([]);
  });

  it("refuses a new field without a ceiling that is not listed", () => {
    expect(problemsOf(found, ["p.a"], baseline)).toEqual(["no ceiling: p.c"]);
  });

  it("refuses an exception that gained a `.max`: the list shrinks in the same change", () => {
    expect(problemsOf(found, ["p.a", "p.b", "p.c"], baseline)).toEqual([
      "bounded but still an exception: p.b",
    ]);
  });

  it("refuses an exception outside the baseline", () => {
    expect(problemsOf(found, ["p.a", "p.c"], ["p.a"])).toEqual([
      "exception outside the baseline: p.c",
    ]);
  });

  it("refuses a list out of order", () => {
    expect(problemsOf(found, ["p.c", "p.a"], baseline)).toEqual([
      "exceptions out of order",
    ]);
  });
});

/** Counts the calls of the refines of a string schema, without changing what they answer. */
function countRefines(schema: $ZodType): {
  calls: () => number;
  restore: () => void;
} {
  let calls = 0;
  const refines = checksOf(schema).filter(
    (check) => check._zod.def.check === "custom"
  );
  const originals = refines.map((check) => check._zod.check);
  for (const [index, check] of refines.entries()) {
    const original = originals[index] as Check["_zod"]["check"];
    check._zod.check = (payload) => {
      calls += 1;
      return original(payload);
    };
  }
  return {
    calls: () => calls,
    restore: () => {
      for (const [index, check] of refines.entries()) {
        check._zod.check = originals[index] as Check["_zod"]["check"];
      }
    },
  };
}

const EMOJI = "\u{1F600}";

/**
 * The fields limited in code points by a `refine` (the same number as the domain and the CHECK of the database): a
 * `.max` of twice that in UTF-16 units comes first and aborts, so a long text never reaches the walk of the refine,
 * and N emojis (2N units) are still accepted.
 */
const CODE_POINT_FIELDS: [path: string, codePoints: number][] = [
  ["category/create.name", 100],
  ["category/rename.name", 100],
  ["expense/create.description", 200],
  ["expense/create.payee", 120],
  ["expense/createCategory.name", 100],
  ["expense/createRule.description", 200],
  ["expense/createRule.payee", 120],
  ["expense/renameCategory.name", 100],
  ["expense/update.description", 200],
  ["expense/update.payee", 120],
  ["expense/updateRule.description", 200],
  ["expense/updateRule.payee", 120],
  ["inventory/writeOffStock.reasonNote", 500],
];

describe.each(CODE_POINT_FIELDS)(
  "%s, limited to %i code points",
  (path, limit) => {
    const schema = contractString(path);
    const parse = (text: string) => {
      const counter = countRefines(schema);
      try {
        const result = z.safeParse(schema as never, text);
        return { calls: counter.calls(), success: result.success };
      } finally {
        counter.restore();
      }
    };

    it("refuses 500 000 characters without calling the refine", () => {
      const counter = countRefines(schema);
      try {
        expect(z.safeParse(schema as never, "a".repeat(500_000)).success).toBe(
          false
        );
        expect(counter.calls()).toBe(0);
      } finally {
        counter.restore();
      }
    });

    it("refuses one unit over twice the limit without calling the refine", () => {
      const counter = countRefines(schema);
      try {
        expect(
          z.safeParse(schema as never, "a".repeat(2 * limit + 1)).success
        ).toBe(false);
        expect(counter.calls()).toBe(0);
      } finally {
        counter.restore();
      }
    });

    it("accepts the limit, and the limit in emojis (twice the units); refuses one code point more", () => {
      expect(parse("a".repeat(limit)).success).toBe(true);
      expect(parse(EMOJI.repeat(limit)).success).toBe(true);
      expect(parse("a".repeat(limit + 1)).success).toBe(false);
      expect(parse(EMOJI.repeat(limit + 1)).success).toBe(false);
    });

    it("has the counter see the refine at all", () => {
      expect(parse("a".repeat(limit + 1)).calls).toBe(1);
    });
  }
);

describe("the fields of a fixed format", () => {
  it.each([
    ["expense/create.competenceOn", "2026-10-28"],
    ["expense/list.from", "2026-10-28"],
    ["inventory/receiveStock.occurredOn", "2026-10-28"],
    ["sale/list.occurredFrom", "2026-10-28"],
    ["billing/requestRefund.requestId", "0f8fad5b-d9cb-469f-a165-70867728950e"],
    ["billing/startCheckout|1.payer.taxId", "52998224725"],
    ["sync/pull.cursor", "1234567890123456"],
  ])(
    "%s accepts its format and refuses 500 000 characters without a refine",
    (path, valid) => {
      const schema = contractString(path);
      const counter = countRefines(schema);
      try {
        expect(z.safeParse(schema as never, valid).success).toBe(true);
        const before = counter.calls();
        expect(z.safeParse(schema as never, "1".repeat(500_000)).success).toBe(
          false
        );
        expect(counter.calls()).toBe(before);
      } finally {
        counter.restore();
      }
    }
  );
});

describe("product/update.description", () => {
  it("is limited at 5000, like product/create and the domain", () => {
    const schema = contractString("product/update.description");
    expect(z.safeParse(schema as never, "a".repeat(5000)).success).toBe(true);
    expect(z.safeParse(schema as never, "a".repeat(5001)).success).toBe(false);
  });
});
