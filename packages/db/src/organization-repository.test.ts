import { describe, expect, it, vi } from "vitest";
import type { createDatabase } from "./client";
import { createInitialOrganizationInDatabase } from "./organization-repository";

type Database = ReturnType<typeof createDatabase>["db"];

describe("createInitialOrganizationInDatabase", () => {
  it("uses the controlled database writer and maps its atomic result", async () => {
    const createdAt = new Date("2026-10-08T12:00:00.000Z");
    const updatedAt = new Date("2026-10-08T12:00:00.000Z");
    const execute = vi.fn(async () => ({
      rows: [
        {
          created: true,
          created_at: createdAt,
          currency: "BRL",
          id: "7b9c212a-f90b-4e05-9e9a-0c0eb1c9c9b0",
          name: "Polaris",
          status: "active",
          timezone: "America/Sao_Paulo",
          updated_at: updatedAt,
        },
      ],
    }));
    const transaction = vi.fn(() =>
      Promise.reject(new Error("unexpected direct onboarding transaction"))
    );
    const database = { execute, transaction } as unknown as Database;

    await expect(
      createInitialOrganizationInDatabase(database, {
        id: "7b9c212a-f90b-4e05-9e9a-0c0eb1c9c9b0",
        name: "Polaris",
        timezone: "America/Sao_Paulo",
        userId: "session-user-17",
      })
    ).resolves.toMatchObject({
      created: true,
      organization: {
        currency: "BRL",
        id: "7b9c212a-f90b-4e05-9e9a-0c0eb1c9c9b0",
        name: "Polaris",
        status: "active",
        timezone: "America/Sao_Paulo",
      },
    });

    expect(execute).toHaveBeenCalledOnce();
    expect(transaction).not.toHaveBeenCalled();
  });
});
