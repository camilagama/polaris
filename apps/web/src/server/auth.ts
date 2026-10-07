import { betterAuth, type BetterAuthOptions } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { authSchema } from "@polaris/db/auth-schema";
import type { createDatabase } from "@polaris/db/client";

type PolarisDatabase = ReturnType<typeof createDatabase>["db"];

interface CreateBetterAuthOptions {
  baseURL: string;
  database: PolarisDatabase;
  plugins?: BetterAuthOptions["plugins"];
  secret: string;
}

export function createBetterAuth({
  baseURL,
  database,
  plugins,
  secret,
}: CreateBetterAuthOptions) {
  return betterAuth({
    appName: "Polaris",
    baseURL,
    database: drizzleAdapter(database, {
      provider: "pg",
      schema: authSchema,
    }),
    emailAndPassword: { enabled: false },
    ...(plugins ? { plugins } : {}),
    secret,
  });
}
