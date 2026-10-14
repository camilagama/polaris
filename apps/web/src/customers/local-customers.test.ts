import type { LocalCustomerReadModel } from "@polaris/contracts";
import { describe, expect, it } from "vitest";
import {
  findLocalDuplicates,
  listLocalCustomers,
  toCustomerReadModel,
  toLocalCustomerRow,
} from "./local-customers";

const ORG = "org-1";
const AT = "2026-10-14T12:00:00.000Z";
const uuid = (n: number) =>
  `0199c2d0-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const row = (
  n: number,
  overrides: Partial<LocalCustomerReadModel> = {}
): LocalCustomerReadModel => ({
  archivedAt: null,
  email: null,
  id: uuid(n),
  name: `Cliente ${n}`,
  notes: null,
  phone: null,
  updatedAt: AT,
  version: 1,
  ...overrides,
});

describe("local customers", () => {
  it("rebuilds the screen's shape and back without losing a field", () => {
    const local = row(1, {
      email: "a@b.com",
      notes: "VIP",
      phone: "1199",
      version: 3,
    });
    const model = toCustomerReadModel(local, ORG);
    expect(model).toMatchObject({
      organizationId: ORG,
      status: "active",
      version: 3,
    });
    expect(toLocalCustomerRow(model)).toEqual(local);
    expect(toCustomerReadModel(row(2, { archivedAt: AT }), ORG).status).toBe(
      "archived"
    );
  });

  it("lists one state by name, then ID, accents and case aside", () => {
    const rows = [
      row(1, { name: "Zeca" }),
      row(2, { name: "ana" }),
      row(3, { name: "Álvaro" }),
      row(4, { archivedAt: AT, name: "Arquivada" }),
      row(5, { name: "Ana" }),
    ];
    expect(listLocalCustomers(rows, ORG, "active").map((c) => c.name)).toEqual([
      "Álvaro",
      "ana",
      "Ana",
      "Zeca",
    ]);
    expect(
      listLocalCustomers(rows, ORG, "archived").map((c) => c.name)
    ).toEqual(["Arquivada"]);
  });

  it("finds possible duplicates by e-mail (any case) and exact phone, archived ones too", () => {
    const rows = [
      row(1, { email: "Ana@Example.com", name: "Ana" }),
      row(2, { name: "Bia", phone: "1199" }),
      row(3, { archivedAt: AT, email: "ana@example.com", name: "Ana antiga" }),
      row(4, { name: "Carla", phone: "11990" }),
    ];
    const matches = findLocalDuplicates(rows, ORG, {
      email: " ana@example.COM ",
      phone: "1199",
    });
    expect(
      matches.map((match) => [match.customer.name, match.matchedBy])
    ).toEqual([
      ["Ana", ["email"]],
      ["Ana antiga", ["email"]],
      ["Bia", ["phone"]],
    ]);
  });

  it("matches on both fields when both agree, and refuses an empty search", () => {
    const rows = [row(1, { email: "a@b.com", phone: "1" })];
    expect(
      findLocalDuplicates(rows, ORG, { email: "a@b.com", phone: "1" })[0]
        ?.matchedBy
    ).toEqual(["email", "phone"]);
    expect(() => findLocalDuplicates(rows, ORG, { email: " " })).toThrow();
  });
});
