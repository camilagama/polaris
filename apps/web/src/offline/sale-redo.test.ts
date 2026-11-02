import type { InventoryBalanceEntryReadModel } from "@polaris/contracts";
import { describe, expect, it } from "vitest";
import { isSaleFormState } from "../sales/sale-draft-storage";
import type { OutboxCommand } from "./outbox/command";
import {
  buildRedoDraft,
  type RedoLineProblem,
  redoProblemText,
} from "./sale-redo";

const uuid = (n: number) =>
  `0199c2d0-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const MUG = uuid(10);
const SHIRT = uuid(11);

let ids = 0;
const createId = () => {
  ids += 1;
  return uuid(1000 + ids);
};

const entry = (
  overrides: Partial<InventoryBalanceEntryReadModel> & { variantId: string }
): InventoryBalanceEntryReadModel => ({
  isDefaultVariant: true,
  listPrice: "35.00",
  movingAverageCost: null,
  productId: uuid(20),
  productName: "Caneca",
  productStatus: "active",
  quantity: 10,
  sku: null,
  updatedAt: null,
  values: [],
  version: 1,
  ...overrides,
});

const sale = (payload: Record<string, unknown> = {}): OutboxCommand => ({
  attempts: 1,
  baseVersion: null,
  commandId: uuid(500),
  createdAt: "2026-11-02T10:00:00.000Z",
  deviceId: uuid(1),
  lastAttemptAt: null,
  lease: "lease",
  organizationId: uuid(2),
  payload: {
    adjustments: [],
    items: [
      {
        chargedUnitPrice: "35.00",
        listedUnitPrice: "40.00",
        quantity: 2,
        variantId: MUG,
      },
    ],
    occurredAt: "2026-11-02T10:00:00.000Z",
    payment: {
      anticipationRequested: false,
      installmentPlan: null,
      installments: null,
      method: "cash",
    },
    recordedAt: "2026-11-02T10:00:00.000Z",
    ...payload,
  },
  rejection: { at: "2026-11-02T11:00:00.000Z", code: "authorization_revoked" },
  seq: 1,
  status: "rejected",
  type: "sale.confirm",
});

describe("the form of a refused sale", () => {
  it("brings back the lines, quantities, prices, adjustments and payment, with fresh line ids", () => {
    const result = buildRedoDraft(
      sale({
        adjustments: [
          { kind: "discount", value: { percentage: "10", type: "percentage" } },
          { kind: "freight", value: { amount: "5.5", type: "fixed" } },
        ],
        items: [
          {
            chargedUnitPrice: "35.00",
            listedUnitPrice: "40.00",
            quantity: 2,
            variantId: MUG,
          },
          {
            chargedUnitPrice: "20.00",
            listedUnitPrice: "20.00",
            quantity: 1,
            variantId: SHIRT,
          },
        ],
        payment: {
          anticipationRequested: true,
          installmentPlan: "merchant",
          installments: 3,
          method: "credit_card",
        },
      }),
      [
        entry({ variantId: MUG }),
        entry({ productName: "Camisa", variantId: SHIRT }),
      ],
      createId
    );

    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") {
      return;
    }
    expect(result.form.items.map((item) => item.productId)).toEqual([
      uuid(20),
      uuid(20),
    ]);
    expect(
      result.form.items.map(
        ({
          chargedUnitPrice,
          label,
          listedUnitPrice,
          quantity,
          variantId,
        }) => ({
          chargedUnitPrice,
          label,
          listedUnitPrice,
          quantity,
          variantId,
        })
      )
    ).toEqual([
      {
        chargedUnitPrice: "35,00",
        label: expect.stringContaining("Caneca"),
        listedUnitPrice: "40,00",
        quantity: "2",
        variantId: MUG,
      },
      {
        chargedUnitPrice: "20,00",
        label: expect.stringContaining("Camisa"),
        listedUnitPrice: "20,00",
        quantity: "1",
        variantId: SHIRT,
      },
    ]);
    expect(
      result.form.adjustments.map(({ kind, value, valueType }) => ({
        kind,
        value,
        valueType,
      }))
    ).toEqual([
      { kind: "discount", value: "10", valueType: "percentage" },
      { kind: "freight", value: "5,50", valueType: "fixed" },
    ]);
    expect(result.form.payment).toEqual({
      anticipationRequested: true,
      installmentPlan: "merchant",
      installments: "3",
      method: "credit_card",
    });
    expect(result.form.profile.choice).toBe("none");
    expect(isSaleFormState(result.form)).toBe(true);
  });

  it("carries the payment profile it was priced with, by id and version", () => {
    const result = buildRedoDraft(
      sale({ paymentProfile: { expectedVersion: 4, id: uuid(77) } }),
      [entry({ variantId: MUG })],
      createId
    );
    expect(result.kind === "ready" && result.form.profile).toEqual({
      choice: uuid(77),
      reviewNotice: null,
      seenVersion: 4,
    });
  });

  it("does not fill the form when a variant left the catalog, and says which line", () => {
    const result = buildRedoDraft(sale(), [], createId);
    expect(result).toEqual({
      kind: "blocked",
      problems: [{ kind: "unavailable", label: "Item 1 (2 un. a R$ 35,00)" }],
    });
  });

  it("does not fill the form when the product was archived", () => {
    const result = buildRedoDraft(
      sale(),
      [entry({ productStatus: "archived", variantId: MUG })],
      createId
    );
    expect(result).toEqual({
      kind: "blocked",
      problems: [{ kind: "archived", label: "Caneca" }],
    });
  });

  it("does not fill the form when the stock no longer covers the sale, summing lines of one variant", () => {
    const line = {
      chargedUnitPrice: "35.00",
      listedUnitPrice: "35.00",
      quantity: 2,
      variantId: MUG,
    };
    const result = buildRedoDraft(
      sale({ items: [line, line] }),
      [entry({ quantity: 3, variantId: MUG })],
      createId
    );
    expect(result).toEqual({
      kind: "blocked",
      problems: [
        { available: 3, kind: "short", label: "Caneca", requested: 4 },
      ],
    });
  });

  it("says an archived product once, however many lines sell it", () => {
    const line = {
      chargedUnitPrice: "35.00",
      listedUnitPrice: "35.00",
      quantity: 1,
      variantId: MUG,
    };
    const result = buildRedoDraft(
      sale({ items: [line, line] }),
      [entry({ productStatus: "archived", variantId: MUG })],
      createId
    );
    expect(result.kind === "blocked" && result.problems).toHaveLength(1);
  });

  it("names the variant, not only the product, so two sizes are not mistaken", () => {
    const result = buildRedoDraft(
      sale(),
      [
        entry({
          quantity: 0,
          values: [{ optionName: "Tamanho", optionValueName: "G" }],
          variantId: MUG,
        }),
      ],
      createId
    );
    expect(result.kind === "blocked" && result.problems[0]?.label).toContain(
      "G"
    );
  });

  it("lists every problem, not only the first, and fills nothing from the lines that are fine", () => {
    const result = buildRedoDraft(
      sale({
        items: [
          {
            chargedUnitPrice: "35.00",
            listedUnitPrice: "35.00",
            quantity: 1,
            variantId: MUG,
          },
          {
            chargedUnitPrice: "20.00",
            listedUnitPrice: "20.00",
            quantity: 1,
            variantId: SHIRT,
          },
        ],
      }),
      [entry({ variantId: MUG })],
      createId
    );
    expect(result.kind).toBe("blocked");
    expect(result.kind === "blocked" && result.problems).toHaveLength(1);
  });

  it("reads a payload it cannot understand as unreadable, never as an empty sale", () => {
    expect(buildRedoDraft(sale({ items: [] }), [], createId)).toEqual({
      kind: "unreadable",
    });
    expect(buildRedoDraft({ ...sale(), payload: "x" }, [], createId)).toEqual({
      kind: "unreadable",
    });
  });
});

describe("what stopped the redo, in words", () => {
  it("names the line and the reason for each kind", () => {
    const problems: RedoLineProblem[] = [
      { kind: "archived", label: "Caneca" },
      { available: 1, kind: "short", label: "Camisa", requested: 3 },
      { kind: "unavailable", label: "Item 2 (1 un. a R$ 9,00)" },
    ];
    expect(problems.map(redoProblemText)).toEqual([
      "Caneca: o produto foi arquivado e não está mais à venda.",
      "Camisa: a venda tinha 3 un. e o saldo é 1.",
      "Item 2 (1 un. a R$ 9,00): não está mais no catálogo.",
    ]);
  });
});
