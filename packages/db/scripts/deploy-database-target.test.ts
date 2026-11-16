import { describe, expect, it } from "vitest";
import { deployDatabaseTarget, USAGE } from "./deploy-database-target";

const URLS = {
  PRODUCTION_MIGRATOR_DATABASE_URL: "postgresql://owner@prod.example/db",
  STAGING_MIGRATOR_DATABASE_URL: "postgresql://owner@stg.example/db",
};

describe("the target of the deploy database check", () => {
  it("is staging, with the staging owner's URL, when no environment is given", () => {
    expect(deployDatabaseTarget(["before-migrate"], URLS)).toEqual({
      environment: "staging",
      phase: "before-migrate",
      url: URLS.STAGING_MIGRATOR_DATABASE_URL,
      urlVariable: "STAGING_MIGRATOR_DATABASE_URL",
    });
  });

  it("reads the production owner's URL for --env production", () => {
    expect(
      deployDatabaseTarget(["after-migrate", "--env", "production"], URLS)
    ).toEqual({
      environment: "production",
      phase: "after-migrate",
      url: URLS.PRODUCTION_MIGRATOR_DATABASE_URL,
      urlVariable: "PRODUCTION_MIGRATOR_DATABASE_URL",
    });
  });

  it("never falls back to the staging URL when the production one is missing or blank", () => {
    const staging = {
      STAGING_MIGRATOR_DATABASE_URL: URLS.STAGING_MIGRATOR_DATABASE_URL,
    };
    expect(() =>
      deployDatabaseTarget(["before-migrate", "--env", "production"], staging)
    ).toThrow("PRODUCTION_MIGRATOR_DATABASE_URL is not set");
    expect(() =>
      deployDatabaseTarget(["before-migrate", "--env", "production"], {
        ...staging,
        PRODUCTION_MIGRATOR_DATABASE_URL: "  ",
      })
    ).toThrow("PRODUCTION_MIGRATOR_DATABASE_URL is not set");
  });

  it("never falls back to the production URL for staging", () => {
    expect(() =>
      deployDatabaseTarget(["before-migrate"], {
        PRODUCTION_MIGRATOR_DATABASE_URL: URLS.PRODUCTION_MIGRATOR_DATABASE_URL,
      })
    ).toThrow("STAGING_MIGRATOR_DATABASE_URL is not set");
  });

  it("takes --env before the phase, as the package scripts pass it", () => {
    expect(
      deployDatabaseTarget(["--env", "production", "before-migrate"], URLS)
        .environment
    ).toBe("production");
    expect(
      deployDatabaseTarget(["--env", "staging", "after-migrate"], URLS)
    ).toMatchObject({ environment: "staging", phase: "after-migrate" });
  });

  it.each([
    [[]],
    [["migrate"]],
    [["before-migrate", "after-migrate"]],
    [["--env", "production"]],
    [["before-migrate", "--environment", "production"]],
    [["before-migrate", "--env", "production", "--env", "staging"]],
    [["before-migrate", "production"]],
  ])("refuses the arguments %j", (args) => {
    expect(() => deployDatabaseTarget(args, URLS)).toThrow(USAGE);
  });

  it.each(["Production", "prod", "local", "constructor", "__proto__"])(
    "refuses the environment %s",
    (name) => {
      expect(() =>
        deployDatabaseTarget(["before-migrate", "--env", name], URLS)
      ).toThrow(`unknown environment "${name}"`);
    }
  );
});
