import { describe, expect, it } from "vitest";
import {
  checkDirectory,
  checkMigration,
  findMarker,
  LAST_GRANDFATHERED,
  migrationsDirectory,
} from "./verify-migration-compat.mjs";

const NEW = `${String(LAST_GRANDFATHERED + 1).padStart(4, "0")}_x.sql`;
const OLD = `${String(LAST_GRANDFATHERED).padStart(4, "0")}_x.sql`;

const rejected = (sql) => checkMigration(NEW, sql);

describe("expand/contract guard", () => {
  it.each([
    ['ALTER TABLE "t" DROP COLUMN "c";', "DROP COLUMN"],
    ['ALTER TABLE "t" RENAME COLUMN "a" TO "b";', "RENAME"],
    ['ALTER TABLE "t" RENAME TO "u";', "RENAME"],
    ['ALTER TABLE "t" RENAME CONSTRAINT "a" TO "b";', "RENAME"],
    ['ALTER TABLE "t" ALTER COLUMN "c" SET NOT NULL;', "SET NOT NULL"],
    [
      'ALTER TABLE "t" ADD COLUMN "c" text NOT NULL;',
      "NOT NULL without DEFAULT",
    ],
    [
      'ALTER TABLE "t" ADD COLUMN "a" text, ADD COLUMN "c" integer NOT NULL;',
      "NOT NULL without DEFAULT",
    ],
    ['ALTER TABLE "t" ALTER COLUMN "c" SET DATA TYPE bigint;', "TYPE"],
    ['ALTER TABLE "t" ALTER COLUMN "c" TYPE bigint;', "TYPE"],
    ['ALTER TABLE "t" DROP "c";', "DROP COLUMN"],
    ['ALTER TABLE "t" DROP IF EXISTS "c";', "DROP COLUMN"],
    ['DROP TABLE "t";', "DROP TABLE"],
    ["DROP ROUTINE public.f(uuid);", "DROP FUNCTION"],
    ["DO $x$ BEGIN ALTER TABLE t RENAME COLUMN a TO b; END $x$;", "RENAME"],
    [
      "DO $x$ BEGIN ALTER TABLE t ADD COLUMN c text NOT NULL; END $x$;",
      "NOT NULL without DEFAULT",
    ],
    ["DROP FUNCTION public.f(uuid);", "DROP FUNCTION"],
    ["DO $x$ BEGIN ALTER TABLE t DROP COLUMN c; END $x$;", "DROP COLUMN"],
  ])("rejects %s", (sql, what) => {
    const problems = rejected(sql);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(what);
  });

  it.each([
    'ALTER TABLE "t" ADD COLUMN "c" text;',
    'ALTER TABLE "t" ADD COLUMN "c" text NOT NULL DEFAULT \'\';',
    'ALTER TABLE "t" ADD COLUMN "c" timestamp with time zone DEFAULT now() NOT NULL;',
    'ALTER TABLE "t" ADD COLUMN "c" bigint GENERATED ALWAYS AS IDENTITY NOT NULL;',
    'ALTER TABLE "t" ADD CONSTRAINT "k" CHECK ("c" IS NOT NULL);',
    'CREATE TABLE "t" ("id" uuid NOT NULL, "n" text NOT NULL);',
    'ALTER TYPE "public"."e" ADD VALUE \'v\';',
    'ALTER TABLE "t" ENABLE ROW LEVEL SECURITY;',
    'ALTER TABLE "t" ALTER COLUMN "c" DROP DEFAULT;',
    'ALTER TABLE "t" ALTER COLUMN "c" DROP NOT NULL;',
    'ALTER TABLE "t" DROP CONSTRAINT "k";',
    'CREATE INDEX "i" ON "t" ("c");',
    'DROP INDEX "i";',
    'DROP POLICY "p" ON "t";',
    "CREATE OR REPLACE FUNCTION public.f() RETURNS void LANGUAGE sql AS $$ SELECT 1 $$;",
    "-- DROP COLUMN in a comment is fine\nSELECT 1;",
    "SELECT 'DROP COLUMN in a string';",
  ])("accepts %s", (sql) => {
    expect(rejected(sql)).toEqual([]);
  });

  it("reports every violation of the file", () => {
    expect(
      rejected(
        'ALTER TABLE "t" DROP COLUMN "c";--> statement-breakpoint\nALTER TABLE "t" RENAME TO "u";'
      )
    ).toHaveLength(2);
  });

  it("accepts a violation with a marker that has a reason", () => {
    const sql = (marker) => `${marker}\nALTER TABLE "t" DROP COLUMN "c";`;
    expect(
      rejected(sql("-- expand-contract: contract coluna sem uso desde a v1.4"))
    ).toEqual([]);
    expect(
      rejected(sql("-- expand-contract: janela troca de tipo, sem tráfego"))
    ).toEqual([]);
  });

  it("does not accept a marker without a reason or of another kind", () => {
    const sql = (marker) => `${marker}\nALTER TABLE "t" DROP COLUMN "c";`;
    expect(rejected(sql("-- expand-contract: contract"))).toHaveLength(1);
    expect(rejected(sql("-- expand-contract: janela   "))).toHaveLength(1);
    expect(rejected(sql("-- expand-contract: ok motivo"))).toHaveLength(1);
    expect(rejected(sql("-- contract: motivo"))).toHaveLength(1);
    expect(rejected(sql("-- expand-contract: contract -"))).toHaveLength(1);
  });

  it("reads the marker", () => {
    expect(
      findMarker("-- expand-contract: janela porque sim\nSELECT 1;")
    ).toEqual({
      kind: "janela",
      reason: "porque sim",
    });
    expect(findMarker("SELECT 1;")).toBeNull();
  });

  it("fails a file that is not named NNNN_name.sql", () => {
    expect(checkMigration("oops.sql", "SELECT 1;")).toHaveLength(1);
  });

  it("does not check migrations merged before go-live", () => {
    expect(checkMigration(OLD, 'ALTER TABLE "t" DROP COLUMN "c";')).toEqual([]);
  });

  it("passes on the migrations of the repository", () => {
    expect(checkDirectory(migrationsDirectory)).toEqual([]);
  });
});
