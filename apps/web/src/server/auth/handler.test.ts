import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkerBindings } from "../environment";
import { handleBetterAuthRequest } from "./handler";

describe("Better Auth handler database role", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fails closed with a generic 503 when a deployed Worker has no AUTH_HYPERDRIVE", async () => {
    const logger = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const bindings: WorkerBindings = {
      BETTER_AUTH_BASE_URL: "https://polaris.example.invalid",
      BETTER_AUTH_SECRET: "a".repeat(32),
      HYPERDRIVE: { connectionString: "postgresql://tenant.invalid/neondb" },
    };

    const response = await handleBetterAuthRequest(
      new Request("https://polaris.example.invalid/api/auth/get-session"),
      bindings,
      "5f0f3a0e-9d63-4d7b-8a93-6f9a1f0f3a0e"
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: { code: "auth_unavailable" },
    });
    expect(logger).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "auth_database_not_configured",
        requestId: "5f0f3a0e-9d63-4d7b-8a93-6f9a1f0f3a0e",
      })
    );
  });
});
