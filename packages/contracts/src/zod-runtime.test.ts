import { expect, it } from "vitest";
import { config } from "zod";

// the contracts module is what turns zod's `new Function` probe off (the pages run under a CSP without
// 'unsafe-eval'); importing it is enough, and nothing may build a schema before it does
await import("./index");

it("turns the code generation of zod off, so no browser reports a CSP violation for its probe", () => {
  expect(config().jitless).toBe(true);
});
