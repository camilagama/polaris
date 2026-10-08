import { describe, expect, it, vi } from "vitest";
import type { createDatabase } from "@polaris/db/client";
import { createInitialOrganization } from "./create-initial-organization";

type Database = ReturnType<typeof createDatabase>["db"];

function databaseWithoutQueries() {
  const transaction = vi.fn();
  return {
    database: { transaction } as unknown as Database,
    transaction,
  };
}

describe("createInitialOrganization input validation", () => {
  it("rejects a blank user ID before opening a transaction", async () => {
    const { database, transaction } = databaseWithoutQueries();

    await expect(
      createInitialOrganization(database, {
        name: "Polaris",
        timezone: "America/Sao_Paulo",
        authenticatedUserId: "   ",
      })
    ).rejects.toMatchObject({ code: "invalid_user_id" });
    expect(transaction).not.toHaveBeenCalled();
  });

  it("rejects a user ID with surrounding whitespace", async () => {
    const { database, transaction } = databaseWithoutQueries();

    await expect(
      createInitialOrganization(database, {
        name: "Polaris",
        timezone: "America/Sao_Paulo",
        authenticatedUserId: " verified-user ",
      })
    ).rejects.toMatchObject({ code: "invalid_user_id" });
    expect(transaction).not.toHaveBeenCalled();
  });
  it("rejects a blank organization name before opening a transaction", async () => {
    const { database, transaction } = databaseWithoutQueries();

    await expect(
      createInitialOrganization(database, {
        name: "  ",
        timezone: "America/Sao_Paulo",
        authenticatedUserId: "verified-user",
      })
    ).rejects.toMatchObject({ code: "invalid_organization_name" });
    expect(transaction).not.toHaveBeenCalled();
  });

  it("rejects an invalid IANA timezone before opening a transaction", async () => {
    const { database, transaction } = databaseWithoutQueries();

    await expect(
      createInitialOrganization(database, {
        name: "Polaris",
        timezone: "Mars/Olympus_Mons",
        authenticatedUserId: "verified-user",
      })
    ).rejects.toMatchObject({ code: "invalid_timezone" });
    expect(transaction).not.toHaveBeenCalled();
  });
});
