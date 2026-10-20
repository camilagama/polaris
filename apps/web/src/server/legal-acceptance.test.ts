import { LEGAL_DOCUMENTS } from "@polaris/domain/legal/legal-documents";
import { describe, expect, it, vi } from "vitest";
import type { WorkerBindings } from "./environment";
import {
  exemptRpcRequest,
  isExemptFromLegalAcceptance,
  isLegalAcceptanceEnforced,
  LEGAL_ACCEPTANCE_EXEMPT_PROCEDURES,
  type LegalAcceptanceQueryable,
  LegalAcceptanceRecordError,
  legalAcceptanceStatus,
  pendingLegalAcceptance,
  readAcceptedLegalVersions,
  recordLegalAcceptance,
} from "./legal-acceptance";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function fakeConnection(rows: Record<string, unknown>[]) {
  const query = vi.fn(
    async (_config: Parameters<LegalAcceptanceQueryable["query"]>[0]) => ({
      rows,
    })
  );
  return { connection: { query } satisfies LegalAcceptanceQueryable, query };
}

describe("readAcceptedLegalVersions", () => {
  it("reads the highest accepted version of each document through the database function with the user as $1", async () => {
    const { connection, query } = fakeConnection([
      { document: "terms", version: 1 },
      { document: "privacy", version: 2 },
    ]);

    await expect(
      readAcceptedLegalVersions(connection, "user-9")
    ).resolves.toEqual({
      privacy: 2,
      terms: 1,
    });

    expect(query).toHaveBeenCalledTimes(1);
    const config = query.mock.calls[0]?.[0];
    expect(config?.text).toContain("public.legal_acceptance_versions($1");
    expect(config?.values).toEqual(["user-9"]);
    expect(config?.query_timeout).toBeGreaterThan(0);
  });

  it("ignores an unknown document and a version that is not an integer", async () => {
    const { connection } = fakeConnection([
      { document: "cookies", version: 3 },
      { document: "terms", version: "1" },
      { document: "privacy", version: 1.5 },
      { document: "privacy", version: 1 },
    ]);

    await expect(
      readAcceptedLegalVersions(connection, "user-9")
    ).resolves.toEqual({
      privacy: 1,
    });
  });

  it("answers nothing accepted for a user without rows", async () => {
    const { connection } = fakeConnection([]);
    await expect(
      readAcceptedLegalVersions(connection, "user-9")
    ).resolves.toEqual({});
  });

  it("lets a database failure through (the control fails closed)", async () => {
    const connection = {
      query: vi.fn(() => Promise.reject(new Error("connection lost"))),
    };
    await expect(
      readAcceptedLegalVersions(connection, "user-9")
    ).rejects.toThrow("connection lost");
  });
});

describe("recordLegalAcceptance", () => {
  it("sends the version and the hash of the server constant, the origin and the request id", async () => {
    const { connection, query } = fakeConnection([{ result: "recorded" }]);

    await expect(
      recordLegalAcceptance(connection, {
        document: "terms",
        origin: "reaceite",
        requestId: "req-123_ok",
        userId: "user-9",
      })
    ).resolves.toBe("recorded");

    const config = query.mock.calls[0]?.[0];
    expect(config?.text).toContain("public.record_legal_acceptance(");
    expect(config?.values).toEqual([
      "user-9",
      "terms",
      LEGAL_DOCUMENTS.terms.version,
      LEGAL_DOCUMENTS.terms.sha256,
      "reaceite",
      "req-123_ok",
    ]);
  });

  it("uses the hash of the document asked for, never another", async () => {
    const { connection, query } = fakeConnection([{ result: "recorded" }]);

    await recordLegalAcceptance(connection, {
      document: "privacy",
      origin: "signup",
      requestId: "req-1",
      userId: "user-9",
    });

    const values = query.mock.calls[0]?.[0].values;
    expect(values?.[1]).toBe("privacy");
    expect(values?.[3]).toBe(LEGAL_DOCUMENTS.privacy.sha256);
    expect(values?.[3]).not.toBe(LEGAL_DOCUMENTS.terms.sha256);
    expect(values?.[4]).toBe("signup");
  });

  it.each([
    ["empty", ""],
    ["with a space", "req 1"],
    ["with a slash", "req/1"],
    ["too long", "a".repeat(65)],
  ])(
    "replaces a request id that is %s by a fresh UUID",
    async (_name, requestId) => {
      const { connection, query } = fakeConnection([{ result: "recorded" }]);

      await recordLegalAcceptance(connection, {
        document: "terms",
        origin: "reaceite",
        requestId,
        userId: "user-9",
      });

      const sent = query.mock.calls[0]?.[0].values[5];
      expect(sent).not.toBe(requestId);
      expect(sent).toMatch(uuidPattern);
    }
  );

  it("keeps a request id of exactly 64 allowed characters", async () => {
    const { connection, query } = fakeConnection([{ result: "recorded" }]);
    const requestId = `${"a".repeat(32)}-${"B".repeat(31)}`;
    expect(requestId).toHaveLength(64);

    await recordLegalAcceptance(connection, {
      document: "terms",
      origin: "reaceite",
      requestId,
      userId: "user-9",
    });

    expect(query.mock.calls[0]?.[0].values[5]).toBe(requestId);
  });

  it("answers already_accepted when the database says so", async () => {
    const { connection } = fakeConnection([{ result: "already_accepted" }]);
    await expect(
      recordLegalAcceptance(connection, {
        document: "terms",
        origin: "reaceite",
        requestId: "req-1",
        userId: "user-9",
      })
    ).resolves.toBe("already_accepted");
  });

  it.each([
    ["invalid_hash", [{ result: "invalid_hash" }]],
    ["no_result", []],
    ["no_result", [{ result: null }]],
  ])(
    "throws LegalAcceptanceRecordError (%s) for a refusal of the database",
    async (result, rows) => {
      const { connection } = fakeConnection(rows);

      const failure = await recordLegalAcceptance(connection, {
        document: "terms",
        origin: "reaceite",
        requestId: "req-1",
        userId: "user-9",
      }).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(LegalAcceptanceRecordError);
      expect((failure as LegalAcceptanceRecordError).result).toBe(result);
      expect((failure as LegalAcceptanceRecordError).message).toBe(
        "legal_acceptance_not_recorded"
      );
    }
  );
});

describe("isLegalAcceptanceEnforced", () => {
  const enforced = (value: string | undefined) =>
    isLegalAcceptanceEnforced({
      ...(value === undefined ? {} : { LEGAL_ACCEPTANCE_ENFORCED: value }),
    } as WorkerBindings);

  it("is on only with the exact string true", () => {
    expect(enforced("true")).toBe(true);
  });

  it.each([
    undefined,
    "",
    "false",
    "TRUE",
    "True",
    "1",
    "yes",
    " true",
    "true ",
  ])("is off for %j", (value) => {
    expect(enforced(value)).toBe(false);
  });
});

describe("pending status", () => {
  it("lists both documents, in order, with the version in force, when nothing was accepted", () => {
    expect(pendingLegalAcceptance({})).toEqual([
      { document: "terms", version: 1 },
      { document: "privacy", version: 1 },
    ]);
  });

  it("lists only what is below the floor", () => {
    expect(pendingLegalAcceptance({ terms: 1 })).toEqual([
      { document: "privacy", version: 1 },
    ]);
    expect(pendingLegalAcceptance({ privacy: 1, terms: 1 })).toEqual([]);
  });

  it("shows the date and what changed on the screen status", () => {
    expect(legalAcceptanceStatus({ terms: 1 })).toEqual({
      pending: [
        {
          changes: null,
          document: "privacy",
          effectiveFrom: null,
          version: 1,
        },
      ],
    });
    expect(legalAcceptanceStatus({ privacy: 1, terms: 1 })).toEqual({
      pending: [],
    });
  });
});

describe("marking a request exempt", () => {
  it("marks the request of an exempt procedure by its path", () => {
    const request = new Request("https://polaris.example.invalid/rpc");
    exemptRpcRequest(request, ["account", "legalStatus"]);
    expect(isExemptFromLegalAcceptance(request)).toBe(true);
  });

  it("marks every procedure of the list and leaves any other controlled", () => {
    for (const name of Object.keys(LEGAL_ACCEPTANCE_EXEMPT_PROCEDURES)) {
      const exempt = new Request("https://polaris.example.invalid/rpc");
      exemptRpcRequest(exempt, name.split("."));
      expect(isExemptFromLegalAcceptance(exempt), name).toBe(true);
    }
    for (const path of [
      ["sale", "list"],
      ["sync", "push"],
      ["device", "revoke"],
      ["account"],
      ["constructor"],
      ["toString"],
      [],
    ]) {
      const controlled = new Request("https://polaris.example.invalid/rpc");
      exemptRpcRequest(controlled, path);
      expect(isExemptFromLegalAcceptance(controlled), path.join(".")).toBe(
        false
      );
    }
  });

  it("never takes a header or a query the client sends as the mark", () => {
    const request = new Request(
      "https://polaris.example.invalid/rpc/sale/list?exempt=1",
      { headers: { "x-legal-acceptance-exempt": "true" } }
    );
    expect(isExemptFromLegalAcceptance(request)).toBe(false);
  });
});
