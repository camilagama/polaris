import { describe, expect, it } from "vitest";
import {
  currentRequestId,
  requestScopedDatabase,
  runWithRequestScope,
} from "./request-database";

type Database = Parameters<typeof runWithRequestScope>[0]["database"];

function fakeDatabase(name: string) {
  return {
    $client: { name },
    name,
    whoAmI() {
      return (this as { name: string }).name;
    },
  } as unknown as Database & { name: string; whoAmI: () => string };
}

describe("request-scoped database", () => {
  it("has no database outside a request scope", () => {
    const database = requestScopedDatabase() as unknown as { name: string };

    expect(() => database.name).toThrow("request_database_unavailable");
    expect(() => currentRequestId()).toThrow("request_database_unavailable");
  });

  it("forwards reads and bound calls to the database of the running request", async () => {
    const database = requestScopedDatabase() as unknown as {
      name: string;
      whoAmI: () => string;
    };

    await runWithRequestScope(
      { database: fakeDatabase("first"), requestId: "request-1" },
      async () => {
        await Promise.resolve();
        expect(database.name).toBe("first");
        expect(database.whoAmI()).toBe("first");
        expect(currentRequestId()).toBe("request-1");
      }
    );
  });

  it("keeps two requests that overlap on their own database", async () => {
    const database = requestScopedDatabase() as unknown as { name: string };
    const seen: string[] = [];
    const request = (name: string, waitMilliseconds: number) =>
      runWithRequestScope(
        { database: fakeDatabase(name), requestId: name },
        async () => {
          seen.push(`${name}:before:${database.name}`);
          await new Promise((resolve) => setTimeout(resolve, waitMilliseconds));
          seen.push(`${name}:after:${database.name}`);
        }
      );

    await Promise.all([request("slow", 20), request("fast", 1)]);

    expect(seen.sort()).toEqual([
      "fast:after:fast",
      "fast:before:fast",
      "slow:after:slow",
      "slow:before:slow",
    ]);
  });

  it("holds nothing once the request is over", async () => {
    const database = requestScopedDatabase() as unknown as { name: string };

    await runWithRequestScope(
      { database: fakeDatabase("gone"), requestId: "request-2" },
      () => Promise.resolve()
    );

    expect(() => database.name).toThrow("request_database_unavailable");
  });
});
