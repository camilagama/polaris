import { describe, expect, it, vi } from "vitest";
import {
  currentAuthRequestState,
  currentEmailDelivery,
  currentRequestId,
  requestScopedDatabase,
  requestScopedEmailDelivery,
  runInRequestBackground,
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

  it("fails closed outside a request for a write, a listing of keys and the prototype too", () => {
    const database = requestScopedDatabase() as unknown as Record<
      string,
      unknown
    >;

    expect(() => {
      database.name = "outside";
    }).toThrow("request_database_unavailable");
    expect(() => Object.keys(database)).toThrow("request_database_unavailable");
    expect(() => Reflect.ownKeys(database)).toThrow(
      "request_database_unavailable"
    );
    expect(() => Object.getPrototypeOf(database)).toThrow(
      "request_database_unavailable"
    );
    expect(() => database instanceof Object).toThrow(
      "request_database_unavailable"
    );
    for (const use of [
      () => Object.getOwnPropertyDescriptor(database, "name"),
      () => Object.defineProperty(database, "name", { value: "outside" }),
      () => Reflect.deleteProperty(database, "name"),
      () => Object.setPrototypeOf(database, null),
      () => Object.preventExtensions(database),
      () => Object.isExtensible(database),
    ]) {
      expect(use).toThrow("request_database_unavailable");
    }
  });

  it("forwards a write, the keys and the prototype to the database of the running request", async () => {
    class NamedDatabase {
      name = "inside";
    }
    const real = new NamedDatabase() as unknown as Database & {
      name: string;
    };
    const database = requestScopedDatabase() as unknown as {
      name: string;
    };

    await runWithRequestScope(
      { database: real, requestId: "request-3" },
      () => {
        database.name = "written";
        expect(real.name).toBe("written");
        expect(Reflect.ownKeys(database)).toEqual(["name"]);
        expect(Object.keys(database)).toEqual(["name"]);
        expect(database).toBeInstanceOf(NamedDatabase);
        return Promise.resolve();
      }
    );
  });

  it("gives each request a state of its own, and none outside", async () => {
    const states = await Promise.all(
      ["one", "two"].map((requestId) =>
        runWithRequestScope(
          { database: fakeDatabase(requestId), requestId },
          async () => {
            const state = currentAuthRequestState();
            state.logoutActorId = `actor-${requestId}`;
            state.recordedSessionIps.set("session", requestId);
            await Promise.resolve();
            return currentAuthRequestState();
          }
        )
      )
    );

    expect(states.map((state) => state.logoutActorId)).toEqual([
      "actor-one",
      "actor-two",
    ]);
    expect(states[0]?.recordedSessionIps.get("session")).toBe("one");
    expect(states[0]).not.toBe(states[1]);
    expect(() => currentAuthRequestState()).toThrow(
      "request_database_unavailable"
    );
  });

  it("hands a background task to the waitUntil of the request that made it", async () => {
    const waitUntilOne = vi.fn();
    const waitUntilTwo = vi.fn();
    const task = Promise.resolve();

    await runWithRequestScope(
      {
        database: fakeDatabase("one"),
        requestId: "one",
        runInBackground: waitUntilOne,
      },
      () => {
        runInRequestBackground(task);
        return Promise.resolve();
      }
    );
    await runWithRequestScope(
      {
        database: fakeDatabase("two"),
        requestId: "two",
        runInBackground: waitUntilTwo,
      },
      () => Promise.resolve()
    );

    expect(waitUntilOne).toHaveBeenCalledWith(task);
    expect(waitUntilTwo).not.toHaveBeenCalled();
    expect(() => runInRequestBackground(task)).toThrow(
      "request_database_unavailable"
    );
  });

  it("sends the e-mails through the delivery of the running request, and refuses without one", async () => {
    const delivery = requestScopedEmailDelivery();
    const sendPasswordReset = vi.fn(() => Promise.resolve());
    const sendVerificationEmail = vi.fn(() => Promise.resolve());
    const data = {
      token: "t",
      url: "https://example.invalid",
      user: { email: "a@example.invalid", id: "u" },
    } as Parameters<typeof delivery.sendPasswordReset>[0];

    await runWithRequestScope(
      {
        database: fakeDatabase("one"),
        emailDelivery: { sendPasswordReset, sendVerificationEmail },
        requestId: "one",
      },
      async () => {
        await delivery.sendPasswordReset(data);
        await delivery.sendVerificationEmail(data);
        // a delivery without the e-mail to an existing account sends nothing
        await delivery.sendExistingAccount?.({ user: data.user });
      }
    );
    await runWithRequestScope(
      { database: fakeDatabase("two"), requestId: "two" },
      () => {
        expect(() => currentEmailDelivery()).toThrow(
          "request_email_unavailable"
        );
        expect(() => delivery.sendPasswordReset(data)).toThrow(
          "request_email_unavailable"
        );
        return Promise.resolve();
      }
    );

    expect(sendPasswordReset).toHaveBeenCalledTimes(1);
    expect(sendVerificationEmail).toHaveBeenCalledTimes(1);
  });
});
