import { describe, expect, it } from "vitest";
import { localNamespace } from "./namespace";

const databaseFilePattern = /^polaris-local-[0-9a-f]{32}\.sqlite$/;

describe("local namespace", () => {
  it("is stable for the same user and organization", async () => {
    const first = await localNamespace("user-1", "org-1");
    const second = await localNamespace("user-1", "org-1");
    expect(second).toEqual(first);
    expect(first.databaseFile).toMatch(databaseFilePattern);
    expect(first.coordinatorName).toBe(`polaris-local-${first.key}`);
  });

  it("separates users and organizations", async () => {
    const base = await localNamespace("user-1", "org-1");
    const otherUser = await localNamespace("user-2", "org-1");
    const otherOrganization = await localNamespace("user-1", "org-2");
    expect(new Set([base.key, otherUser.key, otherOrganization.key]).size).toBe(
      3
    );
  });

  it("does not confuse ids that concatenate to the same text", async () => {
    const left = await localNamespace("ab", "c");
    const right = await localNamespace("a", "bc");
    expect(left.key).not.toBe(right.key);
  });

  it("never reveals the raw ids in the names", async () => {
    const namespace = await localNamespace("secret-user", "secret-org");
    for (const name of [namespace.databaseFile, namespace.coordinatorName]) {
      expect(name).not.toContain("secret");
    }
  });

  it("refuses empty or padded ids", async () => {
    for (const [user, organization] of [
      ["", "org"],
      ["user", ""],
      [" user", "org"],
      ["user", "org "],
    ] as const) {
      // biome-ignore lint/performance/noAwaitInLoops: each probe is verified on its own
      await expect(localNamespace(user, organization)).rejects.toThrow(
        "invalid_local_namespace_id"
      );
    }
  });
});
