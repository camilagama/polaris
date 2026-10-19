import { describe, expect, it } from "vitest";
import { sentryIngestOrigin } from "./sentry-dsn";

/** Fake values: the key is made up and the project does not exist. */
const dsn = (host: string, path = "/1", key = "chavefalsa") =>
  `https://${key}@${host}${path}`;

describe("the ingest origin of a DSN", () => {
  it("is the https origin of the host, for a well-formed Sentry DSN", () => {
    expect(sentryIngestOrigin(dsn("o1.ingest.sentry.io"))).toBe(
      "https://o1.ingest.sentry.io"
    );
    expect(sentryIngestOrigin(dsn("o1.ingest.us.sentry.io", "/42"))).toBe(
      "https://o1.ingest.us.sentry.io"
    );
  });

  it.each([
    undefined,
    "",
    "not a url",
    "http://chavefalsa@o1.ingest.sentry.io/1",
    "https://o1.ingest.sentry.io/1",
    "https://chavefalsa:senha@o1.ingest.sentry.io/1",
    "https://chavefalsa@o1.ingest.sentry.io:8443/1",
    "https://chavefalsa@o1.ingest.sentry.io/1?x=1",
    "https://chavefalsa@o1.ingest.sentry.io/1#x",
    "https://chavefalsa@o1.ingest.sentry.io/projeto",
    "https://chavefalsa@o1.ingest.sentry.io/",
    "https://chavefalsa@sentry.io/1",
    "https://chavefalsa@.sentry.io/1",
    "https://chavefalsa@o1.ingest.sentry.io.example.com/1",
    "https://chavefalsa@acme.sentry.io/1",
    "https://chavefalsa@o1.ingest.sentry.io.evil.com/1",
    "https://chavefalsa@example.com/1",
    "https://chavefalsa@evil-sentry.io/1",
  ])("is null for %j", (value) => {
    expect(sentryIngestOrigin(value)).toBeNull();
  });
});
