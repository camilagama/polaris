import { defineConfig } from "drizzle-kit";

export default defineConfig({
  casing: "snake_case",
  dbCredentials: {
    url:
      process.env.DATABASE_URL ??
      "postgresql://postgres:postgres@127.0.0.1:5432/polaris",
  },
  dialect: "postgresql",
  out: "./drizzle",
  schema: "./src/schema/*.ts",
});
