import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { ServerEnv } from "../environment";
import { requestIdMiddleware } from "./request-id";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function createApp() {
  const app = new Hono<ServerEnv>();
  app.use("*", requestIdMiddleware);
  app.get("/", (context) =>
    context.json({ requestId: context.get("requestId") })
  );
  return app;
}

async function requestWith(header?: string) {
  const response = await createApp().request("/", {
    headers: header === undefined ? {} : { "X-Request-Id": header },
  });
  const body = (await response.json()) as { requestId: string };
  return { body, header: response.headers.get("X-Request-Id") };
}

describe("request id middleware", () => {
  it("generates a UUID when the client sends nothing", async () => {
    const { body, header } = await requestWith();

    expect(body.requestId).toMatch(uuidPattern);
    expect(header).toBe(body.requestId);
  });

  it("keeps a well-formed client UUID", async () => {
    const supplied = "5f0f3a0e-9d63-4d7b-8a93-6f9a1f0f3a0e";
    const { body, header } = await requestWith(supplied);

    expect(body.requestId).toBe(supplied);
    expect(header).toBe(supplied);
  });

  it.each([
    "abc",
    "user@example.com",
    "not-a-uuid-but-looks-safe-1234567890",
    "5f0f3a0e-9d63-4d7b-8a93-6f9a1f0f3a0e-extra",
    "5f0f3a0e-9d63-4d7b-8a93-6f9a1f0f3a0e\n",
    "x".repeat(300),
  ])("replaces the arbitrary client value %j", async (supplied) => {
    const { body, header } = await requestWith(supplied);

    expect(body.requestId).toMatch(uuidPattern);
    expect(body.requestId).not.toBe(supplied);
    expect(header).toBe(body.requestId);
  });
});
