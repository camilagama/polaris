import { describe, expect, it } from "vitest";
import {
  AuthDatabaseNotConfiguredError,
  resolveAuthConnectionString,
} from "./auth-database";

const tenant = { connectionString: "postgresql://tenant.invalid/db" };
const auth = { connectionString: "postgresql://auth.invalid/db" };

describe("resolveAuthConnectionString", () => {
  it("uses the dedicated auth Hyperdrive whenever it is bound", () => {
    expect(
      resolveAuthConnectionString({
        AUTH_HYPERDRIVE: auth,
        BETTER_AUTH_BASE_URL: "https://polaris.example.invalid",
        HYPERDRIVE: tenant,
      })
    ).toBe(auth.connectionString);
    expect(
      resolveAuthConnectionString({
        AUTH_HYPERDRIVE: auth,
        BETTER_AUTH_BASE_URL: "http://127.0.0.1:5173",
        HYPERDRIVE: tenant,
      })
    ).toBe(auth.connectionString);
  });

  it.each([
    "http://localhost",
    "http://127.0.0.1:5173",
    "http://app.localhost:8787",
  ])("falls back to the tenant Hyperdrive only for loopback %s", (baseURL) => {
    expect(
      resolveAuthConnectionString({
        BETTER_AUTH_BASE_URL: baseURL,
        HYPERDRIVE: tenant,
      })
    ).toBe(tenant.connectionString);
  });

  it.each([
    "https://polaris.example.invalid",
    "https://localhost.evil.example",
    "not a url",
    undefined,
  ])("fails closed outside local development (%s)", (baseURL) => {
    expect(() =>
      resolveAuthConnectionString({
        ...(baseURL === undefined ? {} : { BETTER_AUTH_BASE_URL: baseURL }),
        HYPERDRIVE: tenant,
      })
    ).toThrow(AuthDatabaseNotConfiguredError);
  });
});
